import { test, expect } from '@playwright/test';
import Fastify, { FastifyInstance } from 'fastify';
import { existsSync, readFileSync, statSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePasteImageRouteHandler } from '../src/server/infrastructure/mcp/pasteImageRoute.js';
import { SessionFeeder } from '../src/server/infrastructure/mcp/feedImage.js';
import { FEED_IMAGE_MAX_BYTES } from '../src/shared/mcp.js';

/**
 * The /paste-image route owns one job: turn a posted image blob into a file on
 * disk and hand the path off to the SessionFeeder. We cover the success path
 * end-to-end (bytes round-trip identically, feeder.feed sees the absolute path)
 * and every input-shape rejection: wrong MIME, oversize, empty body, and
 * feeder failure surfacing as 400.
 */

class FakeFeeder implements SessionFeeder {
  fed: { sessionId: string; imagePath: string; opts: { autoSubmit?: boolean } | undefined }[] = [];
  rejectWith: Error | undefined;
  async feed(sessionId: string, imagePath: string, opts?: { autoSubmit?: boolean }): Promise<void> {
    if (this.rejectWith) throw this.rejectWith;
    this.fed.push({ sessionId, imagePath, opts });
  }
}

// Minimal real PNG body — just the 8-byte signature is enough; the route never
// validates the content, only the MIME type.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function buildApp(feeder: SessionFeeder): FastifyInstance {
  const app = Fastify();
  app.addContentTypeParser(/^image\//, { parseAs: 'buffer', bodyLimit: FEED_IMAGE_MAX_BYTES }, (_req, body, done) => {
    done(null, body);
  });
  app.post<{ Params: { sessionId: string } }>('/paste-image/:sessionId', makePasteImageRouteHandler(feeder));
  return app;
}

test.describe('/paste-image/:sessionId', () => {
  test('204 + writes the posted bytes to disk + invokes the feeder with the file path', async () => {
    const feeder = new FakeFeeder();
    const app = buildApp(feeder);
    const res = await app.inject({
      method: 'POST',
      url: '/paste-image/sess-A',
      headers: { 'content-type': 'image/png' },
      payload: PNG_BYTES,
    });
    expect(res.statusCode).toBe(204);
    expect(feeder.fed).toHaveLength(1);
    const fed = feeder.fed[0]!;
    expect(fed.sessionId).toBe('sess-A');
    expect(fed.imagePath).toMatch(/cchub-paste-sess-A-/);
    expect(fed.imagePath.endsWith('.png')).toBe(true);
    expect(existsSync(fed.imagePath)).toBe(true);
    expect(readFileSync(fed.imagePath)).toEqual(PNG_BYTES); // bytes round-trip exactly
    await app.close();
  });

  test('reuses one tmp dir per session across multiple pastes', async () => {
    const feeder = new FakeFeeder();
    const app = buildApp(feeder);
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/paste-image/sess-B',
        headers: { 'content-type': 'image/png' },
        payload: PNG_BYTES,
      });
      expect(res.statusCode).toBe(204);
    }
    const dirs = new Set(feeder.fed.map(f => f.imagePath.replace(/[\\/][^\\/]+$/, '')));
    expect(dirs.size).toBe(1); // single per-session dir
    await app.close();
  });

  test('415 when the content-type is not image/*', async () => {
    const feeder = new FakeFeeder();
    const app = buildApp(feeder);
    const res = await app.inject({
      method: 'POST',
      url: '/paste-image/sess-A',
      headers: { 'content-type': 'text/plain' },
      payload: 'hello',
    });
    expect(res.statusCode).toBe(415);
    expect(feeder.fed).toHaveLength(0);
    await app.close();
  });

  test('415 for image/svg+xml — only the bitmap set feed_image whitelists is allowed', async () => {
    const feeder = new FakeFeeder();
    const app = buildApp(feeder);
    const res = await app.inject({
      method: 'POST',
      url: '/paste-image/sess-A',
      headers: { 'content-type': 'image/svg+xml' },
      payload: '<svg/>',
    });
    expect(res.statusCode).toBe(415);
    await app.close();
  });

  test('accepts image/jpg (browsers sometimes ship this non-standard label) and writes as .jpeg', async () => {
    const feeder = new FakeFeeder();
    const app = buildApp(feeder);
    const res = await app.inject({
      method: 'POST',
      url: '/paste-image/sess-A',
      headers: { 'content-type': 'image/jpg' },
      payload: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    });
    expect(res.statusCode).toBe(204);
    expect(feeder.fed[0]!.imagePath.endsWith('.jpeg')).toBe(true);
    await app.close();
  });

  test('413 when the body would exceed FEED_IMAGE_MAX_BYTES', async () => {
    const feeder = new FakeFeeder();
    const app = buildApp(feeder);
    // The content-type parser's bodyLimit kicks in first — that's the layer we
    // expect to reject (Fastify maps it to 413). Either path (parser or route
    // re-check) is acceptable; the contract is "huge body is refused".
    const oversize = Buffer.alloc(FEED_IMAGE_MAX_BYTES + 1);
    const res = await app.inject({
      method: 'POST',
      url: '/paste-image/sess-A',
      headers: { 'content-type': 'image/png' },
      payload: oversize,
    });
    expect(res.statusCode).toBe(413);
    expect(feeder.fed).toHaveLength(0);
    await app.close();
  });

  test('400 when the body is empty', async () => {
    const feeder = new FakeFeeder();
    const app = buildApp(feeder);
    const res = await app.inject({
      method: 'POST',
      url: '/paste-image/sess-A',
      headers: { 'content-type': 'image/png' },
      payload: Buffer.alloc(0),
    });
    expect(res.statusCode).toBe(400);
    expect(feeder.fed).toHaveLength(0);
    await app.close();
  });

  test('400 when the feeder rejects (session gone, exited, validation, etc.) — bubbles the message up', async () => {
    const feeder = new FakeFeeder();
    feeder.rejectWith = new Error('session has exited; cannot feed image');
    const app = buildApp(feeder);
    const res = await app.inject({
      method: 'POST',
      url: '/paste-image/sess-A',
      headers: { 'content-type': 'image/png' },
      payload: PNG_BYTES,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'session has exited; cannot feed image' });
    await app.close();
  });

  // The user hit Ctrl+V — they own the submit. If the route auto-submitted,
  // the pasted image path would fire off to cc immediately, before the user
  // could type an accompanying prompt. The MCP feed_image path is the only
  // one that auto-submits (the agent behind that call can never press Enter
  // itself). Guarded here so a future refactor can't silently flip the default.
  test('feeds with autoSubmit:false so cc does not send the image before the user hits Enter', async () => {
    const feeder = new FakeFeeder();
    const app = buildApp(feeder);
    const res = await app.inject({
      method: 'POST',
      url: '/paste-image/sess-A',
      headers: { 'content-type': 'image/png' },
      payload: PNG_BYTES,
    });
    expect(res.statusCode).toBe(204);
    expect(feeder.fed[0]!.opts).toEqual({ autoSubmit: false });
    await app.close();
  });

  test('400 when sessionId contains characters outside the UUID alphabet (traversal guard)', async () => {
    // sessionId flows straight into `join(tmpdir(), 'cchub-paste-'+sid+'-')`;
    // without shape validation, `../etc` on Linux (or `..\Windows` on
    // Windows) would let a spoofed request write a file outside tmpdir.
    // The route replies with 400 before hitting the filesystem.
    const feeder = new FakeFeeder();
    const app = buildApp(feeder);
    for (const bad of ['../etc', 'a/b', 'a\\b', 'a b', 'a;b', '']) {
      const res = await app.inject({
        method: 'POST',
        url: `/paste-image/${encodeURIComponent(bad)}`,
        headers: { 'content-type': 'image/png' },
        payload: PNG_BYTES,
      });
      expect(res.statusCode, `sessionId ${JSON.stringify(bad)} should be rejected`).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'invalid session id' });
    }
    expect(feeder.fed).toHaveLength(0); // never reached the feeder
    await app.close();
  });

  test('accepts a UUID-shaped sessionId (the SessionManager format)', async () => {
    // The SessionManager mints IDs via crypto.randomUUID(); the route must
    // continue to accept those or the whole feature breaks. Belt to the
    // above suspenders.
    const feeder = new FakeFeeder();
    const app = buildApp(feeder);
    const res = await app.inject({
      method: 'POST',
      url: '/paste-image/00000000-0000-0000-0000-000000000000',
      headers: { 'content-type': 'image/png' },
      payload: PNG_BYTES,
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  test('does not leak the on-disk path or tmp dir into the response — 204 is bodyless', async () => {
    const feeder = new FakeFeeder();
    const app = buildApp(feeder);
    const res = await app.inject({
      method: 'POST',
      url: '/paste-image/sess-A',
      headers: { 'content-type': 'image/png' },
      payload: PNG_BYTES,
    });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe(''); // nothing about tmp paths surfaces to the client
    await app.close();
  });
});
