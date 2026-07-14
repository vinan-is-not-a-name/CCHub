import { test, expect } from '@playwright/test';
import { buildHookSettings, buildCurlCmd } from '../src/server/infrastructure/hook/buildHookSettings.js';

test.describe('buildHookSettings', () => {
  const base = { sessionId: 'abc-123', hookPort: 9876, token: 'tok_secret' };

  test('produces UserPromptSubmit, Notification, Stop, and StopFailure hook entries', () => {
    const s = buildHookSettings(base);
    expect(Object.keys(s.hooks).sort()).toEqual(['Notification', 'Stop', 'StopFailure', 'UserPromptSubmit']);
  });

  test('UserPromptSubmit matcher is empty (match all) and carries the turn-start kind', () => {
    const s = buildHookSettings(base);
    expect(s.hooks.UserPromptSubmit[0].matcher).toBe('');
    expect(s.hooks.UserPromptSubmit[0].hooks[0].command).toContain('?kind=user_prompt_submit');
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

  test('command carries the event kind as a query param', () => {
    const s = buildHookSettings(base);
    expect(s.hooks.Notification[0].hooks[0].command).toContain('?kind=notification');
    expect(s.hooks.Stop[0].hooks[0].command).toContain('?kind=stop');
    expect(s.hooks.StopFailure[0].hooks[0].command).toContain('?kind=stop_failure');
  });

  test('kind is a query param, not a JSON body (no shell-quoting hazard)', () => {
    const s = buildHookSettings({ ...base, os: 'windows' });
    const cmd = s.hooks.Stop[0].hooks[0].command;
    expect(cmd).not.toContain('-d ');
    expect(cmd).not.toContain('Content-Type');
  });

  test('linux: bare curl, single-quote noproxy, single-quoted url', () => {
    const s = buildHookSettings({ ...base, os: 'linux' });
    const cmd = s.hooks.Stop[0].hooks[0].command;
    expect(cmd).toMatch(/^curl -sS/);
    expect(cmd).toContain("--noproxy '*'");
    expect(cmd).toContain("'http://127.0.0.1:9876/hook/abc-123?kind=stop'");
  });

  test('windows: curl.exe (bypasses PowerShell alias), double-quote noproxy, double-quoted url', () => {
    const s = buildHookSettings({ ...base, os: 'windows' });
    const cmd = s.hooks.Stop[0].hooks[0].command;
    expect(cmd).toMatch(/^curl\.exe -sS/);
    expect(cmd).toContain('--noproxy "*"');
    expect(cmd).toContain('"http://127.0.0.1:9876/hook/abc-123?kind=stop"');
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

  test('kind travels as a query param with no JSON body', () => {
    const cmd = buildCurlCmd('http://x/hook/s', 'tok', 'linux', 'stop');
    expect(cmd).toContain('http://x/hook/s?kind=stop');
    expect(cmd).not.toContain('-d ');
    expect(cmd).not.toContain('Content-Type');
  });

  test('windows uses curl.exe to dodge the PowerShell curl→Invoke-WebRequest alias', () => {
    const cmd = buildCurlCmd('http://x/hook/s', 'tok', 'windows', 'stop');
    expect(cmd).toMatch(/^curl\.exe /);
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
