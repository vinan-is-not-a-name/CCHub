import { test, expect } from '@playwright/test';
import Fastify from 'fastify';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { makeHookRoute, type HookSessionLookup } from '../src/server/infrastructure/hook/hookRoute.js';
import { buildApp as buildFullApp } from '../src/server/entry/createApp.js';
import { SessionManager } from '../src/server/application/session.js';
import { ConfigService } from '../src/server/domain/config/ConfigService.js';
import type { ConfigRepository } from '../src/server/domain/config/ConfigRepository.js';
import type { StoredConfig } from '../src/server/domain/config/schema.js';
import type { Connector, ConnectorChannel, ConnectorSpawnArgs } from '../src/server/infrastructure/transport/connector.js';
import type { ShellAdapter } from '../src/server/infrastructure/shell/shellAdapter.js';
import type { CliAdapter, CliLaunchSpec, CliRecoveryAction } from '../src/server/domain/session/cliAdapter.js';
import type { ResolvedLaunch } from '../src/shared/protocol.js';

/**
 * Tests for the hook HTTP endpoint: POST /hook/:sessionId
 *
 * Auth rules:
 *   - Missing or wrong Bearer → 401
 *   - Unknown sessionId → 404
 *   - Malformed body (not JSON, missing kind) → 400
 *   - Valid request → 200 + dispatches to session WS
 *
 * These run against a minimal Fastify instance with the hook route registered
 * in isolation (no WS, no sessions). The route handler is imported directly.
 */

function buildApp(lookup: HookSessionLookup, authToken: string) {
  const app = Fastify();
  const dispatched: Array<{ sessionId: string; kind: string }> = [];
  const route = makeHookRoute({ lookup, authToken, dispatch: (sessionId, kind) => { dispatched.push({ sessionId, kind }); } });
  app.post<{ Params: { sessionId: string } }>('/hook/:sessionId', route);
  return { app, dispatched };
}

class FakeChannel extends EventEmitter {
  write() {}
  resize() {}
  kill() {}
  getPid(): number | undefined { return undefined; }
}

class FakeConnector implements Connector {
  spawn(_args: ConnectorSpawnArgs): ConnectorChannel {
    return new FakeChannel() as unknown as ConnectorChannel;
  }
}

const fakeShell: ShellAdapter = {
  compile: (l) => l.command.join(' '),
  spawnArgs: (command) => ({ file: 'sh', args: ['-c', command] }),
};

class FakeCli implements CliAdapter {
  buildCommand(_l: CliLaunchSpec): string[] { return ['claude']; }
  isAwaitingApproval(): boolean { return false; }
  looksBusy(): boolean { return false; }
  looksIdle(): boolean { return false; }
  looksInterrupted(): boolean { return false; }
  detectRecovery(_chunk: string): CliRecoveryAction | null { return null; }
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

test.describe('hook endpoint auth', () => {
  test('missing Authorization header → 401', async () => {
    const { app } = buildApp(() => true, 'secret');
    const res = await app.inject({ method: 'POST', url: '/hook/sess-1', payload: { kind: 'stop' } });
    expect(res.statusCode).toBe(401);
  });

  test('wrong Bearer token → 401', async () => {
    const { app } = buildApp(() => true, 'secret');
    const res = await app.inject({ method: 'POST', url: '/hook/sess-1', payload: { kind: 'stop' }, headers: { authorization: 'Bearer wrong' } });
    expect(res.statusCode).toBe(401);
  });

  test('correct Bearer + unknown session → 404', async () => {
    const { app } = buildApp(() => false, 'secret');
    const res = await app.inject({ method: 'POST', url: '/hook/unknown', payload: { kind: 'stop' }, headers: { authorization: 'Bearer secret' } });
    expect(res.statusCode).toBe(404);
  });

  test('correct Bearer + valid session + missing kind → 400', async () => {
    const { app } = buildApp(() => true, 'secret');
    const res = await app.inject({ method: 'POST', url: '/hook/sess-1', payload: {}, headers: { authorization: 'Bearer secret' } });
    expect(res.statusCode).toBe(400);
  });

  test('correct Bearer + valid session + non-JSON body → 400', async () => {
    const { app } = buildApp(() => true, 'secret');
    const res = await app.inject({ method: 'POST', url: '/hook/sess-1', payload: 'not json', headers: { authorization: 'Bearer secret', 'content-type': 'text/plain' } });
    expect(res.statusCode).toBe(400);
  });

  test('correct Bearer + valid session + valid kind → 200', async () => {
    const { app, dispatched } = buildApp(() => true, 'secret');
    const res = await app.inject({ method: 'POST', url: '/hook/sess-1', payload: { kind: 'stop' }, headers: { authorization: 'Bearer secret' } });
    expect(res.statusCode).toBe(200);
    expect(dispatched).toEqual([{ sessionId: 'sess-1', kind: 'stop' }]);
  });

  test('dispatch receives the exact kind from the request body', async () => {
    const { app, dispatched } = buildApp(() => true, 'secret');
    await app.inject({ method: 'POST', url: '/hook/sess-1', payload: { kind: 'notification' }, headers: { authorization: 'Bearer secret' } });
    await app.inject({ method: 'POST', url: '/hook/sess-1', payload: { kind: 'stop_failure' }, headers: { authorization: 'Bearer secret' } });
    expect(dispatched.map(d => d.kind)).toEqual(['notification', 'stop_failure']);
  });

  test('empty authToken means no auth required — valid request passes', async () => {
    const { app, dispatched } = buildApp(() => true, '');
    const res = await app.inject({ method: 'POST', url: '/hook/sess-1', payload: { kind: 'stop' } });
    expect(res.statusCode).toBe(200);
    expect(dispatched.length).toBe(1);
  });

  test('kind arrives via ?kind= query param with no body (the Windows curl path)', async () => {
    const { app, dispatched } = buildApp(() => true, 'secret');
    const res = await app.inject({ method: 'POST', url: '/hook/sess-1?kind=stop', headers: { authorization: 'Bearer secret' } });
    expect(res.statusCode).toBe(200);
    expect(dispatched).toEqual([{ sessionId: 'sess-1', kind: 'stop' }]);
  });

  test('query kind is used and no-body POST still 200s', async () => {
    const { app, dispatched } = buildApp(() => true, '');
    const res = await app.inject({ method: 'POST', url: '/hook/sess-1?kind=user_prompt_submit' });
    expect(res.statusCode).toBe(200);
    expect(dispatched).toEqual([{ sessionId: 'sess-1', kind: 'user_prompt_submit' }]);
  });

  test('cross-session: POST for session A does not dispatch to session B', async () => {
    const known = new Set(['a', 'b']);
    const { app, dispatched } = buildApp((id) => known.has(id), 'secret');
    await app.inject({ method: 'POST', url: '/hook/a', payload: { kind: 'stop' }, headers: { authorization: 'Bearer secret' } });
    expect(dispatched).toEqual([{ sessionId: 'a', kind: 'stop' }]);
    // session b was not dispatched
    expect(dispatched.find(d => d.sessionId === 'b')).toBeUndefined();
  });
});

test.describe('hook endpoint integration with buildApp', () => {
  test('POST /hook/:sessionId emits hook on the matching ManagedSession', async () => {
    const connector = new FakeConnector();
    const manager = new SessionManager({
      connectorFor: () => connector,
      shellFor: () => fakeShell,
      cliAdapter: new FakeCli(),
    });
    const session = manager.create(launch());
    const hooks: string[] = [];
    session.on('hook', (kind) => hooks.push(kind));
    const app = await buildFullApp({
      manager,
      store: emptyStore(),
      authToken: 'secret',
      defaultTarget: 'local',
    });
    try {
      const res = await app.inject({ method: 'POST', url: `/hook/${session.id}`, payload: { kind: 'stop_failure' }, headers: { authorization: 'Bearer secret' } });
      expect(res.statusCode).toBe(200);
      expect(hooks).toEqual(['stop_failure']);
    } finally {
      await app.close();
    }
  });

  test('POST /hook/:sessionId is forwarded to an attached WebSocket client', async () => {
    const connector = new FakeConnector();
    const manager = new SessionManager({
      connectorFor: () => connector,
      shellFor: () => fakeShell,
      cliAdapter: new FakeCli(),
    });
    const session = manager.create(launch());
    const app = await buildFullApp({
      manager,
      store: emptyStore(),
      authToken: 'secret',
      defaultTarget: 'local',
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('missing test server address');

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    try {
      const hookMessage = new Promise<Record<string, unknown>>((resolve, reject) => {
        ws.on('message', (raw) => {
          const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (msg.type === 'auth.ok') ws.send(JSON.stringify({ type: 'session.attach', id: session.id, history: false }));
          if (msg.type === 'session.attached') {
            void app.inject({ method: 'POST', url: `/hook/${session.id}`, payload: { kind: 'stop' }, headers: { authorization: 'Bearer secret' } });
          }
          if (msg.type === 'notify.hook') resolve(msg);
        });
        ws.on('error', reject);
        ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: 'secret' })));
      });

      await expect(hookMessage).resolves.toMatchObject({ type: 'notify.hook', id: session.id, kind: 'stop' });
    } finally {
      ws.close();
      await app.close();
    }
  });
});
