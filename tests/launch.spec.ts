import { test, expect } from '@playwright/test';
import { resolveLaunch } from '../src/server/application/launch.js';
import { ConfigService } from '../src/server/domain/config/ConfigService.js';
import type { ConfigRepository } from '../src/server/domain/config/ConfigRepository.js';
import type { StoredConfig } from '../src/server/domain/config/schema.js';
import type { LocalServerProfile, SshServerProfile, AnthropicEnvProfile, LaunchPreset, ProxyConfig } from '../src/shared/protocol.js';

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
function profile(id: string, env: AnthropicEnvProfile['env'] = {}): AnthropicEnvProfile {
  return { id, name: id, env, createdAt: now, updatedAt: now };
}
function preset(id: string, overrides: Partial<LaunchPreset> = {}): LaunchPreset {
  return { id, name: id, serverId: '', cwd: '/work', createdAt: now, updatedAt: now, ...overrides };
}
function proxy(id: string, overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return { id, name: id, bindPort: 1080, host: '192.0.2.42', port: 7890, createdAt: now, updatedAt: now, ...overrides };
}

function makeService(initial: Partial<StoredConfig>): ConfigService {
  const data: StoredConfig = { version: 1, profiles: [], servers: [], presets: [], proxies: [], defaults: {}, recentLaunches: [], ...initial };
  const repo: ConfigRepository = { loadOrCreate: () => ({ data, created: false }), save: () => {} };
  return new ConfigService(repo, '/test-cwd');
}

test.describe('resolveLaunch', () => {
  test('layers launch > preset > defaults for server/profile/cwd', () => {
    const local = localServer('local'), ssh = sshServer('ssh');
    const p1 = profile('p1'), p2 = profile('p2');
    const pre = preset('pre', { serverId: 'local', anthropicProfileId: 'p1', cwd: '/preset' });
    const svc = makeService({
      servers: [local, ssh], profiles: [p1, p2], presets: [pre],
      defaults: { serverId: 'ssh', presetId: 'pre', profileId: 'p2' },
    });
    const r = resolveLaunch({ launch: { serverId: 'ssh', anthropicProfileId: 'p2', cwd: '/override' } }, svc);
    expect(r.server.id).toBe('ssh');
    expect(r.profileName).toBe('p2');
    expect(r.cwd).toBe('/override');
    expect(r.label).toBe('ssh:/override');
  });

  test('falls through to preset then defaults when no launch override', () => {
    const local = localServer('local');
    const p1 = profile('p1');
    const pre = preset('pre', { serverId: 'local', anthropicProfileId: 'p1', cwd: '/preset', resume: 'continue' });
    const svc = makeService({ servers: [local], profiles: [p1], presets: [pre], defaults: { presetId: 'pre' } });
    // Preset is opt-in — the caller must name it. defaults.presetId no
    // longer auto-applies (that fallback made every "custom" launch inherit
    // the first preset the user ever created).
    const r = resolveLaunch({ presetId: 'pre' }, svc);
    expect(r.server.id).toBe('local');
    expect(r.profileName).toBe('p1');
    expect(r.cwd).toBe('/preset');
    expect(r.presetName).toBe('pre');
    expect(r.resume).toBe('continue');
  });

  test('ignores defaults.presetId when the caller passes no presetId (truly custom)', () => {
    const local = localServer('local');
    const pre = preset('pre', { serverId: 'local', anthropicProfileId: 'p1', cwd: '/preset' });
    const svc = makeService({ servers: [local], presets: [pre], defaults: { presetId: 'pre', serverId: 'local' } });
    const r = resolveLaunch({ launch: { cwd: '/override' } }, svc);
    expect(r.presetName).toBeUndefined();
    expect(r.cwd).toBe('/override');
  });

  test('throws when cwd resolves to nothing', () => {
    const local = localServer('local');
    const svc = makeService({ servers: [local], defaults: { serverId: 'local' } });
    expect(() => resolveLaunch({}, svc)).toThrow('cwd is required');
  });

  test('rejects an invalid conda env', () => {
    const local = localServer('local');
    const svc = makeService({ servers: [local], defaults: { serverId: 'local' } });
    expect(() => resolveLaunch({ launch: { cwd: '/work', condaEnv: 'bad name!' } }, svc)).toThrow('invalid conda env');
  });

  test('merges profile env over process env without dropping process keys', () => {
    const local = localServer('local');
    const p1 = profile('p1', { ANTHROPIC_MODEL: 'sonnet' });
    const svc = makeService({ servers: [local], profiles: [p1], defaults: { serverId: 'local', profileId: 'p1' } });
    const r = resolveLaunch({ launch: { cwd: '/work' } }, svc);
    expect(r.env.ANTHROPIC_MODEL).toBe('sonnet');
    expect(r.env.PATH ?? r.env.Path).toBeDefined();
  });

  test('SSH preset with a proxy resolves the tunnel and injects proxy env', () => {
    const ssh = sshServer('ssh');
    const px = proxy('px1', { bindPort: 1080 });
    const pre = preset('pre', { serverId: 'ssh', cwd: '/work', proxyId: 'px1' });
    const svc = makeService({ servers: [ssh], proxies: [px], presets: [pre], defaults: { presetId: 'pre' } });
    const r = resolveLaunch({ presetId: 'pre' }, svc);
    expect(r.proxy).toEqual({ bindPort: 1080, host: '192.0.2.42', port: 7890 });
    expect(r.env.HTTPS_PROXY).toBe('http://127.0.0.1:1080');
    expect(r.env.HTTP_PROXY).toBe('http://127.0.0.1:1080');
    expect(r.env.https_proxy).toBe('http://127.0.0.1:1080');
    expect(r.env.NO_PROXY).toContain('127.0.0.1');
  });

  test('local preset with a proxy drops the tunnel and injects no proxy env', () => {
    const local = localServer('local');
    const px = proxy('px1');
    const pre = preset('pre', { serverId: 'local', cwd: '/work', proxyId: 'px1' });
    const svc = makeService({ servers: [local], proxies: [px], presets: [pre], defaults: { presetId: 'pre' } });
    const r = resolveLaunch({ presetId: 'pre' }, svc);
    expect(r.proxy).toBeUndefined();
    expect(r.env.HTTPS_PROXY).toBeUndefined();
  });

  test('passes skipPermissions through from the preset', () => {
    const local = localServer('local');
    const pre = preset('pre', { serverId: 'local', cwd: '/work', skipPermissions: true });
    const svc = makeService({ servers: [local], presets: [pre], defaults: { presetId: 'pre' } });
    const r = resolveLaunch({ presetId: 'pre' }, svc);
    expect(r.skipPermissions).toBe(true);
  });

  test('passes effort through from the preset', () => {
    const local = localServer('local');
    const pre = preset('pre', { serverId: 'local', cwd: '/work', effort: 'medium' });
    const svc = makeService({ servers: [local], presets: [pre], defaults: { presetId: 'pre' } });
    const r = resolveLaunch({ presetId: 'pre' }, svc);
    expect(r.effort).toBe('medium');
  });

  test('effort is undefined when preset has none', () => {
    const local = localServer('local');
    const pre = preset('pre', { serverId: 'local', cwd: '/work' });
    const svc = makeService({ servers: [local], presets: [pre], defaults: { presetId: 'pre' } });
    const r = resolveLaunch({ presetId: 'pre' }, svc);
    expect(r.effort).toBeUndefined();
  });

  test('launch override skipPermissions takes precedence over preset', () => {
    const local = localServer('local');
    const pre = preset('pre', { serverId: 'local', cwd: '/work', skipPermissions: false });
    const svc = makeService({ servers: [local], presets: [pre], defaults: { presetId: 'pre' } });
    const r = resolveLaunch({ presetId: 'pre', launch: { skipPermissions: true } }, svc);
    expect(r.skipPermissions).toBe(true);
  });

  test('launch override effort takes precedence over preset', () => {
    const local = localServer('local');
    const pre = preset('pre', { serverId: 'local', cwd: '/work', effort: 'medium' });
    const svc = makeService({ servers: [local], presets: [pre], defaults: { presetId: 'pre' } });
    const r = resolveLaunch({ presetId: 'pre', launch: { effort: 'max' } }, svc);
    expect(r.effort).toBe('max');
  });

  test('launch override proxyId takes precedence over preset for SSH', () => {
    const ssh = sshServer('ssh');
    const px1 = proxy('px1', { bindPort: 1080 });
    const px2 = proxy('px2', { bindPort: 2080, host: '10.0.0.1', port: 9999 });
    const pre = preset('pre', { serverId: 'ssh', cwd: '/work', proxyId: 'px1' });
    const svc = makeService({ servers: [ssh], proxies: [px1, px2], presets: [pre], defaults: { presetId: 'pre' } });
    const r = resolveLaunch({ presetId: 'pre', launch: { proxyId: 'px2' } }, svc);
    expect(r.proxy).toEqual({ bindPort: 2080, host: '10.0.0.1', port: 9999 });
  });
});
