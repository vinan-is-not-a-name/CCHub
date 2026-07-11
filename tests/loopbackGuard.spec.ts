import { test, expect } from '@playwright/test';
import Fastify from 'fastify';
import { isLoopbackAddress, loopbackGuardHtml, registerLoopbackGuard } from '../src/server/entry/loopbackGuard.js';

// The loopback guard is cchub's front-door enforcement of the single-user
// local-first deployment model: every non-127.0.0.1 request gets a 403
// with an HTML page pointing at the SSH-tunnel path.
// Testing the predicate + a real Fastify roundtrip covers the two axes that
// break in practice — the shape of the address Node reports, and the "hook
// runs before every route" guarantee.

test.describe('isLoopbackAddress', () => {
  test('recognizes the three loopback shapes Node reports', () => {
    // IPv4 and IPv6 loopback both need to work, plus the IPv4-mapped-IPv6
    // form dual-stack sockets return when the connection came in over IPv6
    // but the process bound v4.
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
  });

  test('rejects every non-loopback address', () => {
    // LAN, private, and public — none of them are the user's own machine,
    // so all three need to be rejected. Includes 127.0.0.2 to prove we're
    // exact-matching, not doing a /8 prefix check.
    expect(isLoopbackAddress('192.168.1.42')).toBe(false);
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
    expect(isLoopbackAddress('8.8.8.8')).toBe(false);
    expect(isLoopbackAddress('127.0.0.2')).toBe(false);
  });

  test('rejects missing address — errs safe', () => {
    // Absent remoteAddress can happen for synthetic requests or unix sockets;
    // treating it as non-loopback is the safe default.
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress(null)).toBe(false);
    expect(isLoopbackAddress('')).toBe(false);
  });
});

test.describe('loopbackGuardHtml', () => {
  test('mentions the single-user model and points at the SSH-tunnel recipe', () => {
    // The page is what users land on when they hit a misconfigured deployment;
    // it has to name the model (so they can search for it) and give them the
    // exact command that fixes their situation.
    const html = loopbackGuardHtml();
    expect(html).toContain('single-user');
    expect(html).toContain('ssh -L');
  });
});

test.describe('registerLoopbackGuard', () => {
  async function buildGuardedApp() {
    const app = Fastify();
    registerLoopbackGuard(app);
    // A trivial route so we can prove the guard fires *before* the handler.
    app.get('/probe', async () => ({ ok: true }));
    return app;
  }

  test('lets loopback requests through to the route handler', async () => {
    const app = await buildGuardedApp();
    // Fastify inject defaults remoteAddress to 127.0.0.1, so this is the
    // baseline: the probe route runs and returns its JSON.
    const res = await app.inject({ method: 'GET', url: '/probe' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });

  test('rejects LAN requests with 403 + HTML payload before the route runs', async () => {
    const app = await buildGuardedApp();
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      remoteAddress: '192.168.1.42',
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain('text/html');
    // The page body has to be the explanation, not JSON error — otherwise
    // browsers just show a bare "403 Forbidden" and users can't figure out
    // what to do.
    expect(res.body).toContain('single-user');
    expect(res.body).toContain('ssh -L');
    await app.close();
  });

  test('the same 403 applies to arbitrary routes — the hook runs on every request', async () => {
    const app = await buildGuardedApp();
    // Even a path that has no matching route gets guarded before the 404
    // fires, because onRequest runs upstream of routing.
    const res = await app.inject({
      method: 'POST',
      url: '/anything/else',
      remoteAddress: '10.0.0.1',
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('single-user');
    await app.close();
  });

  test('IPv6 loopback and IPv4-mapped-IPv6 loopback both pass', async () => {
    // Real IPv6 sockets show up as ::1 or ::ffff:127.0.0.1 — the guard has
    // to let those through or IPv6-enabled clients hit a false 403.
    for (const addr of ['::1', '::ffff:127.0.0.1']) {
      const app = await buildGuardedApp();
      const res = await app.inject({
        method: 'GET',
        url: '/probe',
        remoteAddress: addr,
      });
      expect(res.statusCode, `loopback shape ${addr} should pass`).toBe(200);
      await app.close();
    }
  });
});
