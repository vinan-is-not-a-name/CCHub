import { test, expect } from '@playwright/test';
import { writeFileSync, truncateSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { makeSessionFeeder, validateImagePath, FeedTarget, SessionLookup } from '../src/server/infrastructure/mcp/feedImage.js';
import { FEED_IMAGE_MAX_BYTES } from '../src/shared/mcp.js';
import { SessionState, SessionTarget } from '../src/shared/protocol.js';

// feedImage is the narrow capability port between the (untrusted) MCP tool call
// and a session's PTY. These tests drive the pure validator and the feeder's
// gates directly — no HTTP, no real PTY. The contract under test: a feed reaches
// EXACTLY the addressed session's paste() and nothing else, and every guard
// (target kind, lifecycle, path shape) throws an agent-readable message.

// A fake session that records what got pasted, so we can prove the feed lands on
// THIS session's channel and only this one.
class FakeTarget implements FeedTarget {
  pasted: { text: string; opts: { autoSubmit?: boolean } | undefined }[] = [];
  recorded: string[] = [];
  constructor(
    public state: SessionState = 'idle',
    public launch: { server: { kind: SessionTarget }; cwd: string } = { server: { kind: 'local' }, cwd: tmpdir() },
  ) {}
  paste(text: string, opts?: { autoSubmit?: boolean }): void { this.pasted.push({ text, opts }); }
  recordImage(path: string): void { this.recorded.push(path); }
}

class FakeLookup implements SessionLookup {
  constructor(private map: Record<string, FakeTarget>) {}
  get(id: string): FeedTarget | undefined { return this.map[id]; }
}

// Real on-disk fixtures: validateImagePath calls statSync, so the happy path
// needs an actual file. tmpdir keeps it off the project/session tree.
let dir: string;
let goodPng: string;
let oversize: string;

test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-feed-'));
  goodPng = join(dir, 'shot.png');
  writeFileSync(goodPng, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // tiny, valid-enough bytes
  oversize = join(dir, 'huge.png');
  writeFileSync(oversize, '');
  truncateSync(oversize, FEED_IMAGE_MAX_BYTES + 1); // sparse — no 10MB write
});

test.afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test.describe('validateImagePath', () => {
  test('accepts an existing absolute image of allowed type', () => {
    expect(() => validateImagePath(goodPng)).not.toThrow();
  });

  test('rejects empty / non-string', () => {
    expect(() => validateImagePath('')).toThrow(/required/);
    // @ts-expect-error deliberately wrong type — the tool input is untrusted
    expect(() => validateImagePath(undefined)).toThrow(/required/);
  });

  test('rejects a relative path', () => {
    expect(() => validateImagePath('shot.png')).toThrow(/absolute/);
  });

  test('rejects an unsupported extension', () => {
    const txt = join(dir, 'note.txt');
    writeFileSync(txt, 'x');
    expect(() => validateImagePath(txt)).toThrow(/unsupported image type/);
  });

  test('rejects a missing file', () => {
    expect(() => validateImagePath(join(dir, 'nope.png'))).toThrow(/not found/);
  });

  test('rejects a directory masquerading as a path', () => {
    expect(() => validateImagePath(dir)).toThrow(/unsupported image type|not a file/);
  });

  test('rejects a file over the size cap', () => {
    expect(() => validateImagePath(oversize)).toThrow(/too large/);
  });

  test('rejects a path containing embedded newline or NUL', () => {
    // A path shaped like this could never come from a normal filesystem
    // walk, but the field arrives as untrusted JSON so we lock down the
    // shape before it reaches statSync (which would silently truncate at
    // the NUL on some platforms).
    expect(() => validateImagePath('/tmp/evil\nname.png')).toThrow(/control characters/);
    expect(() => validateImagePath('/tmp/evil\x00.png')).toThrow(/control characters/);
  });

  test('with allowedRoots, accepts a path that resolves inside one of them', () => {
    // goodPng lives under `dir`, which we pass as the sole allowed root — so
    // the same file that passes without a whitelist also passes with one.
    expect(() => validateImagePath(goodPng, { allowedRoots: [dir] })).not.toThrow();
  });

  test('with allowedRoots, rejects a path outside every allowed root', () => {
    // Build a sibling tmp dir the caller does NOT list as allowed. The
    // extension / stat / size checks all still pass; only the root-bounding
    // check fires, which is the security-critical guarantee.
    const other = mkdtempSync(join(tmpdir(), 'cc-feed-outside-'));
    try {
      const outside = join(other, 'shot.png');
      writeFileSync(outside, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      expect(() => validateImagePath(outside, { allowedRoots: [dir] }))
        .toThrow(/outside the session's allowed roots/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

test.describe('makeSessionFeeder', () => {
  test('feeds the addressed session and ONLY that session', async () => {
    const a = new FakeTarget();
    const b = new FakeTarget();
    const feeder = makeSessionFeeder(new FakeLookup({ a, b }));
    await feeder.feed('a', goodPng);
    expect(a.pasted.map(p => p.text)).toEqual([goodPng]);
    expect(a.recorded).toEqual([goodPng]); // path logged before paste, so /image route can resolve it later
    expect(b.pasted).toEqual([]); // no cross-session bleed
    expect(b.recorded).toEqual([]);
  });

  test('records every successful feed in order — the index is what /image/:sessionId/:index resolves to', async () => {
    const a = new FakeTarget();
    const feeder = makeSessionFeeder(new FakeLookup({ a }));
    const second = goodPng.replace('.png', '-2.png');
    writeFileSync(second, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await feeder.feed('a', goodPng);
    await feeder.feed('a', second);
    expect(a.recorded).toEqual([goodPng, second]);
    expect(a.pasted.map(p => p.text)).toEqual([goodPng, second]);
  });

  // The MCP feed_image tool is called by an agent that cannot subsequently
  // press Enter, so its paste must auto-submit. The `/paste-image` HTTP route
  // (browser Ctrl+V) passes `{ autoSubmit: false }` so the user can type an
  // accompanying prompt before hitting Enter themselves. Both paths reach
  // ManagedSession.paste through this feeder, so guard both defaults.
  test('forwards no options by default — the MCP feed_image path submits (session.paste default)', async () => {
    const a = new FakeTarget();
    const feeder = makeSessionFeeder(new FakeLookup({ a }));
    await feeder.feed('a', goodPng);
    expect(a.pasted).toEqual([{ text: goodPng, opts: undefined }]);
  });

  test('threads opts through to paste so the /paste-image route can suppress auto-submit', async () => {
    const a = new FakeTarget();
    const feeder = makeSessionFeeder(new FakeLookup({ a }));
    await feeder.feed('a', goodPng, { autoSubmit: false });
    expect(a.pasted).toEqual([{ text: goodPng, opts: { autoSubmit: false } }]);
  });

  test('errors when the session is unknown', async () => {
    const feeder = makeSessionFeeder(new FakeLookup({}));
    await expect(feeder.feed('ghost', goodPng)).rejects.toThrow(/session not found/);
  });

  test('rejects an SSH target (v1 local-only)', async () => {
    const ssh = new FakeTarget('idle', { server: { kind: 'ssh' } });
    const feeder = makeSessionFeeder(new FakeLookup({ ssh }));
    await expect(feeder.feed('ssh', goodPng)).rejects.toThrow(/only supported for local/);
    expect(ssh.pasted).toEqual([]); // gate fires before paste
    expect(ssh.recorded).toEqual([]); // and before record — failed feeds must not pollute the lookup
  });

  test('rejects an exited session', async () => {
    const dead = new FakeTarget('exited');
    const feeder = makeSessionFeeder(new FakeLookup({ dead }));
    await expect(feeder.feed('dead', goodPng)).rejects.toThrow(/exited/);
    expect(dead.pasted).toEqual([]);
    expect(dead.recorded).toEqual([]);
  });

  test('propagates a validation failure without pasting', async () => {
    const a = new FakeTarget();
    const feeder = makeSessionFeeder(new FakeLookup({ a }));
    await expect(feeder.feed('a', 'relative.png')).rejects.toThrow(/absolute/);
    expect(a.pasted).toEqual([]); // bad path never reaches the PTY
    expect(a.recorded).toEqual([]); // ...nor the lookup
  });
});
