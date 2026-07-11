import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { SessionState, SessionInfo, ResolvedLaunch } from '../../shared/protocol.js';
import { adapterFor, ShellAdapter, EffectiveLaunch } from '../infrastructure/shell/shellAdapter.js';
import { Connector, ConnectorChannel, makeConnector } from '../infrastructure/transport/connector.js';
import { TerminalScreen, snapshotToText } from '../infrastructure/terminal/terminalScreen.js';
import { CliAdapter, TIMING } from '../domain/session/cliAdapter.js';
import { ClaudeCliAdapter } from '../domain/session/ClaudeCliAdapter.js';
import { SessionStateMachine } from '../domain/session/StateMachine.js';
import { McpProvisioner, SessionMcpGrant } from '../infrastructure/mcp/sessionMcpConfig.js';
import { HookProvisioner, SessionHookGrant } from '../infrastructure/hook/hookProvisioner.js';

export interface ConnectorFactory {
  (server: ResolvedLaunch['server']): Connector;
}

export interface ShellFactory {
  (os: ResolvedLaunch['server']['os']): ShellAdapter;
}

/**
 * The single, whitelisted bundle of everything that distinguishes one session
 * from another. Built once in SessionManager.create and owned solely by the
 * ManagedSession — never shared, never written back to any global. Auditing
 * session isolation reduces to "is this one structure ever shared?" rather than
 * enumerating every place state could leak. Holds only session-differentiating
 * *data*; the live machinery (screen/timers/channel) stays private to the
 * session and the OS-inherited base env stays inside `launch.env`.
 */
export interface SessionContext {
  /** Session UUID. Generated before construction so a provisioner can mint a
   * config keyed on it (it's needed to build the command, which the ctor does). */
  id: string;
  /** Fully resolved launch incl. this session's own private env copy. */
  launch: ResolvedLaunch;
  /** MCP grant (config path + injected env) — undefined when MCP is disabled
   * or the target isn't local. The only MCP data the session ever sees. */
  mcp?: SessionMcpGrant;
  /** Hook grant (settings path + optional SSH reverse tunnel) — owned by this session. */
  hook?: SessionHookGrant;
}

export class ManagedSession extends EventEmitter {
  readonly id: string;
  readonly createdAt = Date.now();
  readonly launch: ResolvedLaunch;
  state: SessionState = 'processing';
  private screen: TerminalScreen;
  private lastUserInputAt = 0;
  /** Wall-clock of the most recent screen sample where `cli.looksBusy` matched
   * a busy indicator ("esc to interrupt", "N shells still running", or an
   * ellipsis `…` in cc's mid-turn spinner tail). Used as a grace window on
   * `tryFlipIdle`: even if the *current* sample happens to miss the
   * indicator (spinner mid-repaint, a bulk output frame that pushed the
   * spinner row off the visible viewport, a screen still catching up after
   * a fast-forward), a hit within the last `idleDelayMs` blocks the flip.
   * Zero until the first busy sample lands — a session that never showed a
   * busy indicator is not subject to this gate. */
  private lastLooksBusyAt = 0;
  /** Wall-clock at which the current 'processing' state started. Used as the
   * anchor for the hard-timeout safety net in `tryFlipIdle`: after this much
   * time in 'processing' without any positive idle marker, we let the flip
   * happen even if we've never seen a definitive `Worked for Ns` line —
   * otherwise a cc format change or a wedged session would keep the state
   * frozen at 'processing' forever. Reset on every 'processing' entry. */
  private processingStartedAt = Date.now();
  private idleTimer: NodeJS.Timeout | null = null;
  private channel: ConnectorChannel;
  /** Absolute paths of every image fed into this session, in feed order. The
   * Nth entry (1-based) is what the Nth `[Image #...]` chip the terminal ever
   * showed actually points to. Lifetime-scoped; never trimmed (the cap on
   * concurrent images is naturally bounded by `feed_image` call volume). */
  private readonly imagePaths: string[] = [];
  private cols: number;
  private rows: number;
  private fallbackStarted = false;
  /** True once the resume-fallback has fired for this session's lifetime.
   * Prevents a second fallback from a recovery-pattern string that shows up
   * in ordinary output *after* the rebuilt channel has been running (which
   * would kill the user's live session and start a blank one). */
  private recoveryFallbackConsumed = false;
  /** Wall-clock time of the current channel's spawn. Used to keep
   * detectRecovery scoped to the startup window only — CC's real recovery
   * hints surface within ~1s, later hits are overwhelmingly content. */
  private spawnedAt = 0;
  private effectiveLaunch: EffectiveLaunch;
  private readonly hook?: SessionHookGrant;
  private readonly stateMachine: SessionStateMachine;
  private readonly timing: typeof TIMING;

  constructor(
    ctx: SessionContext,
    private readonly connector: Connector,
    private readonly shell: ShellAdapter,
    private readonly cli: CliAdapter,
    cols = 120,
    rows = 40,
    historySize = 64 * 1024,
    timing = TIMING,
  ) {
    super();
    this.id = ctx.id;
    this.launch = ctx.launch;
    this.cols = cols;
    this.rows = rows;
    this.timing = timing;
    this.hook = ctx.hook;
    // Merge the MCP grant's env into THIS session's private env copy only — the
    // resolved launch env is already a per-session object (launch.ts buildEnv),
    // so CCHUB_SESSION_ID never touches process.env or any other session.
    const env = ctx.mcp ? { ...ctx.launch.env, ...ctx.mcp.env } : ctx.launch.env;
    const mcpConfigPath = ctx.mcp?.configPath;
    const base: EffectiveLaunch = { ...ctx.launch, env, command: [], mcpConfigPath };
    this.effectiveLaunch = { ...base, command: cli.buildCommand({ ...base, mcpConfigPath }) };
    this.stateMachine = new SessionStateMachine(cli, timing);
    this.screen = new TerminalScreen(cols, rows, historySize);
    this.channel = this.startChannel(this.effectiveLaunch);
  }

  write(data: string): void { this.channel.write(data); }

  /** Local host pid of the process carrying this session's I/O (node-pty
   * child for local sessions; undefined for SSH). Metrics collector needs
   * this to attribute CPU/RSS samples to a session. */
  getPid(): number | undefined { return this.channel.getPid(); }

  /** Inject text as a bracketed paste. cchub's image-feed loop relies on
   * this: claude reads a pasted absolute image path from disk and attaches it.
   *
   * `autoSubmit` controls the trailing CR:
   * - `true` (default): send `\r` after `pasteSubmitMs` (strictly OUTSIDE the
   *   `\x1b[201~` end marker so the async disk read lands before submit). This
   *   is the MCP `feed_image` path — the agent triggered the paste and expects
   *   it to be submitted.
   * - `false`: leave the pasted text in cc's prompt for the user to edit or
   *   accompany with more text before pressing Enter themselves. This is the
   *   browser paste-image path — the user hit Ctrl+V, they own the submit. */
  paste(text: string, opts: { autoSubmit?: boolean } = {}): void {
    this.recordUserInput();
    this.channel.write(`\x1b[200~${text}\x1b[201~`);
    if (opts.autoSubmit !== false) {
      setTimeout(() => this.channel.write('\r'), this.timing.pasteSubmitMs);
    }
  }

  /** Log an image's absolute path so the HTTP `/image/:sessionId/:index` route
   * can later resolve a clicked `[Image #...]` chip in the browser back to a
   * file on disk. Called by the feeder strictly before `paste()`. */
  recordImage(imagePath: string): void {
    this.imagePaths.push(imagePath);
    // Emit strictly after the push so the imageIndex we broadcast matches the
    // 1-based slot the HTTP /image/:sessionId/:index route will resolve to.
    // Subscribed WS connections forward this to the client so it can bind the
    // next `[Image #N]` chip the terminal renders to this exact index.
    this.emit('image.fed', this.imagePaths.length);
  }

  /** 1-based lookup: the Nth `[Image #...]` chip in this session's terminal
   * history maps to `getImagePath(N)`. Returns undefined for an out-of-range
   * index (a chip in the buffer that predates a server restart, or an attacker
   * probing for paths). */
  getImagePath(index1Based: number): string | undefined {
    if (!Number.isInteger(index1Based) || index1Based < 1) return undefined;
    return this.imagePaths[index1Based - 1];
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.screen.resize(cols, rows);
    this.channel.resize(cols, rows);
  }
  kill(): void { this.channel.kill(); }

  recordUserInput() { this.lastUserInputAt = Date.now(); }
  emitHook(kind: string): void { this.emit('hook', kind); }
  getSnapshot() { return this.screen.snapshot(); }

  getInfo(): SessionInfo {
    return {
      id: this.id,
      state: this.state,
      cwd: this.launch.cwd,
      createdAt: this.createdAt,
      target: this.launch.server.kind,
      label: this.launch.label,
      serverName: this.launch.serverName,
      profileName: this.launch.profileName,
      presetName: this.launch.presetName,
    };
  }

  private startChannel(launch: EffectiveLaunch): ConnectorChannel {
    const compiled = this.shell.compile(launch);
    const command = this.hook?.setupCommand ? `${this.hook.setupCommand} && ${compiled}` : compiled;
    const channel = this.connector.spawn({ command, cwd: launch.cwd, env: launch.env, cols: this.cols, rows: this.rows, shell: this.shell, proxy: launch.proxy, hookTunnel: this.hook?.hookTunnel });
    this.spawnedAt = Date.now();
    channel.on('data', (data: string) => this.handleData(data));
    channel.on('exit', (code: number | null) => this.handleExit(code));
    return channel;
  }

  private handleData(data: string) {
    this.handleOutput(data);
    if (this.fallbackStarted || this.recoveryFallbackConsumed) return;
    // Scoped to the startup window: CC's real recovery hints (bad --resume,
    // missing history, etc.) surface in stderr within the first ~1s of a
    // channel. Beyond the window, the same string appearing in output is
    // overwhelmingly content — the user pasted a log, cc quoted a file, an
    // editing session touched the pattern's own definition — and matching it
    // would kill the live conversation and respawn a blank one.
    if (Date.now() - this.spawnedAt > this.timing.recoveryWindowMs) return;
    const recovery = this.cli.detectRecovery(data);
    if (!recovery) return;
    if (recovery.kind === 'restart-without-resume') {
      this.fallbackStarted = true;
      this.channel.kill();
    }
  }

  private handleOutput(data: string) {
    this.recordRaw(data);
    this.screen.write(data, () => this.detectStateFromScreen());
    this.emit('output', data);
  }

  private rawRecorderPath: string | null = null;
  private rawRecorderInit = false;
  private recordRaw(data: string) {
    if (!this.rawRecorderInit) {
      this.rawRecorderInit = true;
      const dir = process.env.CCHUB_RECORD_PTY;
      if (dir) {
        try {
          fs.mkdirSync(dir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          this.rawRecorderPath = path.join(dir, `${stamp}-${this.id}.raw`);
        } catch { this.rawRecorderPath = null; }
      }
    }
    if (this.rawRecorderPath) {
      try { fs.appendFileSync(this.rawRecorderPath, data); } catch {}
    }
  }

  private handleExit(code: number | null) {
    if (this.fallbackStarted) {
      this.fallbackStarted = false;
      // One fallback per session lifetime. Even if the rebuilt channel's
      // output eventually contains a recovery-pattern string, we do NOT
      // kill+respawn again — the rebuilt channel is by definition already
      // running without --resume, so a second respawn would just discard
      // whatever conversation the user has since built up.
      this.recoveryFallbackConsumed = true;
      const next = { ...this.effectiveLaunch, resume: undefined };
      this.effectiveLaunch = { ...next, command: this.cli.buildCommand(next) };
      this.channel = this.startChannel(this.effectiveLaunch);
      return;
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.setState('exited', `channel exited (code=${code ?? 'null'})`);
    this.emit('exit', code);
  }

  private setState(state: SessionState, reason?: string) {
    if (state !== this.state) {
      // Log every state flip with the exact reason the state machine gave.
      // A user hit by a spurious notification can grep the server log for
      // their session id and see WHY the state flipped — approval pattern
      // vs busy-guard, idle-timer vs looksBusy readback, etc. Kept as
      // console.error so it survives without a log level flag.
      // eslint-disable-next-line no-console
      console.error(`[notify.state] session=${this.id} ${this.state}→${state} reason="${reason ?? 'unspecified'}"`);
      this.state = state;
      // Anchor the hard-timeout safety net every time we (re-)enter
      // 'processing'. The previous anchor is discarded so a session that
      // idles then re-processes doesn't inherit a long-running clock.
      if (state === 'processing') this.processingStartedAt = Date.now();
      this.emit('state', this.state);
    }
  }

  private detectStateFromScreen() {
    const screenText = this.readScreenText();
    // Any current busy hit refreshes the "recently busy" watermark that
    // tryFlipIdle consults — a single hit within the last idleDelayMs
    // suppresses the flip even if the eventual sample misses. This is what
    // catches the "cc's tool call went quiet for 20s while its status line
    // was mid-repaint" failure mode.
    if (this.cli.looksBusy(screenText)) this.lastLooksBusyAt = Date.now();
    const decision = this.stateMachine.detectStateExplained(screenText, this.state, Date.now() - this.lastUserInputAt);
    if (decision.state) this.setState(decision.state, decision.reason);
    this.armIdleCheck();
  }

  private readScreenText(): string {
    const snapshot = this.screen.snapshot();
    return snapshotToText({ ...snapshot, cursorX: 0, cursorY: 0 }).replace(/\s+$/g, '');
  }

  /** (Re)arm the idle poller. The timer fires after `idleDelayMs` of silence,
   * but the flip to `idle` is gated on the current screen: if the CLI is
   * still telling the user it's busy (a running background shell, an
   * interrupt hint), we re-poll instead of flapping to idle and re-firing a
   * "CC ready" notification client-side. */
  private armIdleCheck(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.tryFlipIdle(), this.stateMachine.idleDelayMs);
  }

  private tryFlipIdle(): void {
    if (!this.stateMachine.shouldSetIdle(this.state)) return;
    const screen = this.readScreenText();
    const now = Date.now();
    const tail = JSON.stringify(screen.slice(-240));

    // Fast-path A — positive "cc finished this turn" marker. cc's per-turn
    // summary line (`✻ Worked for 10s`, `✻ Cogitated for 27s`) is the
    // definitive "turn is done" signal. When we see it we can flip
    // immediately and skip both the busy check and the hard-timeout gate.
    if (this.cli.looksIdle(screen)) {
      // eslint-disable-next-line no-console
      console.error(`[notify.state] session=${this.id} idle-flip via idle-marker tail=${tail}`);
      this.setState('idle', 'idle-marker (per-turn summary)');
      return;
    }

    const busyNow = this.cli.looksBusy(screen);
    // "Recently busy" gate. cc's status line "esc to interrupt" is the reliable
    // busy signal, but it lives on a single row that its TUI rewrites on every
    // frame. A screen sample taken between the row-erase and the row-redraw of
    // the same frame legitimately misses the indicator even though cc is still
    // working — that's the "partial-repaint" failure mode: a long quiet stretch
    // ending in a mid-repaint frame, then the idle-timer fires on that
    // mid-repaint screen and spuriously fires "ready".
    //
    // Threshold is `2 * idleDelayMs` so we need one full quiet window AFTER
    // the last busy sample, not just at-the-boundary equality. At the boundary
    // (msSinceBusy == idleDelayMs) the timer is guaranteed to be firing on
    // the "last output was busy" screen, so the current-busy check already
    // catches it; the extended window catches only the partial-repaint case
    // where the last output happened to miss the indicator.
    const msSinceBusy = this.lastLooksBusyAt > 0 ? now - this.lastLooksBusyAt : Infinity;
    const graceMs = 2 * this.stateMachine.idleDelayMs;
    const busyRecently = msSinceBusy < graceMs;
    const msSinceBusyStr = msSinceBusy === Infinity ? 'never' : String(msSinceBusy);
    if (busyNow || busyRecently) {
      // eslint-disable-next-line no-console
      console.error(`[notify.state] session=${this.id} idle-timer fired but busyNow=${busyNow} msSinceBusy=${msSinceBusyStr} graceMs=${graceMs} — re-arming tail=${tail}`);
      this.armIdleCheck();
      return;
    }

    // No positive idle marker, no busy signal. Under the old logic this
    // was enough to flip — but the failure mode users report is exactly
    // this ambiguous case: cc is between tool calls, has pushed the
    // spinner row off the viewport with a bulk output frame, and hasn't
    // yet redrawn it. There's no visible signal either way. Keep the
    // session in 'processing' until either an idle marker appears (via
    // subsequent detectStateFromScreen) or the hard timeout expires as
    // a safety net.
    const processingDuration = now - this.processingStartedAt;
    const hardTimeoutMs = this.timing.hardIdleTimeoutMs;
    if (processingDuration >= hardTimeoutMs) {
      // eslint-disable-next-line no-console
      console.error(`[notify.state] session=${this.id} idle-flip via hard-timeout after ${processingDuration}ms (no busy or idle marker) tail=${tail}`);
      this.setState('idle', `hard-timeout after ${processingDuration}ms with no signal`);
      return;
    }
    // eslint-disable-next-line no-console
    console.error(`[notify.state] session=${this.id} idle-timer fired but no positive idle marker (processing for ${processingDuration}ms, hardTimeout=${hardTimeoutMs}) — re-arming tail=${tail}`);
    this.armIdleCheck();
  }
}

export interface SessionManagerDeps {
  connectorFor: ConnectorFactory;
  shellFor: ShellFactory;
  cliAdapter: CliAdapter;
  /** Scrollback line count for each session's TerminalScreen (default 64 KB lines). */
  historySize: number;
  /** Session timing (input-silence / idle delays). Injectable so tests can shrink the idle window. */
  timing: typeof TIMING;
  /** Provisions a per-session MCP config + env. Absent → sessions get no MCP grant
   * (feature disabled). Only consumed for local targets; SSH would need the temp
   * config shipped to the remote host, which is not currently supported. */
  mcpProvisioner?: McpProvisioner;
  /** Provisions per-session Claude Code hooks on the target host. */
  hookProvisioner?: HookProvisioner;
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private readonly connectorFor: ConnectorFactory;
  private readonly shellFor: ShellFactory;
  private readonly cliAdapter: CliAdapter;
  private readonly historySize: number;
  private readonly timing: typeof TIMING;
  private readonly mcpProvisioner?: McpProvisioner;
  private readonly hookProvisioner?: HookProvisioner;

  constructor(deps: Partial<SessionManagerDeps> = {}) {
    this.connectorFor = deps.connectorFor ?? makeConnector;
    this.shellFor = deps.shellFor ?? adapterFor;
    this.cliAdapter = deps.cliAdapter ?? new ClaudeCliAdapter();
    this.historySize = deps.historySize ?? 64 * 1024;
    this.timing = deps.timing ?? TIMING;
    this.mcpProvisioner = deps.mcpProvisioner;
    this.hookProvisioner = deps.hookProvisioner;
  }

  create(launch: ResolvedLaunch, cols?: number, rows?: number): ManagedSession {
    const connector = this.connectorFor(launch.server);
    const shell = this.shellFor(launch.server.os);
    // id is minted here (not in the ctor) so the provisioner can key a config
    // file on it before the ctor builds the command that references that file.
    const id = randomUUID();
    const mcp = launch.server.kind === 'local' ? this.mcpProvisioner?.provision(id) : undefined;
    const hook = this.hookProvisioner?.provision(id, launch);
    const ctx: SessionContext = { id, launch, mcp, hook };
    const session = new ManagedSession(ctx, connector, shell, this.cliAdapter, cols, rows, this.historySize, this.timing);
    // Clean up the temp config only on a real, final exit. handleExit emits
    // 'exit' solely on its non-fallback branch, so a resume-fallback respawn
    // (which reuses the same id + file) never triggers cleanup.
    if (mcp && this.mcpProvisioner) {
      session.once('exit', () => this.mcpProvisioner!.cleanup(id));
    }
    if (hook && this.hookProvisioner) {
      session.once('exit', () => this.hookProvisioner!.cleanup(id));
    }
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): ManagedSession | undefined { return this.sessions.get(id); }
  list(): SessionInfo[] { return [...this.sessions.values()].map(s => s.getInfo()); }
  /** Snapshot of every live session's identity + local pid at this moment.
   * Consumed by the metrics collector to build a per-session CPU/RSS report.
   * `pid` is undefined for SSH sessions (the cc CLI runs on the remote host,
   * invisible locally) and those entries are surfaced to the client with
   * `pid: null` so the widget renders "N/A".
   *
   * We expose BOTH `label` (`server:cwd` — the raw location) and
   * `presetName` (the launch's chosen name) so the metrics wire can prefer
   * a human-friendly preset name in the primary slot and keep the path as
   * a subordinate tooltip. Splitting the responsibility here — instead of
   * pre-flattening to a single "display name" — lets the metrics layer
   * decide the fallback rule without re-implementing SessionInfo lookup. */
  snapshotPids(): { id: string; label: string; presetName?: string; pid: number | undefined }[] {
    return [...this.sessions.values()].map(s => {
      const info = s.getInfo();
      return { id: s.id, label: info.label, presetName: info.presetName, pid: s.getPid() };
    });
  }
  /** Move a session to a new slot in the Map's insertion order — which is
   * what `list()` iterates and what the client re-hydrates from on a page
   * refresh. Mirrors Store.reorderSession on the client: `toIndex` is the
   * position AFTER removing the source, so `[a,b,c].reorder('a', 1)` yields
   * `[b,a,c]`. Silently no-ops on an unknown id or same-position moves;
   * clamps a too-large toIndex to the last slot. */
  reorder(fromId: string, toIndex: number): void {
    const entries = [...this.sessions.entries()];
    const fromIndex = entries.findIndex(([id]) => id === fromId);
    if (fromIndex < 0) return;
    const clamped = Math.max(0, Math.min(entries.length - 1, toIndex));
    if (clamped === fromIndex) return;
    const [entry] = entries.splice(fromIndex, 1);
    entries.splice(clamped, 0, entry!);
    this.sessions = new Map(entries);
  }
  destroy(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.kill();
    this.sessions.delete(id);
    return true;
  }
  destroyAll() {
    for (const s of this.sessions.values()) s.kill();
    this.sessions.clear();
  }
}
