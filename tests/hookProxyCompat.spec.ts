import { test, expect } from '@playwright/test';
import { buildCurlCmd, buildHookSettings } from '../src/server/infrastructure/hook/buildHookSettings.js';

/**
 * Proxy compatibility tests.
 *
 * The hook curl command must always bypass any HTTPS_PROXY / HTTP_PROXY that
 * cc-remote injects into the session env for the user's LLM traffic.  If it
 * doesn't, curl routes the loopback POST through the user's proxy (which
 * lives on a different machine) and the POST fails silently.
 *
 * We can't run a real curl here, so we verify the flag is present in the
 * command string and that its value prevents proxy routing for all addresses
 * curl would otherwise honour.
 */

test.describe('proxy compatibility: --noproxy in generated curl command', () => {
  test('linux: --noproxy uses single-quotes wrapping *', () => {
    const cmd = buildCurlCmd('http://127.0.0.1:9000/hook/s', 'tok', 'linux', 'stop');
    // curl --noproxy '*' disables proxy for all hosts when HTTPS_PROXY is set
    expect(cmd).toContain("--noproxy '*'");
  });

  test('macos: same --noproxy form as linux', () => {
    const cmd = buildCurlCmd('http://127.0.0.1:9000/hook/s', 'tok', 'macos', 'stop');
    expect(cmd).toContain("--noproxy '*'");
  });

  test('windows: --noproxy uses double-quotes wrapping *', () => {
    const cmd = buildCurlCmd('http://127.0.0.1:9000/hook/s', 'tok', 'windows', 'stop');
    // On Windows the shell doesn't strip single quotes so double-quotes are used
    expect(cmd).toContain('--noproxy "*"');
  });

  test('--noproxy appears BEFORE the URL so curl processes it regardless of argument order', () => {
    const cmd = buildCurlCmd('http://127.0.0.1:9000/hook/s', 'tok', 'linux', 'stop');
    const noproxyIdx = cmd.indexOf('--noproxy');
    const urlIdx = cmd.lastIndexOf('http://');
    expect(noproxyIdx).toBeGreaterThan(-1);
    expect(urlIdx).toBeGreaterThan(-1);
    expect(noproxyIdx).toBeLessThan(urlIdx);
  });

  test('command targets loopback (127.0.0.1) so OS-level proxy bypass also applies', () => {
    const cmd = buildCurlCmd('http://127.0.0.1:54321/hook/sess-abc', 'tok', 'linux', 'stop');
    expect(cmd).toContain('http://127.0.0.1:54321');
  });

  test('when HTTPS_PROXY is set in env, curl still should not route via it — noproxy covers *', () => {
    // Simulate what happens when process.env has a proxy:
    // buildCurlCmd must always include --noproxy '*' regardless of env.
    const origProxy = process.env.HTTPS_PROXY;
    try {
      process.env.HTTPS_PROXY = 'http://proxy.example.com:8080';
      const cmd = buildCurlCmd('http://127.0.0.1:9000/hook/s', 'tok', 'linux', 'stop');
      expect(cmd).toContain("--noproxy '*'");
    } finally {
      if (origProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = origProxy;
    }
  });
});

test.describe('proxy compatibility: generated settings use hook-specific loopback, not proxy URL', () => {
  test('hook URL is always 127.0.0.1 (loopback), not the proxy host', () => {
    const s = buildHookSettings({ sessionId: 'sess', hookPort: 7000, token: 'tok', os: 'linux' });
    const allCmds = [
      s.hooks.Notification[0].hooks[0].command,
      s.hooks.Stop[0].hooks[0].command,
      s.hooks.StopFailure[0].hooks[0].command,
    ];
    for (const cmd of allCmds) {
      // The POST URL must be loopback, never an external host
      expect(cmd).toContain('http://127.0.0.1:7000');
      expect(cmd).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
    }
  });

  test('hook port in URL matches hookPort param (not a hard-coded port that could conflict with proxy bindPort)', () => {
    const s1 = buildHookSettings({ sessionId: 's1', hookPort: 12345, token: 'tok' });
    const s2 = buildHookSettings({ sessionId: 's2', hookPort: 54321, token: 'tok' });
    expect(s1.hooks.Stop[0].hooks[0].command).toContain(':12345/');
    expect(s2.hooks.Stop[0].hooks[0].command).toContain(':54321/');
  });
});
