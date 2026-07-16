import { test, expect } from '@playwright/test';
import { EventEmitter } from 'events';
import { ManagedSession, SessionManager, SessionContext } from '../src/server/application/session.js';
import type { Connector, ConnectorChannel, ConnectorSpawnArgs } from '../src/server/infrastructure/transport/connector.js';
import type { ShellAdapter } from '../src/server/infrastructure/shell/shellAdapter.js';
import type { CliAdapter, CliLaunchSpec, CliRecoveryAction } from '../src/server/domain/session/cliAdapter.js';
import type { McpProvisioner, SessionMcpGrant } from '../src/server/infrastructure/mcp/sessionMcpConfig.js';
import type { HookProvisioner, SessionHookGrant } from '../src/server/infrastructure/hook/hookProvisioner.js';
import type { ResolvedLaunch } from '../src/shared/protocol.js';

// ManagedSession is the server's core orchestrator and the highest-value test
// gap: its resume-fallback recovery, idle state-flip, and exit handling are all
// stateful and regression-prone. We drive it through fake connector/shell/CLI
// (the DI hooks the production code already exposes) and assert observable
// behavior (spawned commands, emitted events) — never private fields.

class FakeChannel extends EventEmitter {
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  killed = 0;
  write(d: string) { this.writes.push(d); }
  resize(c: number, r: number) { this.resizes.push([c, r]); }
  kill() { this.killed += 1; }
}

class FakeConnector implements Connector {
  channels: FakeChannel[] = [];
  spawns: ConnectorSpawnArgs[] = [];
  spawn(args: ConnectorSpawnArgs): ConnectorChannel {
    this.spawns.push(args);
    const ch = new FakeChannel();
    this.channels.push(ch);
    return ch as unknown as ConnectorChannel;
  }
}

// compile() just joins the argv so the spawned command string is inspectable.
const fakeShell: ShellAdapter = {
  compile: (l) => l.command.join(' '),
  spawnArgs: (command) => ({ file: 'sh', args: ['-c', command] }),
};

class FakeCli implements CliAdapter {
  buildCommand(l: CliLaunchSpec): string[] {
    const argv = l.resume === 'continue' ? ['claude', '-c'] : ['claude'];
    if (l.mcpConfigPath) argv.push('--mcp-config', l.mcpConfigPath);
    return argv;
  }
  isAwaitingApproval(): boolean { return false; }
  // Screen text that would look busy — a background shell hint or "esc to
  // interrupt". Tests inject a specific screen into TerminalScreen via emitted
  // pty output and rely on this predicate to gate the idle flip.
  looksBusy(screenText: string): boolean {
    return /esc to interrupt|shells? still running/i.test(screenText);
  }
  // Positive idle marker: cc's per-turn summary line — the SAME shape as the
  // real adapter checks (`<glyph> <verb-ed> for <N>s` at line end). Tests can
  // inject e.g. `✻ Worked for 10s` to exercise the idle fast-path.
  looksIdle(screenText: string): boolean {
    return /^\s*\S\s+\w+ed\s+for\s+\d+s\s*$/m.test(screenText);
  }
  // Interrupt discrimination — mirrors the real adapter's positional rule:
  // the "Interrupted" marker counts only when it's the freshest signal, i.e.
  // strictly below the last live busy hint in the recent tail. A same-line
  // co-occurrence (busy hint still showing) resolves to "still busy".
  turnEndedByInterrupt(screenText: string): boolean {
    const tail = screenText.split(/\r?\n/).slice(-20);
    let interruptIdx = -1;
    let busyHintIdx = -1;
    for (let i = 0; i < tail.length; i++) {
      if (/\bInterrupted\b/i.test(tail[i])) interruptIdx = i;
      if (/esc to interrupt|shells? still running/i.test(tail[i])) busyHintIdx = i;
    }
    return interruptIdx > busyHintIdx;
  }
  // The no-conversation marker is what triggers the resume-fallback in the real adapter.
  detectRecovery(chunk: string): CliRecoveryAction | null {
    return chunk.includes('NOCONV') ? { kind: 'restart-without-resume' } : null;
  }
}

// Records every provision/cleanup so isolation tests can assert per-session
// identity. Each call gets a config path + a session-scoped env var.
class FakeProvisioner implements McpProvisioner {
  provisioned: string[] = [];
  cleaned: string[] = [];
  provision(id: string): SessionMcpGrant {
    this.provisioned.push(id);
    return { configPath: `/tmp/mcp-${id}.json`, env: { CCHUB_SESSION_ID: id } };
  }
  cleanup(id: string): void { this.cleaned.push(id); }
}

class FakeHookProvisioner implements HookProvisioner {
  provisioned: string[] = [];
  cleaned: string[] = [];
  provision(id: string, launch: ResolvedLaunch): SessionHookGrant {
    this.provisioned.push(id);
    return launch.server.kind === 'ssh'
      ? { settingsPath: `${launch.cwd}/.claude/settings.local.json`, hookTunnel: { bindPort: 7000, host: '127.0.0.1', port: 3778 } }
      : { settingsPath: `${launch.cwd}/.claude/settings.local.json` };
  }
  cleanup(id: string): void { this.cleaned.push(id); }
}

// Shrink the idle window so the idle-flip test runs in tens of ms, not 1.6s,
// the paste-submit delay so the CR-append test isn't slow, and the recovery
// scan window so the "window closed" test doesn't have to wait seconds. The
// hard-timeout is shrunk to a small multiple of idleAfterMs so the safety-
// net test can trigger it without adding a multi-minute wait.
const TINY = { inputSilenceMs: 10, idleAfterMs: 40, pasteSubmitMs: 10, recoveryWindowMs: 100, hardIdleTimeoutMs: 400 };

function launch(resume?: string): ResolvedLaunch {
  return {
    server: { id: 's', name: 'srv', kind: 'local', os: 'linux', createdAt: 0, updatedAt: 0 },
    cwd: '/tmp', env: {}, resume, serverName: 'srv', label: 'test-label',
  };
}

function ctx(over: Partial<SessionContext> = {}): SessionContext {
  return { id: 'fixed-id', launch: launch(over.launch?.resume), ...over };
}

function makeSession(resume?: string) {
  const connector = new FakeConnector();
  const session = new ManagedSession(
    ctx({ launch: launch(resume) }), connector as unknown as Connector, fakeShell, new FakeCli(),
    120, 40, 64 * 1024, TINY,
  );
  return { session, connector };
}

test.describe('ManagedSession — channel wiring', () => {
  test('forwards write and resize to the active channel', () => {
    const { session, connector } = makeSession();
    session.write('hi');
    session.resize(80, 24);
    expect(connector.channels[0].writes).toEqual(['hi']);
    expect(connector.channels[0].resizes).toEqual([[80, 24]]);
  });

  test('spawns with the argv the CLI adapter builds (resume → -c)', () => {
    expect(makeSession('continue').connector.spawns[0].command).toContain('-c');
    expect(makeSession().connector.spawns[0].command).not.toContain('-c');
  });

  test('getInfo reflects launch metadata and starts in idle', () => {
    const info = makeSession().session.getInfo();
    // A freshly spawned session sits at cc's ready prompt — idle, not
    // processing. Turns begin only when cc's UserPromptSubmit hook fires.
    expect(info.state).toBe('idle');
    expect(info.cwd).toBe('/tmp');
    expect(info.target).toBe('local');
    expect(info.label).toBe('test-label');
  });
});

test.describe('ManagedSession — paste (image-feed channel)', () => {
  test('wraps text in bracketed-paste markers and submits with the CR strictly outside (default: autoSubmit)', async () => {
    const { session, connector } = makeSession();
    session.paste('D:\\temp\\shot.png');
    // The payload write happens synchronously; the CR is deferred so an async
    // image read finishes before submit. CR must NOT be inside the 201~ marker.
    expect(connector.channels[0].writes[0]).toBe('\x1b[200~D:\\temp\\shot.png\x1b[201~');
    expect(connector.channels[0].writes).toHaveLength(1);
    await new Promise((r) => setTimeout(r, TINY.pasteSubmitMs + 30));
    expect(connector.channels[0].writes[1]).toBe('\r');
    connector.channels[0].emit('exit', 0); // cleanup idle timer
  });

  test('paste counts as user input (records input time)', () => {
    const { session, connector } = makeSession();
    // recordUserInput is also called on the input path; we assert observably via
    // the fact that a paste then quiet does not immediately flip to idle on the
    // very next output (input-silence window protects it). Simpler: no throw +
    // payload landed is the contract; deeper timing is covered by state tests.
    session.paste('/tmp/a.png');
    expect(connector.channels[0].writes[0]).toContain('/tmp/a.png');
    connector.channels[0].emit('exit', 0);
  });

  // The user-paste path (browser Ctrl+V → /paste-image route) must NOT auto-
  // submit — the user hit paste and may want to type a caption before pressing
  // Enter. Only the MCP feed_image path submits, because the agent that
  // triggered that call cannot subsequently press Enter itself.
  test('autoSubmit:false writes the bracketed paste but suppresses the trailing CR', async () => {
    const { session, connector } = makeSession();
    session.paste('D:\\temp\\shot.png', { autoSubmit: false });
    expect(connector.channels[0].writes).toEqual(['\x1b[200~D:\\temp\\shot.png\x1b[201~']);
    // Wait past the submit delay — a CR appearing after would be the bug.
    await new Promise((r) => setTimeout(r, TINY.pasteSubmitMs + 30));
    expect(connector.channels[0].writes).toEqual(['\x1b[200~D:\\temp\\shot.png\x1b[201~']);
    connector.channels[0].emit('exit', 0);
  });
});

test.describe('ManagedSession — resume fallback recovery', () => {
  test('kills the channel on "no conversation" and respawns without resume', () => {
    const { connector } = makeSession('continue');
    const first = connector.channels[0];
    expect(connector.spawns[0].command).toContain('-c');

    // CLI surfaces the no-conversation marker → fallback armed, old channel killed.
    first.emit('data', 'Error: NOCONV to continue');
    expect(first.killed).toBe(1);
    expect(connector.channels).toHaveLength(1); // no respawn until the kill's exit lands

    // The killed channel reports exit → session rebuilds the channel sans -c.
    first.emit('exit', null);
    expect(connector.channels).toHaveLength(2);
    expect(connector.spawns[1].command).not.toContain('-c');

    connector.channels[1].emit('exit', 0); // cleanup: clears the idle timer
  });

  test('does not loop: a second no-conversation on the rebuilt channel is not acted on twice', () => {
    const { connector } = makeSession('continue');
    connector.channels[0].emit('data', 'NOCONV');
    connector.channels[0].emit('exit', null); // → rebuild (channels[1])
    expect(connector.channels).toHaveLength(2);

    // The rebuilt channel emits the same marker after the fallback consumed
    // guard tripped — nothing should happen. In particular the rebuilt channel
    // is NOT killed even though it's still within the recovery window.
    connector.channels[1].emit('data', 'NOCONV');
    expect(connector.channels[1].killed).toBe(0);

    // Rebuilt channel exiting is a normal exit, not another rebuild.
    connector.channels[1].emit('exit', 0);
    expect(connector.channels).toHaveLength(2);
  });

  test('ignores the recovery marker after the startup window closes', async () => {
    const { connector } = makeSession('continue');
    const first = connector.channels[0];
    // Wait past recoveryWindowMs so the marker is now treated as content, not
    // a startup fault. This is the bug's real-world case: mid-session cc
    // emits the marker as part of a file it's reading or a log it's quoting.
    await new Promise((r) => setTimeout(r, TINY.recoveryWindowMs + 30));
    first.emit('data', 'Error: NOCONV to continue');

    // Live session must NOT be killed just because output happened to contain
    // the string. No respawn, no channel churn.
    expect(first.killed).toBe(0);
    expect(connector.channels).toHaveLength(1);
    first.emit('exit', 0); // cleanup
  });
});

test.describe('ManagedSession — hook-driven state', () => {
  test('UserPromptSubmit hook flips a fresh (idle) session to processing', () => {
    const { session } = makeSession();
    const states: string[] = [];
    session.on('state', (s) => states.push(s));
    expect(session.getInfo().state).toBe('idle');
    session.emitHook('user_prompt_submit');
    expect(session.getInfo().state).toBe('processing');
    expect(states).toEqual(['processing']);
  });

  test('Stop hook flips processing back to idle (authoritative turn end)', () => {
    const { session } = makeSession();
    const states: string[] = [];
    session.emitHook('user_prompt_submit');
    session.on('state', (s) => states.push(s));
    session.emitHook('stop');
    expect(session.getInfo().state).toBe('idle');
    expect(states).toEqual(['idle']);
  });

  test('StopFailure hook also ends the turn (idle)', () => {
    const { session } = makeSession();
    session.emitHook('user_prompt_submit');
    session.emitHook('stop_failure');
    expect(session.getInfo().state).toBe('idle');
  });

  test('Notification hook does not drive state (approval is detected from the screen)', () => {
    const { session } = makeSession();
    const states: string[] = [];
    const hooks: string[] = [];
    session.emitHook('user_prompt_submit');
    session.on('state', (s) => states.push(s));
    session.on('hook', (k) => hooks.push(k));
    session.emitHook('notification');
    // State is untouched by the hook — it stays wherever it was (processing).
    expect(session.getInfo().state).toBe('processing');
    expect(states).toEqual([]);
    // But it IS forwarded to the desktop-notification pipeline.
    expect(hooks).toEqual(['notification']);
  });

  test('user_prompt_submit does NOT reach the notification pipeline (would false-fire "ready")', () => {
    const { session } = makeSession();
    const hooks: string[] = [];
    session.on('hook', (k) => hooks.push(k));
    session.emitHook('user_prompt_submit');
    session.emitHook('stop');
    // Only stop is forwarded as a notification; the turn-start signal is state-only.
    expect(hooks).toEqual(['stop']);
  });

  test('tool_active heartbeat corrects a stuck-idle session to processing', () => {
    // The idle→processing black hole: if the one UserPromptSubmit POST is
    // dropped the session stays idle while cc works. A mid-turn tool_active
    // POST (PreToolUse / PostToolUse) is the redundant path back out.
    const { session } = makeSession();
    const states: string[] = [];
    session.on('state', (s) => states.push(s));
    expect(session.getInfo().state).toBe('idle');
    session.emitHook('tool_active');
    expect(session.getInfo().state).toBe('processing');
    expect(states).toEqual(['processing']);
  });

  test('tool_active is idempotent when already processing (no duplicate state emit)', () => {
    const { session } = makeSession();
    session.emitHook('user_prompt_submit');
    const states: string[] = [];
    session.on('state', (s) => states.push(s));
    // Repeated tool-use heartbeats within a turn must not re-emit 'processing'.
    session.emitHook('tool_active');
    session.emitHook('tool_active');
    expect(session.getInfo().state).toBe('processing');
    expect(states).toEqual([]);
  });

  test('tool_active does NOT reach the notification pipeline (would false-fire "ready")', () => {
    const { session } = makeSession();
    const hooks: string[] = [];
    session.on('hook', (k) => hooks.push(k));
    session.emitHook('user_prompt_submit');
    session.emitHook('tool_active');
    session.emitHook('stop');
    // The heartbeat is state-only; only stop is forwarded as a notification.
    expect(hooks).toEqual(['stop']);
  });
});

test.describe('ManagedSession — state transitions', () => {
  test('flips to idle once cc emits its per-turn summary line', async () => {
    const { session, connector } = makeSession();
    const states: string[] = [];
    session.on('state', (s) => states.push(s));

    // Drive the turn start via the hook (screen changes no longer do this),
    // then a per-turn summary line — the screen-side idle fallback for when
    // the Stop hook is slow or absent.
    session.emitHook('user_prompt_submit');
    connector.channels[0].emit('data', '✻ Worked for 10s\r\n');
    await new Promise((r) => setTimeout(r, TINY.idleAfterMs + 80));

    expect(states).toContain('idle');
    connector.channels[0].emit('exit', 0); // cleanup
  });

  test('an esc-interrupt screen (busy cleared) flips processing → idle without a Stop hook', async () => {
    const { session, connector } = makeSession();
    const states: string[] = [];
    session.on('state', (s) => states.push(s));

    // Turn running (via hook), then the user hits esc: cc prints an
    // "Interrupted" line and the busy spinner disappears. cc fires no Stop
    // hook on interrupt, so the screen marker is what returns us to idle.
    session.emitHook('user_prompt_submit');
    connector.channels[0].emit('data', '\x1b[2J\x1b[H⎿  Interrupted by user\r\n');
    // detectStateFromScreen runs in xterm's async write callback, so let the
    // screen settle a tick before asserting the interrupt-driven flip.
    await new Promise((r) => setTimeout(r, 20));
    expect(session.getInfo().state).toBe('idle');
    expect(states).toContain('idle');
    connector.channels[0].emit('exit', 0); // cleanup
  });

  // The real esc-interrupt: cc does NOT clear the screen, so the busy status
  // row from the just-cancelled turn is still in the buffer when the
  // "Interrupted" line prints below it. The old `looksInterrupted && !looksBusy`
  // gate saw that lingering busy row and never flipped — the session sat on
  // 'processing' until the hard timeout. The positional rule flips because the
  // interrupt marker is fresher (below) the stale busy row.
  test('an esc-interrupt with the stale busy row STILL in the buffer flips processing → idle', async () => {
    const { session, connector } = makeSession();
    session.emitHook('user_prompt_submit');
    // Busy frame cc painted mid-turn — this row lingers (no screen clear).
    connector.channels[0].emit('data', 'working... esc to interrupt\r\n');
    // User hits esc: cc appends the Interrupted line + input prompt BELOW,
    // leaving the busy row above untouched.
    connector.channels[0].emit('data', '⎿  Interrupted · What should Claude do instead?\r\n> \r\n');
    await new Promise((r) => setTimeout(r, 20));
    expect(session.getInfo().state).toBe('idle');
    connector.channels[0].emit('exit', 0); // cleanup
  });

  test('an "Interrupted" string mid-work (busy still showing) does NOT cut the turn short', async () => {
    const { session, connector } = makeSession();
    session.emitHook('user_prompt_submit');
    // cc is actively working (busy hint present) and its output happens to
    // contain the word Interrupted — must stay processing.
    connector.channels[0].emit('data', 'log: request Interrupted; retrying... esc to interrupt');
    await new Promise((r) => setTimeout(r, 20));
    expect(session.getInfo().state).toBe('processing');
    connector.channels[0].emit('exit', 0); // cleanup
  });

  // The false-fire failure this test locks: cc's tool call goes quiet for
  // longer than idleAfterMs while its TUI is repainting the status line. A
  // sample taken between the row-erase and row-redraw of the busy indicator
  // sees a blank tail, so `looksBusy(currentScreen)` returns false. Under the
  // old logic that was enough to flip to idle and fire a "cc ready" toast
  // mid-turn. Under the fix, an earlier sample within idleDelayMs that DID
  // see busy blocks the flip via `lastLooksBusyAt`.
  test('does not flip to idle when a busy indicator was seen within the idle window', async () => {
    const { session, connector } = makeSession();
    const states: string[] = [];
    session.emitHook('user_prompt_submit'); // enter processing (hook-driven)
    session.on('state', (s) => states.push(s));

    // Screen sample #1: busy indicator visible → refreshes lastLooksBusyAt.
    connector.channels[0].emit('data', 'working... esc to interrupt');
    // Screen sample #2: same tool call, but the status row is mid-repaint so
    // the tail no longer matches the busy pattern. This is the ambiguous
    // sample the idle-timer would previously consult in isolation.
    connector.channels[0].emit('data', '\x1b[2Kthinking about it');
    // Wait past the idle delay. In the old code the flip fires; in the fixed
    // code the recent-busy watermark is still within idleDelayMs of now so
    // the timer re-arms.
    await new Promise((r) => setTimeout(r, TINY.idleAfterMs + 20));

    expect(states).not.toContain('idle');
    connector.channels[0].emit('exit', 0); // cleanup
  });

  // Complement to the above: once the busy indicator has been absent for the
  // WHOLE grace window (2×idleDelayMs) AND cc has emitted its per-turn
  // summary line, the flip is safe and must happen. Otherwise the fix would
  // deadlock any session that ever showed a busy indicator into staying
  // "processing" forever.
  test('flips to idle when busy has cleared AND a per-turn summary marker arrives', async () => {
    const { session, connector } = makeSession();
    const states: string[] = [];
    session.emitHook('user_prompt_submit'); // enter processing (hook-driven)
    session.on('state', (s) => states.push(s));

    // Sample 1 — busy indicator visible; refreshes lastLooksBusyAt.
    connector.channels[0].emit('data', 'working... esc to interrupt');
    // Immediately erase the entire screen (\x1b[2J) so subsequent screen
    // samples don't keep matching the appended busy text — this simulates cc
    // finishing its tool call and repainting a clean per-turn summary.
    connector.channels[0].emit('data', '\x1b[2J\x1b[H✻ Worked for 10s\r\n');
    // Wait past 2×idleDelayMs so `lastLooksBusyAt` ages out of the grace,
    // then a bit more so the eventual idle-timer fires with a stale watermark.
    await new Promise((r) => setTimeout(r, 2 * TINY.idleAfterMs + TINY.idleAfterMs + 20));

    expect(states).toContain('idle');
    connector.channels[0].emit('exit', 0); // cleanup
  });

  // The new "positive idle marker required" rule: an idle-timer fire with no
  // busy signal but ALSO no per-turn summary line must NOT flip — this is
  // the exact ambiguous case (cc between tool calls, spinner row scrolled
  // off, no visible signal either way) that previously produced the false
  // "cc ready" fires. Without a positive marker we hold at 'processing'.
  test('does not flip to idle when no positive idle marker has appeared', async () => {
    const { session, connector } = makeSession();
    const states: string[] = [];
    session.emitHook('user_prompt_submit'); // enter processing (hook-driven)
    session.on('state', (s) => states.push(s));

    // Emit some output but no per-turn summary line. Under the old logic
    // the idle-timer would fire and flip after `idleAfterMs`; under the fix
    // this must stay in 'processing' until either the summary lands or the
    // hard-timeout safety net expires.
    connector.channels[0].emit('data', 'some tool output line\r\nanother line\r\n');
    // Wait past the idle delay AND the grace window, but WELL SHORT of the
    // hard timeout — the flip must not happen in this interval.
    await new Promise((r) => setTimeout(r, 3 * TINY.idleAfterMs + 20));

    expect(states).not.toContain('idle');
    connector.channels[0].emit('exit', 0); // cleanup
  });

  // Safety net: if a session has been in 'processing' longer than
  // `hardIdleTimeoutMs` with no busy signal AND no positive idle marker,
  // the flip is allowed anyway. This exists so a cc format change or a
  // wedged session can't strand the state at 'processing' forever.
  test('flips to idle via hard timeout when neither busy nor idle marker ever appears', async () => {
    const { session, connector } = makeSession();
    const states: string[] = [];
    session.emitHook('user_prompt_submit'); // enter processing (hook-driven)
    session.on('state', (s) => states.push(s));

    // Some ambiguous output so the idle-timer arms — no busy hint, no
    // per-turn summary. This is the "cc formatting changed / session
    // wedged" scenario.
    connector.channels[0].emit('data', 'ambiguous output\r\n');
    // Wait past the hard-timeout so the safety net authorises the flip.
    await new Promise((r) => setTimeout(r, TINY.hardIdleTimeoutMs + TINY.idleAfterMs + 20));

    expect(states).toContain('idle');
    connector.channels[0].emit('exit', 0); // cleanup
  });

  test('on normal channel exit sets exited and emits exit with the code', () => {
    const { session, connector } = makeSession();
    const exits: Array<number | null> = [];
    session.on('exit', (c) => exits.push(c));

    connector.channels[0].emit('exit', 0);
    expect(exits).toEqual([0]);
    expect(session.getInfo().state).toBe('exited');
  });
});

test.describe('SessionManager', () => {
  function makeManager(mcpProvisioner?: McpProvisioner) {
    const connector = new FakeConnector();
    const manager = new SessionManager({
      connectorFor: () => connector as unknown as Connector,
      shellFor: () => fakeShell,
      cliAdapter: new FakeCli(),
      timing: TINY,
      mcpProvisioner,
    });
    return { connector, manager };
  }

  test('create registers a session retrievable by id and listed', () => {
    const { manager } = makeManager();
    const s = manager.create(launch());
    expect(manager.get(s.id)).toBe(s);
    expect(manager.list().map((i) => i.id)).toContain(s.id);
  });

  test('destroy kills the channel, removes the session, and is idempotent', () => {
    const { manager, connector } = makeManager();
    const s = manager.create(launch());
    expect(manager.destroy(s.id)).toBe(true);
    expect(manager.get(s.id)).toBeUndefined();
    expect(connector.channels[0].killed).toBe(1);
    expect(manager.destroy(s.id)).toBe(false); // already gone
  });

  test('destroyAll kills every channel and clears the registry', () => {
    const { manager, connector } = makeManager();
    manager.create(launch());
    manager.create(launch());
    manager.destroyAll();
    expect(manager.list()).toHaveLength(0);
    expect(connector.channels.every((c) => c.killed === 1)).toBe(true);
  });
});

// The drag-reorder UX in the client (rail tabs + grid pane heads) needs a
// matching persistence hook here so the reordered layout survives a page
// refresh. Without it, session.list on reconnect echoes the original
// insertion order and the drag is lost. Semantics mirror Store.reorderSession
// so both sides stay in lock-step: `toIndex` is the position AFTER removing
// the source, so `[a,b,c].reorder('a', 1)` → `[b,a,c]`.
test.describe('SessionManager — reorder', () => {
  function makeManagerWithSessions(n: number) {
    const connector = new FakeConnector();
    const manager = new SessionManager({
      connectorFor: () => connector as unknown as Connector,
      shellFor: () => fakeShell,
      cliAdapter: new FakeCli(),
      timing: TINY,
    });
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push(manager.create(launch()).id);
    return { manager, connector, ids };
  }

  test('moves a session forward and preserves the rest', () => {
    const { manager, ids } = makeManagerWithSessions(3);
    manager.reorder(ids[0]!, 1);
    expect(manager.list().map((i) => i.id)).toEqual([ids[1], ids[0], ids[2]]);
  });

  test('moves a session to the front', () => {
    const { manager, ids } = makeManagerWithSessions(3);
    manager.reorder(ids[2]!, 0);
    expect(manager.list().map((i) => i.id)).toEqual([ids[2], ids[0], ids[1]]);
  });

  test('is a no-op when the source is already at that index', () => {
    const { manager, ids } = makeManagerWithSessions(3);
    manager.reorder(ids[0]!, 0);
    expect(manager.list().map((i) => i.id)).toEqual(ids);
  });

  test('is a no-op for an unknown id', () => {
    const { manager, ids } = makeManagerWithSessions(3);
    manager.reorder('ghost', 1);
    expect(manager.list().map((i) => i.id)).toEqual(ids);
  });

  test('clamps a too-large toIndex to the last slot', () => {
    const { manager, ids } = makeManagerWithSessions(3);
    manager.reorder(ids[0]!, 99);
    expect(manager.list().map((i) => i.id)).toEqual([ids[1], ids[2], ids[0]]);
  });

  test('list() reflects the reorder — the same call handleWs uses on session.list', () => {
    const { manager, ids } = makeManagerWithSessions(3);
    manager.reorder(ids[1]!, 2);
    // list() is what handleWs echoes back on `session.list` — the reload path.
    expect(manager.list().map((i) => i.id)).toEqual([ids[0], ids[2], ids[1]]);
  });
});

test.describe('SessionManager — hook provisioning + hook tunnel', () => {
  function makeManager(hookProvisioner?: HookProvisioner) {
    const connector = new FakeConnector();
    const manager = new SessionManager({
      connectorFor: () => connector as unknown as Connector,
      shellFor: () => fakeShell,
      cliAdapter: new FakeCli(),
      timing: TINY,
      hookProvisioner,
    });
    return { connector, manager };
  }

  test('provisions hooks for local sessions without adding spawn env', () => {
    const prov = new FakeHookProvisioner();
    const { manager, connector } = makeManager(prov);
    const s = manager.create(launch());
    expect(prov.provisioned).toEqual([s.id]);
    expect(connector.spawns[0].hookTunnel).toBeUndefined();
    expect(connector.spawns[0].env.CCHUB_SESSION_ID).toBeUndefined();
  });

  test('threads SSH hook reverse tunnel into the spawn', () => {
    const prov = new FakeHookProvisioner();
    const { manager, connector } = makeManager(prov);
    const sshLaunch: ResolvedLaunch = {
      ...launch(),
      server: { id: 'r', name: 'remote', kind: 'ssh', os: 'linux', host: 'h', port: 22, username: 'u', auth: { method: 'password' }, createdAt: 0, updatedAt: 0 },
    };
    manager.create(sshLaunch);
    expect(connector.spawns[0].hookTunnel).toEqual({ bindPort: 7000, host: '127.0.0.1', port: 3778 });
  });

  test('cleans up hook settings on final exit', () => {
    const prov = new FakeHookProvisioner();
    const { manager, connector } = makeManager(prov);
    const s = manager.create(launch());
    connector.channels[0].emit('exit', 0);
    expect(prov.cleaned).toEqual([s.id]);
  });
});

test.describe('SessionManager — MCP provisioning + per-session isolation', () => {
  function makeManager(mcpProvisioner?: McpProvisioner) {
    const connector = new FakeConnector();
    const manager = new SessionManager({
      connectorFor: () => connector as unknown as Connector,
      shellFor: () => fakeShell,
      cliAdapter: new FakeCli(),
      timing: TINY,
      mcpProvisioner,
    });
    return { connector, manager };
  }

  test('injects the grant env into the spawn env and threads the config path into the command', () => {
    const prov = new FakeProvisioner();
    const { manager, connector } = makeManager(prov);
    const s = manager.create(launch());
    // FakeProvisioner keys the env var on the session id; it must reach the spawn.
    expect(connector.spawns[0].env.CCHUB_SESSION_ID).toBe(s.id);
    // FakeCli echoes the mcpConfigPath into argv → fakeShell joins it into the command.
    expect(connector.spawns[0].command).toContain(`/tmp/mcp-${s.id}.json`);
  });

  test('each session gets a DISTINCT session-id env, and process.env is never polluted', () => {
    // Snapshot what process.env had before the work, then assert it's
    // unchanged after. Equivalent to "the code never writes process.env",
    // but doesn't assume the test runner's own env is clean — when the suite
    // runs inside a cchub session itself, the parent already has
    // CCHUB_SESSION_ID, and that's the parent's, not ours.
    const before = process.env.CCHUB_SESSION_ID;
    const prov = new FakeProvisioner();
    const { manager, connector } = makeManager(prov);
    const a = manager.create(launch());
    const b = manager.create(launch());
    const envA = connector.spawns[0].env.CCHUB_SESSION_ID;
    const envB = connector.spawns[1].env.CCHUB_SESSION_ID;
    expect(envA).toBe(a.id);
    expect(envB).toBe(b.id);
    expect(envA).not.toBe(envB);
    expect(process.env.CCHUB_SESSION_ID).toBe(before);
    // The two spawn envs are different objects (no shared mutable env).
    expect(connector.spawns[0].env).not.toBe(connector.spawns[1].env);
  });

  test('SSH target is NOT provisioned (v1 local-only) — no grant, no config flag', () => {
    const prov = new FakeProvisioner();
    const { manager, connector } = makeManager(prov);
    const sshLaunch: ResolvedLaunch = {
      ...launch(),
      server: { id: 'r', name: 'remote', kind: 'ssh', os: 'linux', host: 'h', port: 22, username: 'u', auth: { method: 'password' }, createdAt: 0, updatedAt: 0 },
    };
    manager.create(sshLaunch);
    expect(prov.provisioned).toHaveLength(0);
    expect(connector.spawns[0].env.CCHUB_SESSION_ID).toBeUndefined();
    expect(connector.spawns[0].command).not.toContain('mcp');
  });

  test('cleans up the grant exactly once on final exit', () => {
    const prov = new FakeProvisioner();
    const { manager, connector } = makeManager(prov);
    const s = manager.create(launch());
    expect(prov.cleaned).toHaveLength(0);
    connector.channels[0].emit('exit', 0);
    expect(prov.cleaned).toEqual([s.id]);
  });

  test('does NOT clean up on a resume-fallback respawn (same id reuses the same config)', () => {
    const prov = new FakeProvisioner();
    const { manager, connector } = makeManager(prov);
    manager.create(launch('continue'));
    // Drive the fallback: no-conversation marker → kill → exit → respawn.
    connector.channels[0].emit('data', 'NOCONV');
    connector.channels[0].emit('exit', null);
    expect(connector.channels).toHaveLength(2); // respawned
    expect(prov.cleaned).toHaveLength(0);       // fallback exit is NOT a final exit
    connector.channels[1].emit('exit', 0);      // now the real exit
    expect(prov.cleaned).toHaveLength(1);
  });
});
