import { test, expect } from '@playwright/test';
import { EventEmitter } from 'events';
import { handleWs } from '../src/server/ws/connection.js';
import type { WsLike } from '../src/server/ws/connection.js';
import { SessionManager } from '../src/server/application/session.js';
import { ConfigService } from '../src/server/domain/config/ConfigService.js';
import type { ConfigRepository } from '../src/server/domain/config/ConfigRepository.js';
import type { StoredConfig } from '../src/server/domain/config/schema.js';
import type { Connector, ConnectorChannel, ConnectorSpawnArgs } from '../src/server/infrastructure/transport/connector.js';
import type { ShellAdapter } from '../src/server/infrastructure/shell/shellAdapter.js';
import type { CliAdapter, CliLaunchSpec, CliRecoveryAction } from '../src/server/domain/session/cliAdapter.js';
import type { ResolvedLaunch, ServerMessage } from '../src/shared/protocol.js';

// handleWs is the protocol entry point: auth gating and subscribe/unsubscribe
// wiring are pure orchestration but easy to break. The WsLike interface lets us
// drive it with a fake socket — no real server — and a real SessionManager
// (fake connector) so emitted session events exercise the real subscription path.

class FakeChannel extends EventEmitter {
  writes: string[] = [];
  write(d: string) { this.writes.push(d); }
  resize() {}
  kill() {}
}
class FakeConnector implements Connector {
  channels: FakeChannel[] = [];
  spawn(_args: ConnectorSpawnArgs): ConnectorChannel {
    const ch = new FakeChannel();
    this.channels.push(ch);
    return ch as unknown as ConnectorChannel;
  }
}
const fakeShell: ShellAdapter = { compile: (l) => l.command.join(' '), spawnArgs: () => ({ file: 'sh', args: [] }) };
class FakeCli implements CliAdapter {
  buildCommand(_l: CliLaunchSpec): string[] { return ['claude']; }
  isAwaitingApproval(): boolean { return false; }
  looksBusy(): boolean { return false; }
  looksIdle(): boolean { return false; }
  detectRecovery(_c: string): CliRecoveryAction | null { return null; }
}

function launch(): ResolvedLaunch {
  return {
    server: { id: 's', name: 'srv', kind: 'local', os: 'linux', createdAt: 0, updatedAt: 0 },
    cwd: '/tmp', env: {}, serverName: 'srv', label: 'L',
  };
}

function emptyStore(): ConfigService {
  const data: StoredConfig = { version: 1, profiles: [], servers: [], presets: [], proxies: [], defaults: {}, recentLaunches: [] };
  const repo: ConfigRepository = { loadOrCreate: () => ({ data, created: false }), save: () => {} };
  return new ConfigService(repo, '/test-cwd');
}

// Fake socket: records what the server sent / whether it closed, and lets the
// test deliver 'message'/'close' events the way @fastify/websocket would.
class FakeWs implements WsLike {
  readyState = 1;
  sent: ServerMessage[] = [];
  closed = 0;
  private handlers = new Map<string, (...args: any[]) => void>();
  send(data: string) { this.sent.push(JSON.parse(data)); }
  on(event: string, handler: (...args: any[]) => void) { this.handlers.set(event, handler); }
  close() { this.closed += 1; }
  deliver(msg: unknown) { this.handlers.get('message')?.(Buffer.from(JSON.stringify(msg))); }
  fireClose() { this.handlers.get('close')?.(); }
  types() { return this.sent.map((m) => m.type); }
}

function setup(authToken = '', opts: { detectApps?: () => Promise<{ xshellPath: string | null; xftpPath: string | null; vscodePath: string | null }>; store?: ConfigService } = {}) {
  const connector = new FakeConnector();
  const manager = new SessionManager({
    connectorFor: () => connector as unknown as Connector,
    shellFor: () => fakeShell,
    cliAdapter: new FakeCli(),
  });
  const ws = new FakeWs();
  const revealed: string[] = [];
  const revealedXshell: { host: string; cwd: string }[] = [];
  const revealedXftp: { host: string; cwd: string }[] = [];
  const revealedVscode: { cwd: string; sshHost?: string }[] = [];
  const revealedLocalShell: { cwd: string; app: string }[] = [];
  const store = opts.store ?? emptyStore();
  handleWs(ws, manager, store, {
    authToken,
    defaultTarget: 'local',
    reveal: (path) => revealed.push(path),
    revealXshell: (server, cwd) => revealedXshell.push({ host: server.host, cwd }),
    revealXftp: (server, cwd) => revealedXftp.push({ host: server.host, cwd }),
    revealVscode: (cwd, ssh) => revealedVscode.push(ssh ? { cwd, sshHost: ssh.host } : { cwd }),
    revealLocalShell: (cwd, app) => revealedLocalShell.push({ cwd, app }),
    detectApps: opts.detectApps ?? (async () => ({ xshellPath: null, xftpPath: null, vscodePath: null })),
  });
  return { ws, manager, connector, revealed, revealedXshell, revealedXftp, revealedVscode, revealedLocalShell, store };
}

test.describe('handleWs — authentication gate', () => {
  test('rejects and closes when a non-auth message arrives before auth', () => {
    const { ws } = setup('secret');
    ws.deliver({ type: 'session.list' });
    expect(ws.sent[0]).toMatchObject({ type: 'error', code: 'UNAUTHORIZED' });
    expect(ws.closed).toBe(1);
  });

  test('rejects and closes on a wrong token', () => {
    const { ws } = setup('secret');
    ws.deliver({ type: 'auth', token: 'wrong' });
    expect(ws.sent[0]).toMatchObject({ type: 'error', code: 'UNAUTHORIZED' });
    expect(ws.closed).toBe(1);
  });

  test('accepts the correct token with auth.ok', () => {
    const { ws } = setup('secret');
    ws.deliver({ type: 'auth', token: 'secret' });
    expect(ws.sent[0]).toMatchObject({ type: 'auth.ok' });
    expect(ws.closed).toBe(0);
  });

  test('with no configured token, any auth message is accepted', () => {
    const { ws } = setup('');
    ws.deliver({ type: 'auth' });
    expect(ws.sent[0]).toMatchObject({ type: 'auth.ok' });
  });
});

test.describe('handleWs — subscription lifecycle', () => {
  function authedSessionAttached() {
    const ctx = setup('');
    ctx.ws.deliver({ type: 'auth' });
    const session = ctx.manager.create(launch());
    ctx.ws.deliver({ type: 'session.attach', id: session.id, focus: true, history: false });
    ctx.ws.sent.length = 0; // drop auth.ok + session.attached; focus on what follows
    return { ...ctx, session };
  }

  test('forwards session output/state/exit to the client', () => {
    const { ws, session } = authedSessionAttached();
    session.emit('output', 'hello');
    session.emit('state', 'idle');
    session.emit('exit', 0);
    expect(ws.sent).toEqual([
      { type: 'output', id: session.id, data: 'hello' },
      { type: 'state', id: session.id, state: 'idle' },
      { type: 'session.exit', id: session.id, code: 0 },
    ]);
  });

  test('forwards hook events to the client', () => {
    const { ws, session } = authedSessionAttached();
    session.emitHook('stop');
    session.emitHook('notification');
    expect(ws.sent).toEqual([
      { type: 'notify.hook', id: session.id, kind: 'stop' },
      { type: 'notify.hook', id: session.id, kind: 'notification' },
    ]);
  });

  test('unsubscribes after exit so later events are not forwarded', () => {
    const { ws, session } = authedSessionAttached();
    session.emit('exit', 0);
    ws.sent.length = 0;
    session.emit('output', 'after-exit'); // subscription should be gone
    expect(ws.sent).toEqual([]);
  });

  test('ws close detaches all subscriptions', () => {
    const { ws, session } = authedSessionAttached();
    ws.fireClose();
    session.emit('output', 'after-close');
    expect(ws.sent).toEqual([]);
  });

  test('attaching an unknown session id yields SESSION_NOT_FOUND', () => {
    const { ws } = setup('');
    ws.deliver({ type: 'auth' });
    ws.sent.length = 0;
    ws.deliver({ type: 'session.attach', id: 'ghost' });
    expect(ws.sent[0]).toMatchObject({ type: 'error', code: 'SESSION_NOT_FOUND' });
  });
});

// session.reorder is the persistence hook for the client's drag-to-reorder
// (rail tabs + grid pane heads). Without this handler, the reordered layout is
// client-only: on a page refresh the client re-requests session.list, gets the
// server's original Map insertion order, and the drag is lost. The tests below
// reproduce that failure mode by asserting that a subsequent session.list
// reflects the reorder.
test.describe('handleWs — session.reorder persists across a page refresh', () => {
  function authedWithThreeSessions() {
    const ctx = setup('');
    ctx.ws.deliver({ type: 'auth' });
    const a = ctx.manager.create(launch());
    const b = ctx.manager.create(launch());
    const c = ctx.manager.create(launch());
    ctx.ws.sent.length = 0;
    return { ...ctx, ids: [a.id, b.id, c.id] as const };
  }

  function listedIds(sent: ServerMessage[]): string[] {
    const msg = sent.find((m): m is Extract<ServerMessage, { type: 'session.list' }> => m.type === 'session.list');
    return msg ? msg.sessions.map((s) => s.id) : [];
  }

  test('baseline: without a reorder, session.list echoes creation order', () => {
    const { ws, ids } = authedWithThreeSessions();
    ws.deliver({ type: 'session.list' });
    expect(listedIds(ws.sent)).toEqual([...ids]);
  });

  test('session.reorder is persisted: next session.list reflects the new order', () => {
    const { ws, ids } = authedWithThreeSessions();
    ws.deliver({ type: 'session.reorder', id: ids[0], toIndex: 1 });
    // Fire-and-forget — the server acknowledges by echoing the new order in the
    // next session.list a refreshed client would request.
    ws.deliver({ type: 'session.list' });
    expect(listedIds(ws.sent)).toEqual([ids[1], ids[0], ids[2]]);
  });

  test('unknown id is a silent no-op — order unchanged', () => {
    const { ws, ids } = authedWithThreeSessions();
    ws.deliver({ type: 'session.reorder', id: 'ghost', toIndex: 0 });
    ws.deliver({ type: 'session.list' });
    expect(listedIds(ws.sent)).toEqual([...ids]);
  });
});

test.describe('handleWs — focused target fallback', () => {
  test('input without an explicit id routes to the focused session', () => {
    const { ws, manager, connector } = setup('');
    ws.deliver({ type: 'auth' });
    const session = manager.create(launch());
    ws.deliver({ type: 'session.attach', id: session.id, focus: true, history: false });
    ws.deliver({ type: 'input', data: 'typed' }); // no id → focused session
    expect(connector.channels[0].writes).toContain('typed');
  });
});

// shell.reveal is the WS entry point for the "click the cwd in the title bar
// to open it" feature. Three apps: 'files' (OS file browser, local only),
// 'xshell' and 'xftp' (SSH only, remote clients). Guard paths that must hold:
// unknown ids must not crash; local sessions must not be sent to xshell/xftp
// (there's no remote host to open); SSH sessions must not be sent to 'files'
// (the cwd lives on a remote host this server can't reach).
test.describe('handleWs — shell.reveal', () => {
  function sshLaunch(): ResolvedLaunch {
    return {
      server: {
        id: 's', name: 'edge', kind: 'ssh', os: 'linux', host: 'h', port: 22,
        username: 'u', auth: { method: 'privateKeyPath', privateKeyPath: '/k' },
        createdAt: 0, updatedAt: 0,
      },
      cwd: '/remote/work', env: {}, serverName: 'edge', label: 'ssh',
    };
  }

  test('forwards a local session cwd to the files reveal helper (default app)', () => {
    const { ws, manager, revealed } = setup('');
    ws.deliver({ type: 'auth' });
    const session = manager.create(launch()); // cwd '/tmp', kind 'local'
    ws.deliver({ type: 'shell.reveal', id: session.id });
    expect(revealed).toEqual(['/tmp']);
  });

  test('app:"files" behaves the same as omitting app', () => {
    const { ws, manager, revealed } = setup('');
    ws.deliver({ type: 'auth' });
    const session = manager.create(launch());
    ws.deliver({ type: 'shell.reveal', id: session.id, app: 'files' });
    expect(revealed).toEqual(['/tmp']);
  });

  test('drops files reveal for an SSH session — the cwd lives on a remote host', () => {
    const { ws, manager, revealed } = setup('');
    ws.deliver({ type: 'auth' });
    const session = manager.create(sshLaunch());
    ws.deliver({ type: 'shell.reveal', id: session.id, app: 'files' });
    expect(revealed).toEqual([]);
  });

  test('app:"xshell" forwards an SSH session to the xshell helper', () => {
    const { ws, manager, revealedXshell } = setup('');
    ws.deliver({ type: 'auth' });
    const session = manager.create(sshLaunch());
    ws.deliver({ type: 'shell.reveal', id: session.id, app: 'xshell' });
    expect(revealedXshell).toEqual([{ host: 'h', cwd: '/remote/work' }]);
  });

  test('app:"xftp" forwards an SSH session to the xftp helper', () => {
    const { ws, manager, revealedXftp } = setup('');
    ws.deliver({ type: 'auth' });
    const session = manager.create(sshLaunch());
    ws.deliver({ type: 'shell.reveal', id: session.id, app: 'xftp' });
    expect(revealedXftp).toEqual([{ host: 'h', cwd: '/remote/work' }]);
  });

  test('drops xshell / xftp for a local session — no remote host to open', () => {
    const { ws, manager, revealedXshell, revealedXftp } = setup('');
    ws.deliver({ type: 'auth' });
    const session = manager.create(launch());
    ws.deliver({ type: 'shell.reveal', id: session.id, app: 'xshell' });
    ws.deliver({ type: 'shell.reveal', id: session.id, app: 'xftp' });
    expect(revealedXshell).toEqual([]);
    expect(revealedXftp).toEqual([]);
  });

  test('drops the request when the session id is unknown, no error emitted', () => {
    const { ws, revealed, revealedXshell, revealedXftp, revealedVscode, revealedLocalShell } = setup('');
    ws.deliver({ type: 'auth' });
    ws.sent.length = 0;
    ws.deliver({ type: 'shell.reveal', id: 'ghost' });
    ws.deliver({ type: 'shell.reveal', id: 'ghost', app: 'xshell' });
    ws.deliver({ type: 'shell.reveal', id: 'ghost', app: 'xftp' });
    ws.deliver({ type: 'shell.reveal', id: 'ghost', app: 'vscode' });
    ws.deliver({ type: 'shell.reveal', id: 'ghost', app: 'cmd' });
    expect(revealed).toEqual([]);
    expect(revealedXshell).toEqual([]);
    expect(revealedXftp).toEqual([]);
    expect(revealedVscode).toEqual([]);
    expect(revealedLocalShell).toEqual([]);
    expect(ws.sent).toEqual([]);
  });

  // VS Code is the one target that spans both local and SSH sessions: local
  // opens the cwd directly, SSH routes through the Remote-SSH extension via
  // an ssh-remote+user@host authority. The handler must pass the SSH server
  // profile through only on the SSH branch — a stray `ssh` arg on a local
  // reveal would produce a broken `--remote` invocation.
  test('app:"vscode" on a local session opens without an ssh authority', () => {
    const { ws, manager, revealedVscode } = setup('');
    ws.deliver({ type: 'auth' });
    const session = manager.create(launch());
    ws.deliver({ type: 'shell.reveal', id: session.id, app: 'vscode' });
    expect(revealedVscode).toEqual([{ cwd: '/tmp' }]);
  });

  test('app:"vscode" on an SSH session passes the server profile for Remote-SSH', () => {
    const { ws, manager, revealedVscode } = setup('');
    ws.deliver({ type: 'auth' });
    const session = manager.create(sshLaunch());
    ws.deliver({ type: 'shell.reveal', id: session.id, app: 'vscode' });
    expect(revealedVscode).toEqual([{ cwd: '/remote/work', sshHost: 'h' }]);
  });

  // Local-shell reveals — each of the four apps forwards the cwd + app tag
  // to the injected spy. SSH sessions drop (there's no local shell that
  // makes sense on a remote-host cwd; XShell is the right tool for that).
  for (const app of ['cmd', 'cmd-admin', 'powershell', 'powershell-admin'] as const) {
    test(`app:"${app}" forwards a local cwd to the local-shell helper`, () => {
      const { ws, manager, revealedLocalShell } = setup('');
      ws.deliver({ type: 'auth' });
      const session = manager.create(launch());
      ws.deliver({ type: 'shell.reveal', id: session.id, app });
      expect(revealedLocalShell).toEqual([{ cwd: '/tmp', app }]);
    });

    test(`app:"${app}" drops for an SSH session (no local shell on remote host)`, () => {
      const { ws, manager, revealedLocalShell } = setup('');
      ws.deliver({ type: 'auth' });
      const session = manager.create(sshLaunch());
      ws.deliver({ type: 'shell.reveal', id: session.id, app });
      expect(revealedLocalShell).toEqual([]);
    });
  }
});

// Settings dialog protocol: the Detect button fires config.settings.detect
// with a requestId + waits for a matching config.settings.detected response;
// Save fires config.settings.save which persists to appSettings and returns
// a fresh config.snapshot. Both must be gated by auth like the rest of the
// config handlers.
test.describe('handleWs — settings save + detect', () => {
  test('config.settings.save writes appSettings and echoes a snapshot back', () => {
    const { ws, store } = setup('');
    ws.deliver({ type: 'auth' });
    ws.sent.length = 0;
    ws.deliver({
      type: 'config.settings.save',
      xshellPath: 'C:\\a\\Xshell.exe',
      xftpPath: 'C:\\b\\Xftp.exe',
      vscodePath: 'C:\\c\\code.cmd',
    });
    expect(store.getAppSettings()).toEqual({
      xshellPath: 'C:\\a\\Xshell.exe',
      xftpPath: 'C:\\b\\Xftp.exe',
      vscodePath: 'C:\\c\\code.cmd',
    });
    // Snapshot must come back so the client can re-render the Settings
    // dialog / anything else that reads appSettings from the store.
    const snapshot = ws.sent.find((m) => m.type === 'config.snapshot');
    expect(snapshot).toBeTruthy();
    expect((snapshot as any).config.appSettings).toEqual({
      xshellPath: 'C:\\a\\Xshell.exe',
      xftpPath: 'C:\\b\\Xftp.exe',
      vscodePath: 'C:\\c\\code.cmd',
    });
  });

  test('config.settings.save with empty string clears the stored value', () => {
    // Editing back to blank is how the user unsets a path — the reveal
    // helpers then fall back to bare-exe name / PATH.
    const store = emptyStore();
    store.saveAppSettings({ xshellPath: 'C:\\old\\Xshell.exe' });
    const { ws } = setup('', { store });
    ws.deliver({ type: 'auth' });
    ws.deliver({ type: 'config.settings.save', xshellPath: '', xftpPath: '' });
    expect(store.getAppSettings()).toEqual({});
  });

  test('config.settings.detect responds with the injected result + echoes requestId', async () => {
    const { ws } = setup('', {
      detectApps: async () => ({ xshellPath: 'C:\\a\\Xshell.exe', xftpPath: null, vscodePath: 'C:\\c\\code.cmd' }),
    });
    ws.deliver({ type: 'auth' });
    ws.sent.length = 0;
    ws.deliver({ type: 'config.settings.detect', requestId: 'req-1' });
    // detectApps is async — flush the microtask queue by yielding twice.
    await new Promise((r) => setImmediate(r));
    const detected = ws.sent.find((m) => m.type === 'config.settings.detected');
    expect(detected).toEqual({
      type: 'config.settings.detected',
      requestId: 'req-1',
      xshellPath: 'C:\\a\\Xshell.exe',
      xftpPath: null,
      vscodePath: 'C:\\c\\code.cmd',
    });
  });

  test('config.settings.save requires auth — rejected before token', () => {
    const { ws } = setup('secret');
    ws.deliver({ type: 'config.settings.save', xshellPath: 'x' });
    expect(ws.sent[0]).toMatchObject({ type: 'error', code: 'UNAUTHORIZED' });
    expect(ws.closed).toBe(1);
  });
});
