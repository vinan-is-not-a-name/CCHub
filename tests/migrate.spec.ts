import { test, expect } from '@playwright/test';
import { normalizeConfig, createEmptyConfig } from '../src/server/domain/config/migrate.js';
import { defaultOsFor } from '../src/server/domain/config/schema.js';
import type { StoredConfig } from '../src/server/domain/config/schema.js';

// Backward-compat migration is a high-cost silent-failure surface: a regression
// corrupts existing users' configs on upgrade. These lock the normalize/seed
// contracts as pure functions (defaultCwd injected, no IO).

const now = 1_700_000_000_000;
const CWD = '/seed-cwd';

function config(overrides: Partial<StoredConfig> = {}): StoredConfig {
  return { version: 1, profiles: [], servers: [], presets: [], proxies: [], defaults: {}, recentLaunches: [], ...overrides };
}

test.describe('normalizeConfig — server backfill', () => {
  test('strips legacy defaultCwd and backfills missing os', () => {
    const legacy: any = {
      id: 's1', name: 's1', kind: 'ssh', host: 'h', port: 22, username: 'u',
      auth: { method: 'privateKeyPath', privateKeyPath: '/k' },
      defaultCwd: '/old/legacy/cwd',   // legacy field that must be dropped
      createdAt: now, updatedAt: now,
    };
    const out = normalizeConfig(config({ servers: [legacy], presets: [] }), CWD);
    const s = out.servers.find(s => s.id === 's1')!;
    expect(s).not.toHaveProperty('defaultCwd');
    expect(s.os).toBe(defaultOsFor('ssh')); // ssh always linux — platform-independent
  });

  test('preserves an explicit os instead of overwriting it', () => {
    const macServer: any = {
      id: 'm', name: 'm', kind: 'local', os: 'macos', createdAt: now, updatedAt: now,
    };
    const out = normalizeConfig(config({ servers: [macServer], presets: [] }), CWD);
    expect(out.servers.find(s => s.id === 'm')!.os).toBe('macos');
  });
});

test.describe('normalizeConfig — preset backfill', () => {
  const server = { id: 'srv', name: 'srv', kind: 'local' as const, os: 'linux' as const, createdAt: now, updatedAt: now };

  test('backfills preset serverId from defaults.serverId when missing', () => {
    const preset: any = { id: 'p', name: 'p', cwd: '/c', createdAt: now, updatedAt: now };
    const out = normalizeConfig(
      config({ servers: [server], presets: [preset], defaults: { serverId: 'srv' } }), CWD);
    expect(out.presets.find(p => p.id === 'p')!.serverId).toBe('srv');
  });

  test('backfills preset serverId from first server when no defaults present', () => {
    const preset: any = { id: 'p', name: 'p', cwd: '/c', createdAt: now, updatedAt: now };
    const out = normalizeConfig(config({ servers: [server], presets: [preset] }), CWD);
    expect(out.presets.find(p => p.id === 'p')!.serverId).toBe('srv');
  });

  test('drops a preset still missing cwd', () => {
    const ok: any = { id: 'ok', name: 'ok', serverId: 'srv', cwd: '/c', createdAt: now, updatedAt: now };
    const bad: any = { id: 'bad', name: 'bad', serverId: 'srv', createdAt: now, updatedAt: now };
    const out = normalizeConfig(config({ servers: [server], presets: [ok, bad] }), CWD);
    expect(out.presets.map(p => p.id)).toEqual(['ok']);
  });
});

test.describe('normalizeConfig — empty arrays inject defaults', () => {
  test('injects a local-default server and a default preset when both empty', () => {
    const out = normalizeConfig(config({ servers: [], presets: [] }), CWD);
    expect(out.servers.map(s => s.id)).toEqual(['local-default']);
    expect(out.presets).toHaveLength(1);
    expect(out.presets[0].id).toBe('default');
    expect(out.presets[0].cwd).toBe(CWD); // seeded preset uses the injected cwd
  });

  test('passes provided profiles and defaults through untouched', () => {
    const profile = { id: 'pr', name: 'pr', env: { ANTHROPIC_MODEL: 'm' }, createdAt: now, updatedAt: now };
    const out = normalizeConfig(
      config({ profiles: [profile], servers: [], presets: [], defaults: { profileId: 'pr' } }), CWD);
    expect(out.profiles).toEqual([profile]);
    expect(out.defaults).toEqual({ profileId: 'pr' });
    expect(out.version).toBe(1);
  });

  test('defaults proxies to an empty array when the field is absent', () => {
    const legacy: any = { version: 1, profiles: [], servers: [], presets: [], defaults: {} };
    const out = normalizeConfig(legacy, CWD);
    expect(out.proxies).toEqual([]);
  });

  test('preserves provided proxies untouched', () => {
    const px = { id: 'px', name: 'px', bindPort: 1080, host: 'h', port: 7890, createdAt: now, updatedAt: now };
    const out = normalizeConfig(config({ servers: [], presets: [], proxies: [px] }), CWD);
    expect(out.proxies).toEqual([px]);
  });
});

test.describe('createEmptyConfig', () => {
  test('wires a single local server to a Default preset with continue resume', () => {
    const out = createEmptyConfig('/x');
    expect(out.servers).toHaveLength(1);
    expect(out.servers[0]).toMatchObject({ id: 'local-default', kind: 'local', os: defaultOsFor('local') });

    expect(out.presets).toHaveLength(1);
    expect(out.presets[0]).toMatchObject({
      id: 'default', name: 'Default', serverId: 'local-default', cwd: '/x', resume: 'continue',
    });

    expect(out.defaults).toEqual({ serverId: 'local-default', presetId: 'default' });
  });

  test('seeds an empty proxies array', () => {
    expect(createEmptyConfig('/x').proxies).toEqual([]);
  });

  test('seeds an empty recentLaunches array', () => {
    expect(createEmptyConfig('/x').recentLaunches).toEqual([]);
  });
});

test.describe('normalizeConfig — recentLaunches backfill', () => {
  test('legacy config without recentLaunches gets an empty array', () => {
    const legacy: any = { version: 1, profiles: [], servers: [], presets: [], proxies: [], defaults: {} };
    const out = normalizeConfig(legacy, CWD);
    expect(out.recentLaunches).toEqual([]);
  });

  test('preserves provided recentLaunches untouched', () => {
    const r = { key: 'k1', presetId: 'p', cwd: '/w', presetNameSnapshot: 'P', lastUsedAt: now };
    const out = normalizeConfig(config({ recentLaunches: [r] }), CWD);
    expect(out.recentLaunches).toEqual([r]);
  });
});
