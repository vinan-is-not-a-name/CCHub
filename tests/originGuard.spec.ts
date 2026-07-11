import { test, expect } from '@playwright/test';
import Fastify from 'fastify';
import { isLoopbackOrigin, registerOriginGuard } from '../src/server/entry/originGuard.js';

// The origin guard is the browser-only counterpart of the socket-level
// loopback guard. It catches Cross-Site WebSocket Hijacking (CSWSH): a page
// served from evil.example opens `new WebSocket('ws://127.0.0.1:3000/ws')`,
// so the socket source IS 127.0.0.1 and loopback passes — but the browser
// sends `Origin: https://evil.example` and this hook rejects it.

test.describe('isLoopbackOrigin', () => {
  test('accepts http and https loopback origins on any port', () => {
    expect(isLoopbackOrigin('http://127.0.0.1:3000')).toBe(true);
    expect(isLoopbackOrigin('http://localhost:8080')).toBe(true);
    expect(isLoopbackOrigin('http://[::1]:3000')).toBe(true);
    // A production run over HTTPS on loopback (say, an ssh -L to a tls-fronted
    // dev cluster) still counts — the guard is about origin, not scheme.
    expect(isLoopbackOrigin('https://127.0.0.1:3000')).toBe(true);
  });

  test('rejects any non-loopback origin', () => {
    expect(isLoopbackOrigin('http://evil.example')).toBe(false);
    expect(isLoopbackOrigin('http://192.168.1.42:3000')).toBe(false);
    expect(isLoopbackOrigin('http://10.0.0.1')).toBe(false);
    // Exact match required — 127.0.0.2 is a different address, not a wildcard.
    expect(isLoopbackOrigin('http://127.0.0.2')).toBe(false);
  });

  test('rejects non-http(s) schemes', () => {
    // A `file://`, `chrome-extension://`, or `null` origin should not be
    // treated as loopback even if the URL happens to parse. These are the
    // shapes attacker-controlled pages take (sandboxed iframes send
    // `Origin: null`, extension pages carry a scheme we don't want to trust).
    expect(isLoopbackOrigin('file:///tmp/evil.html')).toBe(false);
    expect(isLoopbackOrigin('chrome-extension://abc/index.html')).toBe(false);
    expect(isLoopbackOrigin('null')).toBe(false);
  });

  test('rejects malformed origins', () => {
    // Anything URL() can't parse is safe to refuse — no valid browser origin
    // fails URL parsing.
    expect(isLoopbackOrigin('not a url')).toBe(false);
    expect(isLoopbackOrigin('')).toBe(false);
  });
});

test.describe('registerOriginGuard', () => {
  async function buildGuardedApp() {
    const app = Fastify();
    registerOriginGuard(app);
    app.get('/probe', async () => ({ ok: true }));
    return app;
  }

  test('lets a request through when there is no Origin header (non-browser caller)', async () => {
    // curl, native ws clients, and same-window navigation don't send Origin.
    // CSWSH is a browser-only vector, so absent Origin passes and downstream
    // auth (Bearer / query token) covers the rest.
    const app = await buildGuardedApp();
    const res = await app.inject({ method: 'GET', url: '/probe' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  test('lets a request through when Origin is a loopback origin', async () => {
    const app = await buildGuardedApp();
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { origin: 'http://127.0.0.1:3000' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  test('rejects with 403 when Origin is cross-site', async () => {
    // The CSWSH shape: connection came from 127.0.0.1 (browser JS on user's
    // own machine), but Origin gives away the actual page URL.
    const app = await buildGuardedApp();
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'origin not allowed' });
    await app.close();
  });

  test('rejects with 403 when Origin is a LAN address', async () => {
    // A neighbouring device on the LAN could try to trick a locally-served
    // page into hitting the port — reject that too.
    const app = await buildGuardedApp();
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { origin: 'http://192.168.1.100:3000' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  test('runs upstream of routing — a 403 fires even on paths that would 404', async () => {
    const app = await buildGuardedApp();
    const res = await app.inject({
      method: 'POST',
      url: '/no-such-route',
      headers: { origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
