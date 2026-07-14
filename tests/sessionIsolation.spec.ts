import { test, expect } from '@playwright/test';
import { EventEmitter } from 'events';
import { SessionManager } from '../src/server/application/session.js';
import type { Connector, ConnectorChannel, ConnectorSpawnArgs } from '../src/server/infrastructure/transport/connector.js';
import type { ShellAdapter } from '../src/server/infrastructure/shell/shellAdapter.js';
import { ClaudeCliAdapter } from '../src/server/domain/session/ClaudeCliAdapter.js';
import { CmdAdapter, BashAdapter } from '../src/server/infrastructure/shell/shellAdapter.js';
import type { McpProvisioner, SessionMcpGrant } from '../src/server/infrastructure/mcp/sessionMcpConfig.js';
import type { ResolvedLaunch } from '../src/shared/protocol.js';

// This file is the regression guard for the project-wide WHITELIST isolation
// principle: every datum that distinguishes one session from another is packed
// into a single per-session SessionContext that is never shared and never
// written back to a global. Rather than enumerate every place state *could*
// leak (a blacklist), we assert the structural guarantees: two coexisting
// sessions share no mutable data, the shared stateless adapters carry no
// per-session fields, and process.env is never polluted. If a future change
// reintroduces shared session state, one of these breaks.

class FakeChannel extends EventEmitter {
  writes: string[] = [];
  killed = 0;
  states: string[] = [];
  write(d: string) { this.writes.push(d); }
  resize() {}
  kill() { this.killed += 1; }
}

// Each session gets its OWN connector (production mints one per create via
// connectorFor), so we can inspect each session's spawn/channel in isolation.
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

const fakeShell: ShellAdapter = {
  compile: (l) => l.command.join(' '),
  spawnArgs: (command) => ({ file: 'sh', args: ['-c', command] }),
};

class FakeProvisioner implements McpProvisioner {
  provision(id: string): SessionMcpGrant {
    return { configPath: `/tmp/mcp-${id}.json`, env: { CCHUB_SESSION_ID: id } };
  }
  cleanup(): void {}
}

const TINY = { inputSilenceMs: 10, idleAfterMs: 40, pasteSubmitMs: 10, recoveryWindowMs: 500, hardIdleTimeoutMs: 400 };

// A fresh launch per call with a fresh env object — mirrors launch.ts buildEnv,
// which resolves a new per-session env on every create (so two sessions never
// alias the same env object even before the MCP merge).
function launch(resume?: string, proxy?: ResolvedLaunch['proxy']): ResolvedLaunch {
  return {
    server: { id: 's', name: 'srv', kind: 'local', os: 'linux', createdAt: 0, updatedAt: 0 },
    cwd: '/tmp', env: {}, resume, proxy, serverName: 'srv', label: 'iso',
  };
}

function makeManager(opts: { mcp?: boolean } = {}) {
  const connectors: FakeConnector[] = [];
  // One shared, stateless adapter instance threaded into every session — the
  // whole point of "shared behavior, not shared data".
  const cliAdapter = new ClaudeCliAdapter();
  const manager = new SessionManager({
    connectorFor: () => { const c = new FakeConnector(); connectors.push(c); return c; },
    shellFor: () => fakeShell,
    cliAdapter,
    timing: TINY,
    mcpProvisioner: opts.mcp ? new FakeProvisioner() : undefined,
  });
  return { manager, connectors, cliAdapter };
}

test.describe('session isolation — runtime independence', () => {
  test("A's write, output, state and destroy never touch B", () => {
    const { manager, connectors } = makeManager();
    const a = manager.create(launch());
    const b = manager.create(launch());
    const chA = connectors[0].channels[0];
    const chB = connectors[1].channels[0];
    const bStates: string[] = [];
    b.on('state', (s) => bStates.push(s));

    a.write('only-A');
    expect(chA.writes).toEqual(['only-A']);
    expect(chB.writes).toEqual([]);

    // Output + an exit on A's channel flips A to exited; B is untouched.
    chA.emit('data', 'A output');
    chA.emit('exit', 0);
    expect(a.getInfo().state).toBe('exited');
    // State is hook-driven now: a freshly-created session starts idle and only a
    // UserPromptSubmit hook flips it to processing. B received no hook, so it
    // stays at its own idle — A's data/exit never bleed across.
    expect(b.getInfo().state).toBe('idle');
    expect(bStates).not.toContain('exited');

    // Destroying A kills only A's channel; B's stays live.
    expect(manager.destroy(a.id)).toBe(true);
    expect(chB.killed).toBe(0);
    expect(manager.get(b.id)).toBe(b);
  });
});

test.describe('session isolation — distinct per-session data', () => {
  test('each session spawns with its OWN env object (no shared alias)', () => {
    const { manager, connectors } = makeManager();
    manager.create(launch());
    manager.create(launch());
    const envA = connectors[0].spawns[0].env;
    const envB = connectors[1].spawns[0].env;
    expect(envA).not.toBe(envB); // different objects
    envA.LEAK = 'x';
    expect(envB.LEAK).toBeUndefined(); // mutating one never bleeds into the other
  });

  test('MCP grant env is per-session distinct and process.env is never polluted', () => {
    // Compare process.env before/after rather than asserting it's undefined,
    // so the test doesn't fail when run inside a cchub session that
    // already exported CCHUB_SESSION_ID from its own parent. The
    // guarantee we actually care about is "the code never writes the
    // global", which is exactly what the before/after check verifies.
    const before = process.env.CCHUB_SESSION_ID;
    const { manager, connectors } = makeManager({ mcp: true });
    const a = manager.create(launch());
    const b = manager.create(launch());
    const idA = connectors[0].spawns[0].env.CCHUB_SESSION_ID;
    const idB = connectors[1].spawns[0].env.CCHUB_SESSION_ID;
    expect(idA).toBe(a.id);
    expect(idB).toBe(b.id);
    expect(idA).not.toBe(idB);
    expect(process.env.CCHUB_SESSION_ID).toBe(before);
    expect(connectors[0].spawns[0].env).not.toBe(connectors[1].spawns[0].env);
  });

  test("each session's proxy tunnel rides its own spawn, not a shared one", () => {
    const { manager, connectors } = makeManager();
    // Only A launches behind a proxy; B has none. Each ResolvedLaunch.proxy must
    // flow into its own connector.spawn — the connector is what opens the tunnel.
    manager.create(launch(undefined, { bindPort: 1080, host: '192.0.2.42', port: 7890 }));
    manager.create(launch());
    expect(connectors[0].spawns[0].proxy).toEqual({ bindPort: 1080, host: '192.0.2.42', port: 7890 });
    expect(connectors[1].spawns[0].proxy).toBeUndefined();
  });
});

test.describe('session isolation — shared adapters hold no per-session state', () => {
  test('the stateless CLI/shell adapters carry zero instance fields', () => {
    expect(Object.keys(new ClaudeCliAdapter())).toHaveLength(0);
    // CmdAdapter/BashAdapter are singleton behavior objects: only methods, no data.
    for (const adapter of [CmdAdapter, BashAdapter]) {
      for (const key of Object.keys(adapter)) {
        expect(typeof (adapter as Record<string, unknown>)[key]).toBe('function');
      }
    }
  });

  test('one shared CLI adapter does not leak session A\'s resume into session B', () => {
    const { manager, connectors, cliAdapter } = makeManager();
    // Both sessions are built from the SAME adapter instance.
    const a = manager.create(launch('continue'));
    const b = manager.create(launch()); // no resume
    void a; void b;
    expect(connectors[0].spawns[0].command).toContain('-c'); // A resumed
    expect(connectors[1].spawns[0].command).not.toContain('-c'); // B did not — no carryover
    // Sanity: it really was one shared instance doing both builds.
    expect(cliAdapter).toBeInstanceOf(ClaudeCliAdapter);
  });
});
