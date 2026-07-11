import { test, expect } from '@playwright/test';
import { buildProfile } from '../src/server/domain/config/profileRules.js';
import { buildServer } from '../src/server/domain/config/serverRules.js';
import { buildPreset } from '../src/server/domain/config/presetRules.js';
import { buildProxy } from '../src/server/domain/config/proxyRules.js';
import type { PresetReferenceCheck } from '../src/server/domain/config/presetRules.js';
import type { AnthropicEnvProfile, ProxyConfig, ServerProfile, SshServerProfile } from '../src/shared/protocol.js';

// The rules layer is pure but holds the security/correctness branches that
// integration only touches end-to-end: auth-token three-state, SSH password
// preservation on edit, and preset reference validation. Asserted directly here
// with injected `now`/`refs` so the algorithm — not the full stack — is the SUT.

const now = 1_700_000_000_000;

test.describe('buildProfile — auth-token three-state', () => {
  const existing: AnthropicEnvProfile = {
    id: 'p1', name: 'old', env: { ANTHROPIC_AUTH_TOKEN: 'old-token', ANTHROPIC_MODEL: 'm' },
    createdAt: 1, updatedAt: 2,
  };

  test('a new token in env overrides the existing one', () => {
    const out = buildProfile({ id: 'p1', name: 'n', env: { ANTHROPIC_AUTH_TOKEN: 'new-token' } }, existing, now);
    expect(out.env.ANTHROPIC_AUTH_TOKEN).toBe('new-token');
  });

  test('absent new token preserves the existing token (the no-clobber case)', () => {
    const out = buildProfile({ id: 'p1', name: 'n', env: { ANTHROPIC_MODEL: 'm2' } }, existing, now);
    expect(out.env.ANTHROPIC_AUTH_TOKEN).toBe('old-token');
    expect(out.env.ANTHROPIC_MODEL).toBe('m2');
  });

  test('clearAuthToken drops the existing token even when none is supplied', () => {
    const out = buildProfile({ id: 'p1', name: 'n', env: {}, clearAuthToken: true }, existing, now);
    expect(out.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  test('keeps existing id and createdAt; bumps updatedAt', () => {
    const out = buildProfile({ id: 'ignored', name: 'n', env: {} }, existing, now);
    expect(out.id).toBe('p1');
    expect(out.createdAt).toBe(1);
    expect(out.updatedAt).toBe(now);
  });

  test('new profile (no existing) trims an over-long name to 80 chars', () => {
    const out = buildProfile({ name: 'x'.repeat(200), env: {} }, undefined, now);
    expect(out.name).toHaveLength(80);
  });
});

test.describe('buildServer — local', () => {
  test('passes through and defaults os when omitted', () => {
    const out = buildServer({ id: 'l', name: 'L', kind: 'local' }, undefined, now);
    expect(out).toMatchObject({ id: 'l', kind: 'local' });
    expect(out.os).toBeDefined();
  });
});

test.describe('buildServer — ssh auth', () => {
  const base = { name: 'S', kind: 'ssh' as const, host: 'h', port: 22, username: 'u' };

  test('infers password method from a supplied password', () => {
    const out = buildServer({ ...base, auth: { method: 'password', password: 'pw' } }, undefined, now) as SshServerProfile;
    expect(out.auth).toEqual({ method: 'password', password: 'pw' });
  });

  test('preserves the saved password on edit when none is resupplied', () => {
    const existing: ServerProfile = {
      id: 's', name: 'S', kind: 'ssh', os: 'linux', host: 'h', port: 22, username: 'u',
      auth: { method: 'password', password: 'saved-pw' }, createdAt: 1, updatedAt: 2,
    };
    const out = buildServer({ ...base, id: 's', auth: { method: 'password' } }, existing, now) as SshServerProfile;
    expect(out.auth).toEqual({ method: 'password', password: 'saved-pw' });
  });

  test('clearPassword drops the saved password (and then a password method must error)', () => {
    const existing: ServerProfile = {
      id: 's', name: 'S', kind: 'ssh', os: 'linux', host: 'h', port: 22, username: 'u',
      auth: { method: 'password', password: 'saved-pw' }, createdAt: 1, updatedAt: 2,
    };
    expect(() => buildServer(
      { ...base, id: 's', clearPassword: true, auth: { method: 'password' } }, existing, now,
    )).toThrow('SSH password is required');
  });

  test('throws when password method has no password', () => {
    expect(() => buildServer({ ...base, auth: { method: 'password' } }, undefined, now))
      .toThrow('SSH password is required');
  });

  test('throws when privateKeyPath method has no key path', () => {
    expect(() => buildServer({ ...base, auth: { method: 'privateKeyPath' } }, undefined, now))
      .toThrow('SSH private key path is required');
  });

  test('accepts a key-only server', () => {
    const out = buildServer(
      { ...base, auth: { method: 'privateKeyPath', privateKeyPath: '/k' } }, undefined, now,
    ) as SshServerProfile;
    expect(out.auth).toEqual({ method: 'privateKeyPath', privateKeyPath: '/k' });
  });
});

test.describe('buildPreset — reference validation', () => {
  const allRefs: PresetReferenceCheck = { serverExists: () => true, profileExists: () => true, proxyExists: () => true };

  test('builds a valid preset when references resolve', () => {
    const out = buildPreset({ name: 'P', serverId: 'srv', cwd: '/c' }, undefined, allRefs, now);
    expect(out).toMatchObject({ name: 'P', serverId: 'srv', cwd: '/c' });
  });

  test('throws when serverId is missing', () => {
    expect(() => buildPreset({ name: 'P', cwd: '/c' }, undefined, allRefs, now)).toThrow('serverId is required');
  });

  test('throws "server not found" when the server reference is unknown', () => {
    const refs: PresetReferenceCheck = { serverExists: () => false, profileExists: () => true, proxyExists: () => true };
    expect(() => buildPreset({ name: 'P', serverId: 'ghost', cwd: '/c' }, undefined, refs, now))
      .toThrow('server not found');
  });

  test('throws "profile not found" when anthropicProfileId is unknown', () => {
    const refs: PresetReferenceCheck = { serverExists: () => true, profileExists: () => false, proxyExists: () => true };
    expect(() => buildPreset(
      { name: 'P', serverId: 'srv', cwd: '/c', anthropicProfileId: 'ghost' }, undefined, refs, now,
    )).toThrow('profile not found');
  });

  test('throws "proxy not found" when proxyId is unknown', () => {
    const refs: PresetReferenceCheck = { serverExists: () => true, profileExists: () => true, proxyExists: () => false };
    expect(() => buildPreset(
      { name: 'P', serverId: 'srv', cwd: '/c', proxyId: 'ghost' }, undefined, refs, now,
    )).toThrow('proxy not found');
  });

  test('rejects an illegal conda env name', () => {
    expect(() => buildPreset(
      { name: 'P', serverId: 'srv', cwd: '/c', condaEnv: 'bad name!' }, undefined, allRefs, now,
    )).toThrow('invalid conda env');
  });

  test('stores skipPermissions and proxyId when supplied', () => {
    const out = buildPreset(
      { name: 'P', serverId: 'srv', cwd: '/c', skipPermissions: true, proxyId: 'px1' }, undefined, allRefs, now,
    );
    expect(out.skipPermissions).toBe(true);
    expect(out.proxyId).toBe('px1');
  });

  test('omits skipPermissions when false and proxyId when blank', () => {
    const out = buildPreset(
      { name: 'P', serverId: 'srv', cwd: '/c', skipPermissions: false, proxyId: '' }, undefined, allRefs, now,
    );
    expect(out.skipPermissions).toBeUndefined();
    expect(out.proxyId).toBeUndefined();
  });
});

test.describe('buildProxy', () => {
  test('builds a normalized proxy from a complete input', () => {
    const out = buildProxy({ name: 'Corp', bindPort: 1080, host: '192.0.2.42', port: 7890 }, undefined, now);
    expect(out).toMatchObject({ name: 'Corp', bindPort: 1080, host: '192.0.2.42', port: 7890 });
    expect(out.id).toBeTruthy();
    expect(out.createdAt).toBe(now);
    expect(out.updatedAt).toBe(now);
  });

  test('keeps existing id and createdAt; bumps updatedAt', () => {
    const existing: ProxyConfig = { id: 'px1', name: 'old', bindPort: 1, host: 'h', port: 2, createdAt: 1, updatedAt: 2 };
    const out = buildProxy({ id: 'ignored', name: 'new', bindPort: 1080, host: 'h2', port: 7890 }, existing, now);
    expect(out.id).toBe('px1');
    expect(out.createdAt).toBe(1);
    expect(out.updatedAt).toBe(now);
  });

  test('throws on a missing host', () => {
    expect(() => buildProxy({ name: 'P', bindPort: 1080, host: '', port: 7890 }, undefined, now)).toThrow('host is required');
  });

  test('throws on an out-of-range bind port', () => {
    expect(() => buildProxy({ name: 'P', bindPort: 0, host: 'h', port: 7890 }, undefined, now)).toThrow('invalid port');
  });

  test('throws on an out-of-range proxy port', () => {
    expect(() => buildProxy({ name: 'P', bindPort: 1080, host: 'h', port: 70000 }, undefined, now)).toThrow('invalid port');
  });
});
