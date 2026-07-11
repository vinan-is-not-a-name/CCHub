import { test, expect } from '@playwright/test';
import { makeMessageRouter } from '../src/client/views/session/messageRouter.js';
import { configCardFor } from '../src/client/views/configDialog.js';
import type { CardController } from '../src/client/views/cards/cardController.js';
import { isAnthropicFormat } from '../src/server/infrastructure/transport/profileProbe.js';
import { Store } from '../src/client/state.js';
import type { AppState, ClientSession } from '../src/client/state.js';
import type { AttachController } from '../src/client/views/session/attach.js';
import type { AppDeps } from '../src/client/deps.js';
import type { ClientMessage, ServerMessage, SessionInfo, SafeConfigSnapshot } from '../src/shared/protocol.js';

// messageRouter is pure client orchestration that e2e covers only slowly and
// flakily. It depends solely on fakeable collaborators (store / conn / attach),
// so each server message's side effects are asserted directly here.

const baseUi = {
  selectedProfileId: '', selectedServerId: '', selectedPresetId: '',
  profileMode: 'create' as const, serverMode: 'create' as const, presetMode: 'create' as const,
  preserveLaunchValues: false,
};

function makeStore(initial: Partial<AppState> = {}): Store {
  return new Store({ config: null, sessions: new Map(), activeId: null, ui: baseUi, creatingSession: false, ...initial });
}

function info(id: string): SessionInfo {
  return { id, state: 'idle', cwd: '/', createdAt: 0, target: 'local', label: id };
}

// A session whose terminal records loadSnapshot/write so the attach path is observable.
function session(id: string, attached = false): ClientSession {
  const calls = { loadSnapshot: 0, writes: [] as string[] };
  const terminal = {
    loadSnapshot: () => { calls.loadSnapshot++; },
    write: (d: string) => { calls.writes.push(d); },
  } as any;
  return Object.assign({ info: info(id), pane: {} as any, body: {} as any, terminal, attached }, { _calls: calls });
}

// Spy attach controller — records calls without touching the DOM.
function spyAttach() {
  const calls: Array<[string, ...any[]]> = [];
  const ctrl: AttachController = {
    addSession: (i) => calls.push(['addSession', i.id]),
    removeSession: (id) => calls.push(['removeSession', id]),
    activate: (id, sendAttach) => calls.push(['activate', id, sendAttach]),
  };
  return { ctrl, calls };
}

function setup(initial: Partial<AppState> = {}) {
  const store = makeStore(initial);
  const sent: ClientMessage[] = [];
  const conn = { send: (m: ClientMessage) => sent.push(m) } as unknown as AppDeps['conn'];
  const deps = { conn, store } as AppDeps;
  const { ctrl, calls } = spyAttach();
  let dialogOpened = 0;
  const route = makeMessageRouter(deps, ctrl, () => { dialogOpened++; });
  return { store, sent, calls, route, dialogOpened: () => dialogOpened };
}

// alert doesn't exist in the node test runtime; stub it for the error path.
test.beforeAll(() => { (globalThis as any).alert = () => {}; });

test.describe('messageRouter — auth.ok', () => {
  test('requests config and session list', () => {
    const { sent, route } = setup();
    route({ type: 'auth.ok' } as ServerMessage);
    expect(sent.map((m) => m.type)).toEqual(['config.get', 'session.list']);
  });
});

// Every config write echoes back a fresh snapshot; the router must push each one
// into the store so the cards re-render. A dropped case here is invisible in
// unit tests but shows up as a stale dropdown (the proxy-saved case did exactly
// that before this guard existed), so assert the whole set, not just one.
test.describe('messageRouter — config snapshot updates', () => {
  const snapshot: SafeConfigSnapshot = {
    profiles: [], servers: [], presets: [], proxies: [], defaults: {}, recentLaunches: [],
  };
  const savedTypes = [
    'config.snapshot', 'config.profile.saved', 'config.server.saved',
    'config.preset.saved', 'config.proxy.saved',
  ] as const;
  for (const type of savedTypes) {
    test(`${type} stores the snapshot`, () => {
      const { route, store } = setup();
      expect(store.get().config).toBeNull();
      route({ type, config: snapshot } as ServerMessage);
      expect(store.get().config).toBe(snapshot);
    });
  }
});


test.describe('messageRouter — session.list', () => {
  test('opens the launch dialog when there are no sessions', () => {
    const { route, dialogOpened, calls } = setup();
    route({ type: 'session.list', sessions: [] } as ServerMessage);
    expect(dialogOpened()).toBe(1);
    expect(calls).toEqual([]);
  });

  test('adds, activates the first, and attaches each (only the first focused)', () => {
    const { route, calls, sent } = setup();
    route({ type: 'session.list', sessions: [info('a'), info('b')] } as ServerMessage);

    expect(calls).toEqual([
      ['addSession', 'a'], ['addSession', 'b'], ['activate', 'a', false],
    ]);
    expect(sent).toEqual([
      { type: 'session.attach', id: 'a', focus: true, history: true },
      { type: 'session.attach', id: 'b', focus: false, history: true },
    ]);
  });
});

test.describe('messageRouter — session.created', () => {
  test('clears creatingSession, adds and activates the new session', () => {
    const { route, store, calls } = setup({ creatingSession: true });
    route({ type: 'session.created', session: info('new') } as ServerMessage);
    expect(store.get().creatingSession).toBe(false);
    expect(calls).toEqual([['addSession', 'new'], ['activate', 'new', undefined]]);
  });
});

test.describe('messageRouter — session.attached', () => {
  test('loads the snapshot only on the first attach and marks attached', () => {
    const s = session('a', false);
    const store = makeStore({ sessions: new Map([['a', s]]) });
    const busEvents: Array<{ event: string; payload: unknown }> = [];
    const bus = { emit: (event: string, payload: unknown) => busEvents.push({ event, payload }), on: () => () => {} };
    const deps = { conn: { send: () => {} }, store, bus } as unknown as AppDeps;
    const route = makeMessageRouter(deps, spyAttach().ctrl, () => {});

    route({ type: 'session.attached', session: info('a'), snapshot: { cols: 80, rows: 24, cursorX: 0, cursorY: 0, lines: [] } } as ServerMessage);
    expect((s as any)._calls.loadSnapshot).toBe(1);
    expect(store.get().sessions.get('a')?.attached).toBe(true);

    // Second attach (now attached) must NOT re-load the snapshot.
    route({ type: 'session.attached', session: info('a'), snapshot: { cols: 80, rows: 24, cursorX: 0, cursorY: 0, lines: [] } } as ServerMessage);
    expect((s as any)._calls.loadSnapshot).toBe(1);

    // Both attaches also broadcast session:resync so notify.ts can re-baseline
    // its `prev` map to the freshly attested state — the WS-reconnect fix that
    // suppresses stale ready/approval fires on a session that finished a turn
    // while the client had no live subscription.
    expect(busEvents.map(e => e.event)).toEqual(['session:resync', 'session:resync']);
    expect(busEvents[0]!.payload).toEqual({ id: 'a', state: 'idle' });
  });
});

test.describe('messageRouter — output and state', () => {
  test('writes output to the matching session terminal', () => {
    const s = session('a', true);
    const store = makeStore({ sessions: new Map([['a', s]]) });
    const deps = { conn: { send: () => {} }, store } as unknown as AppDeps;
    const route = makeMessageRouter(deps, spyAttach().ctrl, () => {});
    route({ type: 'output', id: 'a', data: 'xyz' } as ServerMessage);
    expect((s as any)._calls.writes).toEqual(['xyz']);
  });

  test('session.exit marks the session exited and clears creatingSession', () => {
    const s = session('a', true);
    const store = makeStore({ sessions: new Map([['a', s]]), creatingSession: true });
    const deps = { conn: { send: () => {} }, store } as unknown as AppDeps;
    const route = makeMessageRouter(deps, spyAttach().ctrl, () => {});
    route({ type: 'session.exit', id: 'a', code: 0 } as ServerMessage);
    expect(store.get().sessions.get('a')?.info.state).toBe('exited');
    expect(store.get().creatingSession).toBe(false);
  });
});

test.describe('messageRouter — hook notifications', () => {
  test('routes hook kinds through the notify handle', () => {
    const fired: Array<{ id: string; kind: string }> = [];
    const route = makeMessageRouter(
      { conn: { send: () => {} }, store: makeStore() } as unknown as AppDeps,
      spyAttach().ctrl,
      () => {},
      { fire: (id, kind) => fired.push({ id, kind }) },
    );
    route({ type: 'notify.hook', id: 'a', kind: 'notification' } as ServerMessage);
    route({ type: 'notify.hook', id: 'a', kind: 'stop' } as ServerMessage);
    route({ type: 'notify.hook', id: 'a', kind: 'stop_failure' } as ServerMessage);
    expect(fired).toEqual([
      { id: 'a', kind: 'approval' },
      { id: 'a', kind: 'ready' },
      { id: 'a', kind: 'ready' },
    ]);
  });
});

test.describe('messageRouter — error', () => {
  test('non-UNAUTHORIZED with no sessions opens the dialog and preserves launch values', () => {
    const { route, store, dialogOpened } = setup();
    route({ type: 'error', message: 'boom', code: 'ERROR' } as ServerMessage);
    expect(store.get().creatingSession).toBe(false);
    expect(store.get().ui.preserveLaunchValues).toBe(true);
    expect(dialogOpened()).toBe(1);
  });

  test('CONFIG_ERROR does not open the launch dialog', () => {
    const { route, dialogOpened } = setup();
    route({ type: 'error', message: 'name already exists', code: 'CONFIG_ERROR' } as ServerMessage);
    expect(dialogOpened()).toBe(0);
  });

  test('UNAUTHORIZED does not open the launch dialog', () => {
    const { route, dialogOpened } = setup();
    route({ type: 'error', message: 'no', code: 'UNAUTHORIZED' } as ServerMessage);
    expect(dialogOpened()).toBe(0);
  });

  test('does not open the dialog when sessions already exist', () => {
    const { route, dialogOpened } = setup({ sessions: new Map([['a', session('a')]]) });
    route({ type: 'error', message: 'x', code: 'ERROR' } as ServerMessage);
    expect(dialogOpened()).toBe(0);
  });
});

test.describe('messageRouter — session.destroyed', () => {
  test('delegates removal to the attach controller', () => {
    const { route, calls } = setup();
    route({ type: 'session.destroyed', id: 'gone' } as ServerMessage);
    expect(calls).toEqual([['removeSession', 'gone']]);
  });
});

test.describe('configCardFor — CONFIG_ERROR routing', () => {
  const noop: CardController = { startNew: () => {}, edit: () => {}, showError: () => {} };
  const cards = { profile: { ...noop }, server: { ...noop }, proxy: { ...noop }, preset: { ...noop } };

  test('routes config.profile.* to profile card', () => {
    expect(configCardFor('config.profile.save', cards.profile, cards.server, cards.proxy, cards.preset)).toBe(cards.profile);
    expect(configCardFor('config.profile.delete', cards.profile, cards.server, cards.proxy, cards.preset)).toBe(cards.profile);
    expect(configCardFor('config.profile.copy', cards.profile, cards.server, cards.proxy, cards.preset)).toBe(cards.profile);
  });

  test('routes config.server.* to server card', () => {
    expect(configCardFor('config.server.save', cards.profile, cards.server, cards.proxy, cards.preset)).toBe(cards.server);
  });

  test('routes config.proxy.* to proxy card', () => {
    expect(configCardFor('config.proxy.save', cards.profile, cards.server, cards.proxy, cards.preset)).toBe(cards.proxy);
  });

  test('routes config.preset.* to preset card', () => {
    expect(configCardFor('config.preset.save', cards.profile, cards.server, cards.proxy, cards.preset)).toBe(cards.preset);
  });

  test('returns null for unknown sourceType', () => {
    expect(configCardFor('launch.recent.forget', cards.profile, cards.server, cards.proxy, cards.preset)).toBeNull();
    expect(configCardFor('session.create', cards.profile, cards.server, cards.proxy, cards.preset)).toBeNull();
    expect(configCardFor('', cards.profile, cards.server, cards.proxy, cards.preset)).toBeNull();
  });
});

test.describe('isAnthropicFormat', () => {
  test('detects /anthropic suffix', () => {
    expect(isAnthropicFormat('https://api.deepseek.com/anthropic')).toBe(true);
    expect(isAnthropicFormat('https://api.deepseek.com/anthropic/')).toBe(true);
  });

  test('detects /anthropic in path', () => {
    expect(isAnthropicFormat('https://proxy.example.com/anthropic/v1')).toBe(true);
  });

  test('rejects unrelated paths', () => {
    expect(isAnthropicFormat('https://api.deepseek.com')).toBe(false);
    expect(isAnthropicFormat('https://api.openai.com/v1')).toBe(false);
    expect(isAnthropicFormat('https://api.anthropic.com')).toBe(false);
  });

  test('case insensitive', () => {
    expect(isAnthropicFormat('https://api.example.com/Anthropic')).toBe(true);
    expect(isAnthropicFormat('https://api.example.com/ANTHROPIC/v1')).toBe(true);
  });

  test('does not match anthropic as substring of another word', () => {
    expect(isAnthropicFormat('https://api.example.com/anthropicxyz')).toBe(false);
  });
});
