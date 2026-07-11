import { test, expect } from '@playwright/test';
import { loadRuntime } from '../src/server/entry/runtime.js';

// loadRuntime is the boot-time surface that decides where the server binds,
// which SSH target it defaults to, and where to find the auth token.

test('reads the CCHUB_* namespace', () => {
  const r = loadRuntime({
    CCHUB_PORT: '4321',
    CCHUB_HOST: '0.0.0.0',
    CCHUB_AUTH_TOKEN: 'new-token',
    CCHUB_SSH_HOST: 'ssh.example',
    CCHUB_SSH_PORT: '2222',
    CCHUB_SSH_USER: 'alice',
    CCHUB_SSH_PASSWORD: 'pw',
    CCHUB_SSH_KEY: '/keys/id_ed25519',
    CCHUB_SSH_CWD: '/home/alice',
    CCHUB_DEFAULT_TARGET: 'ssh',
  });
  expect(r.port).toBe(4321);
  expect(r.host).toBe('0.0.0.0');
  expect(r.authToken).toBe('new-token');
  expect(r.defaultTarget).toBe('ssh');
  expect(r.ssh).toMatchObject({
    host: 'ssh.example', port: 2222, username: 'alice', password: 'pw',
    privateKeyPath: '/keys/id_ed25519', cwd: '/home/alice',
  });
});

test('defaults hold when the env is empty', () => {
  const r = loadRuntime({});
  expect(r.port).toBe(3000);
  expect(r.host).toBe('127.0.0.1');
  expect(r.authToken).toBe('');
  expect(r.defaultTarget).toBe('local');
  expect(r.ssh.host).toBeUndefined();
  expect(r.ssh.port).toBe(22);
});
