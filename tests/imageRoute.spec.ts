import { test, expect } from '@playwright/test';
import Fastify, { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeImageRouteHandler, ImageLookup } from '../src/server/infrastructure/mcp/imageRoute.js';

/**
 * The /image route's contract under test: a request can only resolve images
 * recorded against the session id in the URL (no cross-session reads), the
 * route returns 404 / 410 / 415 cleanly for the lookup states a chip-click can
 * land in, and the bytes on the wire are the file on disk. We drive the
 * handler directly through a throwaway Fastify, not the full app stack —
 * createApp.spec covers the auth wrapper around it.
 */

class FakeSession {
  constructor(private paths: string[]) {}
  getImagePath(n: number): string | undefined { return this.paths[n - 1]; }
}

class FakeLookup implements ImageLookup {
  constructor(private map: Record<string, FakeSession>) {}
  get(id: string) { return this.map[id]; }
}

let dir: string;
let png: string;
let stalePath: string;

test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-imgroute-'));
  png = join(dir, 'shot.png');
  // 8-byte PNG signature so any byte-level assertion has something to grip on.
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  stalePath = join(dir, 'gone.png'); // intentionally never written
});

test.afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function buildApp(lookup: ImageLookup): FastifyInstance {
  const app = Fastify();
  app.get<{ Params: { sessionId: string; index: string } }>(
    '/image/:sessionId/:index',
    makeImageRouteHandler(lookup),
  );
  return app;
}

test.describe('/image/:sessionId/:index', () => {
  test('200 with the image bytes for a recorded path', async () => {
    const app = buildApp(new FakeLookup({ s1: new FakeSession([png]) }));
    const res = await app.inject({ method: 'GET', url: '/image/s1/1' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    // inject() materializes the streamed response into `rawPayload` (Buffer).
    expect(res.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(res.rawPayload.length).toBe(8); // full PNG signature we wrote
    // nosniff instructs the browser to trust our Content-Type header rather
    // than sniffing bytes — belt-and-braces alongside the extension whitelist,
    // so an on-disk file that happens to sniff as text/html could never be
    // executed by the browser.
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    await app.close();
  });

  test('404 when the session id is unknown — sessionId in URL IS the capability', async () => {
    const app = buildApp(new FakeLookup({ s1: new FakeSession([png]) }));
    const res = await app.inject({ method: 'GET', url: '/image/other/1' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  test('404 when the index is out of range — never falls through to another session', async () => {
    const app = buildApp(new FakeLookup({ s1: new FakeSession([png]) }));
    const res = await app.inject({ method: 'GET', url: '/image/s1/9' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  test('404 when the session has no recorded images — happens for chips restored from a resumed cc session', async () => {
    // A resumed cc transcript can render historical `[Image #N]` chips into
    // the buffer whose paths never flowed through this server. The client
    // turns 404 into "从会话中恢复的记录图片不支持显示" — assert the route
    // emits 404 cleanly so that branch is reachable.
    const app = buildApp(new FakeLookup({ s1: new FakeSession([]) }));
    const res = await app.inject({ method: 'GET', url: '/image/s1/1' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  test('410 when the recorded file is gone from disk', async () => {
    const app = buildApp(new FakeLookup({ s1: new FakeSession([stalePath]) }));
    const res = await app.inject({ method: 'GET', url: '/image/s1/1' });
    expect(res.statusCode).toBe(410);
    await app.close();
  });

  test('415 when the recorded path has a non-image extension', async () => {
    const txt = join(dir, 'note.txt');
    writeFileSync(txt, 'x');
    const app = buildApp(new FakeLookup({ s1: new FakeSession([txt]) }));
    const res = await app.inject({ method: 'GET', url: '/image/s1/1' });
    expect(res.statusCode).toBe(415);
    await app.close();
  });

  test('rejects a non-integer index — no crash, just 404', async () => {
    const app = buildApp(new FakeLookup({ s1: new FakeSession([png]) }));
    const res = await app.inject({ method: 'GET', url: '/image/s1/notanumber' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  test('rejects index 0 — the contract is 1-based', async () => {
    const app = buildApp(new FakeLookup({ s1: new FakeSession([png]) }));
    const res = await app.inject({ method: 'GET', url: '/image/s1/0' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  test('cross-session isolation: session A cannot read session B\'s images via A\'s URL', async () => {
    const a = new FakeSession([]);
    const b = new FakeSession([png]);
    const app = buildApp(new FakeLookup({ a, b }));
    const res = await app.inject({ method: 'GET', url: '/image/a/1' });
    expect(res.statusCode).toBe(404); // A has no images — B's path is structurally unreachable
    await app.close();
  });
});
