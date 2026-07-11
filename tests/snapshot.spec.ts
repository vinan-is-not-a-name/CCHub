import { test, expect } from '@playwright/test';
import { maskProfile, maskServer } from '../src/server/domain/config/Snapshot.js';
import type {
  AnthropicEnvProfile,
  LocalServerProfile,
  SshServerProfile,
} from '../src/shared/protocol.js';

// Secret masking is the last gate before config data leaves the server. A
// regression here leaks tokens/passwords to the client, so the boundary
// behavior is asserted directly rather than only inferred from integration.

const now = 1_700_000_000_000;

function profile(env: AnthropicEnvProfile['env']): AnthropicEnvProfile {
  return { id: 'p', name: 'p', env, createdAt: now, updatedAt: now };
}

test.describe('maskProfile', () => {
  test('strips ANTHROPIC_AUTH_TOKEN from env but keeps other keys', () => {
    const safe = maskProfile(profile({ ANTHROPIC_AUTH_TOKEN: 'sk-1234567890', ANTHROPIC_MODEL: 'm' }));
    expect(safe.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    expect(safe.env.ANTHROPIC_MODEL).toBe('m');
    expect(safe.hasAuthToken).toBe(true);
    expect(safe.authTokenPreview).toBe('sk-1...7890'); // first4...last4 for >8 chars
  });

  test('reports no token when ANTHROPIC_AUTH_TOKEN is absent', () => {
    const safe = maskProfile(profile({ ANTHROPIC_MODEL: 'm' }));
    expect(safe.hasAuthToken).toBe(false);
    expect(safe.authTokenPreview).toBeUndefined();
  });

  test('masks a short token (≤8 chars) entirely instead of revealing edges', () => {
    expect(maskProfile(profile({ ANTHROPIC_AUTH_TOKEN: '12345678' })).authTokenPreview).toBe('********');
  });

  test('previews a 9-char token (just over the boundary)', () => {
    expect(maskProfile(profile({ ANTHROPIC_AUTH_TOKEN: '123456789' })).authTokenPreview).toBe('1234...6789');
  });
});

test.describe('maskServer', () => {
  test('passes a local server through unchanged', () => {
    const local: LocalServerProfile = {
      id: 's', name: 's', kind: 'local', os: 'linux', createdAt: now, updatedAt: now,
    };
    expect(maskServer(local)).toEqual(local);
  });

  test('strips password from ssh auth but keeps method, preview, and key path', () => {
    const ssh: SshServerProfile = {
      id: 's', name: 's', kind: 'ssh', os: 'linux', host: 'h', port: 22, username: 'u',
      auth: { method: 'password', password: 'hunter2hunter2', privateKeyPath: '/k' },
      createdAt: now, updatedAt: now,
    };
    const safe = maskServer(ssh);
    expect(safe.kind).toBe('ssh');
    expect(safe.auth).toEqual({
      method: 'password',
      hasPassword: true,
      passwordPreview: 'hunt...ter2', // 'hunter2hunter2' → first4...last4
      privateKeyPath: '/k',
    });
    expect(safe.auth).not.toHaveProperty('password');
  });

  test('reports no password for a key-only ssh server', () => {
    const ssh: SshServerProfile = {
      id: 's', name: 's', kind: 'ssh', os: 'linux', host: 'h', port: 22, username: 'u',
      auth: { method: 'privateKeyPath', privateKeyPath: '/k' },
      createdAt: now, updatedAt: now,
    };
    const safe = maskServer(ssh) as Extract<ReturnType<typeof maskServer>, { kind: 'ssh' }>;
    expect(safe.auth.hasPassword).toBe(false);
    expect(safe.auth.passwordPreview).toBeUndefined();
    expect(safe.auth.privateKeyPath).toBe('/k');
  });
});
