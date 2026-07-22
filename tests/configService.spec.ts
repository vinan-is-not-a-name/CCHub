import { test, expect } from '@playwright/test';
import { ConfigService } from '../src/server/domain/config/ConfigService.js';
import type { ConfigRepository } from '../src/server/domain/config/ConfigRepository.js';
import type { StoredConfig } from '../src/server/domain/config/schema.js';
import type { LocalServerProfile, SshServerProfile } from '../src/shared/protocol.js';

const now = 1_700_000_000_000;

function localServer(id: string, overrides: Partial<LocalServerProfile> = {}): LocalServerProfile {
  return { id, name: id, kind: 'local', os: 'linux', createdAt: now, updatedAt: now, ...overrides };
}
function sshServer(id: string, overrides: Partial<SshServerProfile> = {}): SshServerProfile {
  return {
    id, name: id, kind: 'ssh', os: 'linux',
    host: 'h', port: 22, username: 'u',
    auth: { method: 'privateKeyPath', privateKeyPath: '/k' },
    createdAt: now, updatedAt: now, ...overrides,
  };
}

function makeService(initial: Partial<StoredConfig>): ConfigService {
  const data: StoredConfig = {
    version: 1,
    profiles: [],
    servers: [],
    presets: [],
    proxies: [],
    defaults: {},
    recentLaunches: [],
    appSettings: {},
    ...initial,
  };
  const repo: ConfigRepository = {
    loadOrCreate: () => ({ data, created: false }),
    save: () => {},
  };
  return new ConfigService(repo, '/test-cwd');
}

test.describe('ConfigService.resolveServer', () => {
  test('returns explicit id when present', () => {
    const a = localServer('a'), b = sshServer('b');
    const svc = makeService({ servers: [a, b], defaults: { serverId: 'a' } });
    expect(svc.resolveServer({ preferredIds: ['b'] }).id).toBe('b');
  });

  test('walks preferredIds, first defined wins', () => {
    const a = localServer('a'), b = localServer('b'), c = localServer('c');
    const svc = makeService({ servers: [a, b, c] });
    expect(svc.resolveServer({ preferredIds: [undefined, 'b', 'c'] }).id).toBe('b');
  });

  test('throws when an explicit id is unknown', () => {
    const a = localServer('a');
    const svc = makeService({ servers: [a] });
    expect(() => svc.resolveServer({ preferredIds: ['ghost'] })).toThrow('server not found');
  });

  test('falls back to first matching kind when preferredIds are all undefined', () => {
    const a = localServer('a'), b = sshServer('b'), c = sshServer('c');
    const svc = makeService({ servers: [a, b, c] });
    expect(svc.resolveServer({ fallbackTarget: 'ssh' }).id).toBe('b');
  });

  test('falls back to first server when no kind match', () => {
    const a = localServer('a'), b = localServer('b');
    const svc = makeService({ servers: [a, b] });
    expect(svc.resolveServer({ fallbackTarget: 'ssh' }).id).toBe('a');
  });

  test('skips undefined entries in preferredIds before falling back', () => {
    const a = localServer('a'), b = sshServer('b');
    const svc = makeService({ servers: [a, b] });
    // All preferredIds undefined → fallback by target
    expect(svc.resolveServer({ preferredIds: [undefined, undefined], fallbackTarget: 'ssh' }).id).toBe('b');
  });
});

test.describe('ConfigService — proxy CRUD', () => {
  test('saveProxy adds a normalized proxy to the snapshot', () => {
    const svc = makeService({});
    const snap = svc.saveProxy({ name: 'Corp', bindPort: 1080, host: '192.0.2.42', port: 7890 });
    expect(snap.proxies).toHaveLength(1);
    expect(snap.proxies[0]).toMatchObject({ name: 'Corp', bindPort: 1080, host: '192.0.2.42', port: 7890 });
  });

  test('deleteProxy removes an unreferenced proxy', () => {
    const svc = makeService({});
    const saved = svc.saveProxy({ name: 'Corp', bindPort: 1080, host: 'h', port: 7890 });
    const id = saved.proxies[0].id;
    const snap = svc.deleteProxy(id);
    expect(snap.proxies).toHaveLength(0);
  });

  test('deleteProxy throws when a preset still references the proxy', () => {
    const a = localServer('a');
    const svc = makeService({ servers: [a] });
    const saved = svc.saveProxy({ name: 'Corp', bindPort: 1080, host: 'h', port: 7890 });
    const proxyId = saved.proxies[0].id;
    svc.savePreset({ name: 'P', serverId: 'a', cwd: '/c', proxyId });
    expect(() => svc.deleteProxy(proxyId)).toThrow('proxy is used by a preset');
  });

  test('savePreset rejects an unknown proxyId', () => {
    const a = localServer('a');
    const svc = makeService({ servers: [a] });
    expect(() => svc.savePreset({ name: 'P', serverId: 'a', cwd: '/c', proxyId: 'ghost' })).toThrow('proxy not found');
  });
});

test.describe('ConfigService — unique names and copy', () => {
  test('rejects duplicate names within the same config type', () => {
    const svc = makeService({ servers: [localServer('s1')] });
    svc.saveProfile({ name: 'Provider', env: { ANTHROPIC_BASE_URL: 'https://a.test' } });
    expect(() => svc.saveProfile({ name: 'Provider', env: { ANTHROPIC_BASE_URL: 'https://b.test' } })).toThrow('name already exists');

    svc.saveServer({ name: 'Local A', kind: 'local', os: 'linux' });
    expect(() => svc.saveServer({ name: 'Local A', kind: 'local', os: 'linux' })).toThrow('name already exists');

    svc.savePreset({ name: 'Preset A', serverId: 's1', cwd: '/a' });
    expect(() => svc.savePreset({ name: 'Preset A', serverId: 's1', cwd: '/b' })).toThrow('name already exists');

    svc.saveProxy({ name: 'Proxy A', bindPort: 1080, host: 'h', port: 7890 });
    expect(() => svc.saveProxy({ name: 'Proxy A', bindPort: 1081, host: 'h', port: 7891 })).toThrow('name already exists');
  });

  test('allows editing an item without changing its name', () => {
    const svc = makeService({});
    const saved = svc.saveProfile({ name: 'Provider', env: { ANTHROPIC_BASE_URL: 'https://a.test' } });
    const id = saved.profiles[0].id;
    const snap = svc.saveProfile({ id, name: 'Provider', env: { ANTHROPIC_BASE_URL: 'https://b.test' } });
    expect(snap.profiles).toHaveLength(1);
    expect(snap.profiles[0].env.ANTHROPIC_BASE_URL).toBe('https://b.test');
  });

  test('copies each config type with a 副本 suffix', () => {
    const server = localServer('s1', { name: 'Local A' });
    const svc = makeService({ servers: [server] });
    const profileId = svc.saveProfile({ name: 'Provider A', env: { ANTHROPIC_MODEL: 'm' } }).profiles[0].id;
    const savedPreset = svc.savePreset({ name: 'Preset A', serverId: 's1', cwd: '/a', anthropicProfileId: profileId }).presets.find(p => p.name === 'Preset A');
    const presetId = savedPreset!.id;
    const proxyId = svc.saveProxy({ name: 'Proxy A', bindPort: 1080, host: 'h', port: 7890 }).proxies[0].id;

    const profileCopied = svc.copyProfile(profileId);
    const serverCopied = svc.copyServer('s1');
    const presetCopied = svc.copyPreset(presetId);
    const proxyCopied = svc.copyProxy(proxyId);

    const profileCopy = profileCopied.config.profiles.find(p => p.name === 'Provider A副本');
    const serverCopy = serverCopied.config.servers.find(s => s.name === 'Local A副本');
    const presetCopy = presetCopied.config.presets.find(p => p.name === 'Preset A副本');
    const proxyCopy = proxyCopied.config.proxies.find(p => p.name === 'Proxy A副本');

    expect(profileCopied.selectedId).toBe(profileCopy?.id);
    expect(serverCopied.selectedId).toBe(serverCopy?.id);
    expect(presetCopied.selectedId).toBe(presetCopy?.id);
    expect(proxyCopied.selectedId).toBe(proxyCopy?.id);

    expect(profileCopy).toMatchObject({ env: { ANTHROPIC_MODEL: 'm' } });
    expect(serverCopy).toMatchObject({ kind: 'local', os: 'linux' });
    expect(presetCopy).toMatchObject({ serverId: 's1', cwd: '/a', anthropicProfileId: profileId });
    expect(proxyCopy).toMatchObject({ bindPort: 1080, host: 'h', port: 7890 });
  });
});

// Recent-launch ledger drives the topbar quick-access dropdown. The three
// contracts that matter to callers: identical identity collapses to one
// entry (not a flood), a new identity prepends, and the list caps so an old
// session-storm doesn't grow the config forever. Rename of an underlying
// preset is *not* covered here — chip rendering does live id-lookup, so the
// store just keeps a name snapshot for the deleted-preset fallback path.
test.describe('ConfigService.recordRecentLaunch', () => {
  test('same identity re-launch collapses to one entry with fresh timestamp', () => {
    const svc = makeService({});
    svc.recordRecentLaunch({ presetId: 'p', serverId: 's', cwd: '/w', presetNameSnapshot: 'P' });
    const snap1 = svc.recordRecentLaunch({ presetId: 'p', serverId: 's', cwd: '/w', presetNameSnapshot: 'P' });
    expect(snap1.recentLaunches).toHaveLength(1);
  });

  test('different identity is prepended (most-recent first)', () => {
    const svc = makeService({});
    svc.recordRecentLaunch({ presetId: 'a', cwd: '/w', presetNameSnapshot: 'A' });
    const snap = svc.recordRecentLaunch({ presetId: 'b', cwd: '/w', presetNameSnapshot: 'B' });
    expect(snap.recentLaunches.map(r => r.presetId)).toEqual(['b', 'a']);
  });

  test('persists effective proxyId/skipPermissions/effort for faithful re-launch', () => {
    const svc = makeService({});
    const snap = svc.recordRecentLaunch({
      presetId: 'p', serverId: 's', cwd: '/w',
      proxyId: '', skipPermissions: true, effort: 'max', presetNameSnapshot: 'P',
    });
    const r = snap.recentLaunches[0];
    expect(r.proxyId).toBe('');
    expect(r.skipPermissions).toBe(true);
    expect(r.effort).toBe('max');
  });

  test('same identity but different skip/effort is a distinct entry (not collapsed)', () => {
    const svc = makeService({});
    svc.recordRecentLaunch({ presetId: 'p', cwd: '/w', skipPermissions: false, presetNameSnapshot: 'P' });
    const skip = svc.recordRecentLaunch({ presetId: 'p', cwd: '/w', skipPermissions: true, presetNameSnapshot: 'P' });
    expect(skip.recentLaunches).toHaveLength(2);
    const eff = svc.recordRecentLaunch({ presetId: 'p', cwd: '/w', skipPermissions: true, effort: 'max', presetNameSnapshot: 'P' });
    expect(eff.recentLaunches).toHaveLength(3);
  });

  test('cap evicts the oldest entry once RECENT_LAUNCH_MAX is exceeded', () => {
    const svc = makeService({});
    // 21 distinct identities → 20 kept, first one dropped.
    for (let i = 0; i < 21; i += 1) {
      svc.recordRecentLaunch({ presetId: `p${i}`, cwd: '/w', presetNameSnapshot: `P${i}` });
    }
    const snap = svc.getSnapshot();
    expect(snap.recentLaunches).toHaveLength(20);
    expect(snap.recentLaunches.map(r => r.presetId)).not.toContain('p0');
    expect(snap.recentLaunches[0].presetId).toBe('p20');
  });

  test('forgetRecentLaunch removes only the targeted key', () => {
    const svc = makeService({});
    const a = svc.recordRecentLaunch({ presetId: 'a', cwd: '/w', presetNameSnapshot: 'A' });
    svc.recordRecentLaunch({ presetId: 'b', cwd: '/w', presetNameSnapshot: 'B' });
    const keyA = a.recentLaunches[0].key;
    const snap = svc.forgetRecentLaunch(keyA);
    expect(snap.recentLaunches.map(r => r.presetId)).toEqual(['b']);
  });

  test('clearRecentLaunches wipes the list', () => {
    const svc = makeService({});
    svc.recordRecentLaunch({ presetId: 'a', cwd: '/w', presetNameSnapshot: 'A' });
    svc.recordRecentLaunch({ presetId: 'b', cwd: '/w', presetNameSnapshot: 'B' });
    const snap = svc.clearRecentLaunches();
    expect(snap.recentLaunches).toEqual([]);
  });
});
