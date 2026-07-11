import { test, expect } from '@playwright/test';
import { Store } from '../src/client/state.js';
import type { ClientSession, AppState } from '../src/client/state.js';
import type { SafeConfigSnapshot, SessionInfo } from '../src/shared/protocol.js';

const baseUi = {
  selectedProfileId: '',
  selectedServerId: '',
  selectedPresetId: '',
  selectedProxyId: '',
  profileMode: 'create' as const,
  serverMode: 'create' as const,
  presetMode: 'create' as const,
  proxyMode: 'create' as const,
  preserveLaunchValues: false,
};

function makeStore(initial: Partial<AppState> = {}): Store {
  return new Store({
    config: null,
    sessions: new Map(),
    activeId: null,
    ui: baseUi,
    creatingSession: false,
    ...initial,
  });
}

function makeSession(id: string): ClientSession {
  const info: SessionInfo = {
    id, state: 'idle', cwd: '/', createdAt: 0, target: 'local', label: id,
  };
  // The test never invokes terminal methods; the cast is fine.
  return { info, pane: {} as any, body: {} as any, terminal: {} as any, attached: false };
}

const snapshot: SafeConfigSnapshot = {
  profiles: [
    { id: 'p1', name: 'P1', env: {}, hasAuthToken: false, createdAt: 0, updatedAt: 0 },
  ],
  servers: [
    { id: 's1', name: 'S1', kind: 'local', os: 'linux', createdAt: 0, updatedAt: 0 },
  ],
  presets: [
    { id: 'pr1', name: 'Pr1', serverId: 's1', cwd: '/', createdAt: 0, updatedAt: 0 },
  ],
  proxies: [
    { id: 'px1', name: 'Px1', bindPort: 1080, host: 'h', port: 7890, createdAt: 0, updatedAt: 0 },
  ],
  defaults: {},
  recentLaunches: [],
};

test.describe('Store session methods', () => {
  test('addSession is idempotent and notifies listeners exactly once per insert', () => {
    const store = makeStore();
    let count = 0;
    store.subscribe(() => count++);
    const s = makeSession('a');
    store.addSession('a', s);
    expect(count).toBe(1);
    store.addSession('a', s);
    expect(count).toBe(1); // duplicate insert is a no-op, no notification
    expect(store.get().sessions.size).toBe(1);
  });

  test('removeSession returns the removed entry and clears activeId when active', () => {
    const store = makeStore();
    const s = makeSession('a');
    store.addSession('a', s);
    store.set('activeId', 'a');
    const removed = store.removeSession('a');
    expect(removed).toBe(s);
    expect(store.get().sessions.has('a')).toBe(false);
    expect(store.get().activeId).toBeNull();
  });

  test('removeSession preserves activeId when removing a different session', () => {
    const store = makeStore();
    store.addSession('a', makeSession('a'));
    store.addSession('b', makeSession('b'));
    store.set('activeId', 'a');
    store.removeSession('b');
    expect(store.get().activeId).toBe('a');
  });

  test('removeSession returns undefined for unknown id and does not notify', () => {
    const store = makeStore();
    let count = 0;
    store.subscribe(() => count++);
    expect(store.removeSession('ghost')).toBeUndefined();
    expect(count).toBe(0);
  });

  test('updateSession applies a shallow patch and notifies', () => {
    const store = makeStore();
    store.addSession('a', makeSession('a'));
    store.updateSession('a', { attached: true });
    expect(store.get().sessions.get('a')?.attached).toBe(true);
  });

  test('reorderSession moves a session forward and preserves the rest', () => {
    const store = makeStore();
    store.addSession('a', makeSession('a'));
    store.addSession('b', makeSession('b'));
    store.addSession('c', makeSession('c'));
    store.reorderSession('a', 1);
    expect([...store.get().sessions.keys()]).toEqual(['b', 'a', 'c']);
  });

  test('reorderSession moves a session to the front', () => {
    const store = makeStore();
    store.addSession('a', makeSession('a'));
    store.addSession('b', makeSession('b'));
    store.addSession('c', makeSession('c'));
    store.reorderSession('c', 0);
    expect([...store.get().sessions.keys()]).toEqual(['c', 'a', 'b']);
  });

  test('reorderSession is a no-op when toIndex equals fromIndex', () => {
    const store = makeStore();
    store.addSession('a', makeSession('a'));
    store.addSession('b', makeSession('b'));
    let count = 0;
    store.subscribe(() => count++);
    store.reorderSession('a', 0);
    expect(count).toBe(0);
    expect([...store.get().sessions.keys()]).toEqual(['a', 'b']);
  });

  test('reorderSession is a no-op for unknown id', () => {
    const store = makeStore();
    store.addSession('a', makeSession('a'));
    let count = 0;
    store.subscribe(() => count++);
    store.reorderSession('ghost', 0);
    expect(count).toBe(0);
  });

  test('reorderSession preserves activeId', () => {
    const store = makeStore();
    store.addSession('a', makeSession('a'));
    store.addSession('b', makeSession('b'));
    store.addSession('c', makeSession('c'));
    store.set('activeId', 'b');
    store.reorderSession('c', 0);
    expect(store.get().activeId).toBe('b');
  });

  test('reorderSession clamps out-of-range toIndex', () => {
    const store = makeStore();
    store.addSession('a', makeSession('a'));
    store.addSession('b', makeSession('b'));
    store.addSession('c', makeSession('c'));
    store.reorderSession('a', 99);
    expect([...store.get().sessions.keys()]).toEqual(['b', 'c', 'a']);
  });

  test('reorderSession replaces the sessions Map reference (subscribers see new Map)', () => {
    const store = makeStore();
    store.addSession('a', makeSession('a'));
    store.addSession('b', makeSession('b'));
    const before = store.get().sessions;
    store.reorderSession('a', 1);
    expect(store.get().sessions).not.toBe(before);
  });
});

test.describe('Store config selectors', () => {
  test('return undefined when config has not loaded', () => {
    const store = makeStore();
    expect(store.getServer('s1')).toBeUndefined();
    expect(store.getProfile('p1')).toBeUndefined();
    expect(store.getPreset('pr1')).toBeUndefined();
    expect(store.getProxy('px1')).toBeUndefined();
  });

  test('return undefined for empty/undefined ids', () => {
    const store = makeStore({ config: snapshot });
    expect(store.getServer(undefined)).toBeUndefined();
    expect(store.getServer('')).toBeUndefined();
  });

  test('locate entities by id', () => {
    const store = makeStore({ config: snapshot });
    expect(store.getServer('s1')?.name).toBe('S1');
    expect(store.getProfile('p1')?.name).toBe('P1');
    expect(store.getPreset('pr1')?.name).toBe('Pr1');
    expect(store.getProxy('px1')?.name).toBe('Px1');
  });

  test('return undefined for unknown id', () => {
    const store = makeStore({ config: snapshot });
    expect(store.getServer('ghost')).toBeUndefined();
  });
});
