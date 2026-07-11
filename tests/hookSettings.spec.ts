import { test, expect } from '@playwright/test';
import { buildHookSettings, buildCurlCmd } from '../src/server/infrastructure/hook/buildHookSettings.js';

test.describe('buildHookSettings', () => {
  const base = { sessionId: 'abc-123', hookPort: 9876, token: 'tok_secret' };

  test('produces Notification, Stop, and StopFailure hook entries', () => {
    const s = buildHookSettings(base);
    expect(Object.keys(s.hooks).sort()).toEqual(['Notification', 'Stop', 'StopFailure']);
  });

  test('Notification matcher covers idle_prompt and permission_prompt', () => {
    const s = buildHookSettings(base);
    expect(s.hooks.Notification[0].matcher).toBe('idle_prompt,permission_prompt');
  });

  test('Stop and StopFailure matchers are empty (match all)', () => {
    const s = buildHookSettings(base);
    expect(s.hooks.Stop[0].matcher).toBe('');
    expect(s.hooks.StopFailure[0].matcher).toBe('');
  });

  test('URL includes hookPort and sessionId', () => {
    const s = buildHookSettings(base);
    const cmd = s.hooks.Stop[0].hooks[0].command;
    expect(cmd).toContain('http://127.0.0.1:9876/hook/abc-123');
  });

  test('Authorization header includes the token', () => {
    const s = buildHookSettings(base);
    const cmd = s.hooks.Stop[0].hooks[0].command;
    expect(cmd).toContain('Authorization: Bearer tok_secret');
  });

  test('body contains the event kind', () => {
    const s = buildHookSettings(base);
    expect(s.hooks.Notification[0].hooks[0].command).toContain('"kind":"notification"');
    expect(s.hooks.Stop[0].hooks[0].command).toContain('"kind":"stop"');
    expect(s.hooks.StopFailure[0].hooks[0].command).toContain('"kind":"stop_failure"');
  });

  test('linux: uses single-quote noproxy and single-quote body', () => {
    const s = buildHookSettings({ ...base, os: 'linux' });
    const cmd = s.hooks.Stop[0].hooks[0].command;
    expect(cmd).toContain("--noproxy '*'");
    expect(cmd).toMatch(/-d '\{/);
  });

  test('windows: uses double-quote noproxy and escaped double-quote body', () => {
    const s = buildHookSettings({ ...base, os: 'windows' });
    const cmd = s.hooks.Stop[0].hooks[0].command;
    expect(cmd).toContain('--noproxy "*"');
    expect(cmd).toContain('-d "{\\"kind\\":\\"stop\\"}"');
  });

  test('macos uses same quoting as linux', () => {
    const linux = buildHookSettings({ ...base, os: 'linux' });
    const mac = buildHookSettings({ ...base, os: 'macos' });
    expect(mac.hooks.Stop[0].hooks[0].command).toBe(linux.hooks.Stop[0].hooks[0].command);
  });

  test('all hook entries have type "command"', () => {
    const s = buildHookSettings(base);
    for (const entries of Object.values(s.hooks)) {
      for (const entry of entries) {
        for (const h of entry.hooks) {
          expect(h.type).toBe('command');
        }
      }
    }
  });

  test('output is valid JSON-serializable', () => {
    const s = buildHookSettings(base);
    const json = JSON.stringify(s);
    expect(() => JSON.parse(json)).not.toThrow();
  });
});

test.describe('buildCurlCmd', () => {
  test('always includes -sS (silent but show errors)', () => {
    const cmd = buildCurlCmd('http://x', 'tok', 'linux', 'stop');
    expect(cmd).toContain('curl -sS');
  });

  test('POST method is explicit', () => {
    const cmd = buildCurlCmd('http://x', 'tok', 'linux', 'stop');
    expect(cmd).toContain('-X POST');
  });

  test('Content-Type is application/json', () => {
    const cmd = buildCurlCmd('http://x', 'tok', 'linux', 'stop');
    expect(cmd).toContain('Content-Type: application/json');
  });

  test('token with special chars is passed verbatim in header', () => {
    const cmd = buildCurlCmd('http://x', 'tok$pecial&chars', 'linux', 'stop');
    expect(cmd).toContain('Bearer tok$pecial&chars');
  });

  test('noproxy bypasses proxy for loopback regardless of env', () => {
    const cmd = buildCurlCmd('http://127.0.0.1:1234/hook/s', 'tok', 'linux', 'notification');
    expect(cmd).toContain("--noproxy '*'");
  });
});
