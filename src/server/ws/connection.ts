import { ManagedSession, SessionManager } from '../application/session.js';
import { ConfigService } from '../domain/config/index.js';
import { ClientMessage, ServerMessage, SessionTarget } from '../../shared/protocol.js';
import { dispatch } from './router.js';
import { revealPath } from '../infrastructure/shell/revealPath.js';
import { revealXshell, revealXftp } from '../infrastructure/shell/revealSsh.js';
import { revealVscode } from '../infrastructure/shell/revealVscode.js';
import { revealLocalShell, type LocalShellApp } from '../infrastructure/shell/revealLocalShell.js';
import { detectApps as detectAppsInfra } from '../infrastructure/shell/detectApps.js';
import type { MetricsCollector, MetricsSnapshot } from '../infrastructure/metrics/metricsCollector.js';
import type { SshServerProfile } from '../../shared/protocol.js';

export interface WsLike {
  readyState: number;
  send: (data: string) => void;
  on: (event: string, handler: (...args: any[]) => void) => void;
  close: () => void;
}

/** Per-connection state shared by all handlers. */
export interface WsCtx {
  manager: SessionManager;
  store: ConfigService;
  /** Fallback target when neither preset, override, nor defaults pin a server. */
  defaultTarget: SessionTarget;
  send(msg: ServerMessage): void;
  sendError(error: unknown, code?: string): void;
  subscribe(session: ManagedSession, options: { focus: boolean; history: boolean }): void;
  unsubscribe(id: string): void;
  focusedSession(): ManagedSession | undefined;
  targetSession(id?: string): ManagedSession | undefined;
  /** Open a filesystem path in the OS file browser (shell.reveal handler
   * uses this). Injected so tests can observe calls without spawning a real
   * `explorer.exe`; production wires it to infrastructure/shell/revealPath. */
  reveal(path: string): void;
  /** Hand a remote SSH session (server + cwd) to XShell — generates a
   * one-shot `.xsh` and hands it to the OS. Injected for testability. */
  revealXshell(server: SshServerProfile, cwd: string): void;
  /** Hand a remote SSH session to XFTP — spawns `Xftp.exe -url sftp://…`.
   * Injected for testability. */
  revealXftp(server: SshServerProfile, cwd: string): void;
  /** Launch VS Code at `cwd`. `ssh` is the remote target when the session is
   * SSH-backed (Remote-SSH extension routing); undefined for local. Injected
   * for testability. */
  revealVscode(cwd: string, ssh?: SshServerProfile): void;
  /** Pop a new Windows console at `cwd`. Local sessions only; the admin
   * variants trigger UAC. Injected for testability. */
  revealLocalShell(cwd: string, app: LocalShellApp): void;
  /** Auto-detect XShell / XFTP / VS Code paths on the server-host machine. Used
   * by the Settings dialog's Detect button. Injected so tests can supply a
   * deterministic result without touching the real filesystem. */
  detectApps(): Promise<{ xshellPath: string | null; xftpPath: string | null; vscodePath: string | null }>;
}

interface Subscription {
  session: ManagedSession;
  outputHandler: (data: string) => void;
  stateHandler: (state: string) => void;
  exitHandler: (code: number | null) => void;
  imageFedHandler: (imageIndex: number) => void;
  hookHandler: (kind: string) => void;
}

export interface HandleWsOptions {
  authToken: string;
  defaultTarget: SessionTarget;
  /** Override for the file-browser reveal side-effect. Defaults to the real
   * cross-platform `revealPath`. Tests inject a spy so no real explorer window
   * opens during CI. */
  reveal?: (path: string) => void;
  /** Override for the XShell / XFTP reveal side-effects. Same shape / same
   * reason as `reveal`. In production these are wrapped by the ctx so the
   * real helpers receive appSettings.xshellPath / xftpPath + an onError
   * callback that sends `shell.reveal.error` back to the client. */
  revealXshell?: (server: SshServerProfile, cwd: string) => void;
  revealXftp?: (server: SshServerProfile, cwd: string) => void;
  /** Overrides for VS Code / local-shell reveal side-effects. Same pattern
   * as revealXshell — production wraps them with the appSettings path + an
   * onError bridge; tests inject flat spies. */
  revealVscode?: (cwd: string, ssh?: SshServerProfile) => void;
  revealLocalShell?: (cwd: string, app: LocalShellApp) => void;
  /** Override for the app auto-detect (Settings dialog Detect button). */
  detectApps?: () => Promise<{ xshellPath: string | null; xftpPath: string | null; vscodePath: string | null }>;
  /** Host-resource collector. When present, the connection sends the latest
   * snapshot on auth and subscribes to `snapshot` events for future pushes.
   * Absent → no metrics traffic (topbar pill stays inert). */
  metrics?: MetricsCollector;
}

export function handleWs(ws: WsLike, manager: SessionManager, store: ConfigService, opts: HandleWsOptions) {
  let authenticated = false;
  let focusedSessionId: string | null = null;
  const subscriptions = new Map<string, Subscription>();
  let metricsHandler: ((snap: MetricsSnapshot) => void) | null = null;

  const send = (msg: ServerMessage) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
  const sendError = (error: unknown, code = 'ERROR', sourceType?: string) =>
    send({ type: 'error', code, message: error instanceof Error ? error.message : String(error), sourceType });

  function unsubscribe(id: string) {
    const sub = subscriptions.get(id);
    if (!sub) return;
    sub.session.off('output', sub.outputHandler);
    sub.session.off('state', sub.stateHandler);
    sub.session.off('exit', sub.exitHandler);
    sub.session.off('image.fed', sub.imageFedHandler);
    sub.session.off('hook', sub.hookHandler);
    subscriptions.delete(id);
    if (focusedSessionId === id) focusedSessionId = null;
  }

  function subscribe(session: ManagedSession, options: { focus: boolean; history: boolean }) {
    if (!subscriptions.has(session.id)) {
      const outputHandler = (data: string) => send({ type: 'output', id: session.id, data });
      const stateHandler = (state: string) => send({ type: 'state', id: session.id, state: state as any });
      const exitHandler = (code: number | null) => {
        send({ type: 'session.exit', id: session.id, code });
        unsubscribe(session.id);
      };
      const imageFedHandler = (imageIndex: number) => send({ type: 'image.fed', id: session.id, imageIndex });
      const hookHandler = (kind: string) => send({ type: 'notify.hook', id: session.id, kind });
      session.on('output', outputHandler);
      session.on('state', stateHandler);
      session.on('exit', exitHandler);
      session.on('image.fed', imageFedHandler);
      session.on('hook', hookHandler);
      subscriptions.set(session.id, { session, outputHandler, stateHandler, exitHandler, imageFedHandler, hookHandler });
    }
    if (options.focus) focusedSessionId = session.id;
    send({
      type: 'session.attached',
      session: session.getInfo(),
      ...(options.history ? { snapshot: session.getSnapshot() } : {}),
    });
  }

  const ctx: WsCtx = {
    manager,
    store,
    defaultTarget: opts.defaultTarget,
    send,
    sendError,
    subscribe,
    unsubscribe,
    focusedSession: () => (focusedSessionId ? manager.get(focusedSessionId) : undefined),
    targetSession: (id?: string) => {
      const targetId = id ?? focusedSessionId ?? undefined;
      return targetId ? manager.get(targetId) : undefined;
    },
    reveal: opts.reveal ?? revealPath,
    // Wrap the reveal helpers so the production path is fed the exe paths
    // from appSettings + an onError callback that surfaces failures via the
    // WS protocol. Test injections stay flat 2-arg so specs don't need to
    // model the wiring.
    revealXshell: (server, cwd) => {
      if (opts.revealXshell) return opts.revealXshell(server, cwd);
      const settings = store.getAppSettings();
      revealXshell(server, cwd, {
        exePath: settings.xshellPath,
        onError: (message) => send({ type: 'shell.reveal.error', app: 'xshell', message }),
      });
    },
    revealXftp: (server, cwd) => {
      if (opts.revealXftp) return opts.revealXftp(server, cwd);
      const settings = store.getAppSettings();
      revealXftp(server, cwd, {
        exePath: settings.xftpPath,
        onError: (message) => send({ type: 'shell.reveal.error', app: 'xftp', message }),
      });
    },
    revealVscode: (cwd, ssh) => {
      if (opts.revealVscode) return opts.revealVscode(cwd, ssh);
      const settings = store.getAppSettings();
      revealVscode(cwd, ssh, {
        exePath: settings.vscodePath,
        onError: (message) => send({ type: 'shell.reveal.error', app: 'vscode', message }),
      });
    },
    revealLocalShell: (cwd, app) => {
      if (opts.revealLocalShell) return opts.revealLocalShell(cwd, app);
      revealLocalShell(cwd, app, {
        onError: (message) => send({ type: 'shell.reveal.error', app, message }),
      });
    },
    detectApps: opts.detectApps ?? (() => detectAppsInfra()),
  };

  ws.on('message', (raw: any) => {
    let msg: ClientMessage;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (!authenticated) {
      const ok = msg.type === 'auth' && (!opts.authToken || msg.token === opts.authToken);
      if (ok) {
        authenticated = true;
        send({ type: 'auth.ok' });
        if (opts.metrics) {
          // Prime with the latest cached sample so the pill doesn't stare
          // blank for up to 2s. Might be null on a very-fresh boot; in
          // that case the first tick fires within INTERVAL_MS.
          const latest = opts.metrics.getLatest();
          if (latest) send({ type: 'metrics.snapshot', ...latest });
          metricsHandler = (snap) => send({ type: 'metrics.snapshot', ...snap });
          opts.metrics.on('snapshot', metricsHandler);
        }
      } else {
        send({ type: 'error', message: 'unauthorized', code: 'UNAUTHORIZED' });
        ws.close();
      }
      return;
    }

    try { dispatch(ctx, msg); }
    catch (error) { sendError(error, msg.type.startsWith('config.') ? 'CONFIG_ERROR' : 'ERROR', msg.type); }
  });

  ws.on('close', () => {
    for (const id of [...subscriptions.keys()]) unsubscribe(id);
    if (metricsHandler && opts.metrics) {
      opts.metrics.off('snapshot', metricsHandler);
      metricsHandler = null;
    }
  });
}
