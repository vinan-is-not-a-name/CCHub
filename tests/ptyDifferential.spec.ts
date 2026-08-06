import { test, expect } from '@playwright/test';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { SshChannel } from '../src/server/infrastructure/transport/connector.js';
import { normalizeTerminalEnv } from '../src/shared/envKeys.js';
import { renderGrid, liveFrame, visibleCells, findRow, renderedWidth, type Grid } from './support/grid.js';

const FIXTURE_DIR = join(fileURLToPath(import.meta.url), '..', 'fixtures', 'pty');

/**
 * Differential / metamorphic tests: the oracle is a relation, not an expectation.
 *
 * Every other spec in this suite says "given input X, the output must be Y",
 * where Y is a value I wrote down. That works right up until my idea of Y is
 * itself the bug — which is what happened in all seven recent fixes. Here the
 * assertions instead say "these two runs must agree", and neither side of the
 * comparison is authored by me:
 *
 *   - the same bytes delivered whole vs. split at every offset
 *   - the same launch env with and without a host terminal variable
 *   - the same capture rendered at the width cc was told vs. a different width
 *
 * A metamorphic assertion generalizes in a way a hand-picked case cannot. The
 * chunk-boundary sweep does not test "the boundary I thought of" (`之` split
 * after one byte, in connectorDecode.spec.ts) — it tests EVERY boundary in a
 * real capture, which is how it also covers the splits I would not have
 * imagined.
 */

function loadRaw(file: string): Buffer {
  return readFileSync(join(FIXTURE_DIR, file));
}

/** Feed `chunks` through a real SshChannel and return the decoded text. This is
 * the production decode path; only the ssh2 stream object is a stand-in, and it
 * does nothing but deliver the buffers we hand it. */
function decodeThroughChannel(chunks: Buffer[]): string {
  const stream = new EventEmitter() as EventEmitter & Record<string, unknown>;
  stream.stderr = new EventEmitter();
  stream.write = () => {};
  stream.setWindow = () => {};
  stream.close = () => {};

  const ch = new SshChannel();
  let out = '';
  ch.on('data', (d: string) => { out += d; });
  ch.attachStream(stream as never, new EventEmitter() as never);
  for (const c of chunks) stream.emit('data', c);
  return out;
}

/** Split a buffer at fixed size boundaries. */
function chunkEvery(buf: Buffer, size: number): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, Math.min(i + size, buf.length)));
  return out;
}

const CAPTURES = ['startup-conemu-170x40.raw', 'startup-wt-54x30.raw'];

test.describe('metamorphic: chunk boundaries must not change the decoded text', () => {
  // ssh2 slices its stream at packet boundaries that can fall inside a
  // multibyte char. connectorDecode.spec.ts pins ONE such split, chosen because
  // I had seen it in a log. This sweeps every split of a real capture, so a
  // boundary bug anywhere in the stream is caught whether or not I anticipated
  // the offset — the property, not the example.

  for (const file of CAPTURES) {
    test(`${file}: every fixed-size chunking decodes identically`, () => {
      const buf = loadRaw(file);
      const whole = decodeThroughChannel([buf]);
      expect(whole).not.toContain('�');

      // Sizes chosen to land mid-character at many different offsets; 1 is the
      // adversarial extreme (every byte its own packet).
      for (const size of [1, 2, 3, 5, 7, 8, 13, 16, 31, 64, 97, 256, 1024]) {
        const chunked = decodeThroughChannel(chunkEvery(buf, size));
        expect(chunked, `chunk size ${size} changed the decoded text`).toBe(whole);
      }
    });

    test(`${file}: every single split point decodes identically`, () => {
      const buf = loadRaw(file);
      const whole = decodeThroughChannel([buf]);
      // Exhaustive over split positions: cut the capture in two at offset i for
      // every i. Any offset that lands inside a multibyte sequence is exactly
      // the recorded bug's shape.
      const bad: number[] = [];
      for (let i = 1; i < buf.length; i += 1) {
        const two = decodeThroughChannel([buf.subarray(0, i), buf.subarray(i)]);
        if (two !== whole) bad.push(i);
      }
      expect(bad.slice(0, 20), `split offsets that corrupted the stream: ${bad.length} total`).toEqual([]);
    });
  }

  test('the sweep would catch a naive per-chunk decode', () => {
    // Anti-vacuity: prove the property above is capable of failing. A capture
    // decoded chunk-by-chunk with Buffer.toString (the pre-c26127a behaviour)
    // produces replacement chars — 55 of them in this fixture — so the sweep is
    // testing something real rather than passing because nothing can break.
    const buf = loadRaw('startup-conemu-170x40.raw');
    let naive = '';
    for (const c of chunkEvery(buf, 64)) naive += c.toString('utf8');
    expect(naive).not.toBe(buf.toString('utf8'));
    expect((naive.match(/�/g) ?? []).length).toBeGreaterThan(0);
  });
});

test.describe('metamorphic: host terminal identity must not reach cc', () => {
  // The template for this whole layer. The WT_SESSION leak was found by taking
  // one machine and running it twice, changing only an env var — no golden data,
  // no expectation about what cc would emit, just "these two must agree". That
  // experiment is now a test.

  /** Env vars real terminals export, one entry per launching shell. */
  const HOSTS: Array<[string, Record<string, string>]> = [
    ['Windows Terminal', { WT_SESSION: '177a1758-8055-413f-9e64-3d41ccfc1f21', WT_PROFILE_ID: '{guid}' }],
    ['Cmder / ConEmu', { ConEmuANSI: 'OFF', ConEmuPID: '16180', ConEmuTask: '{cmd::Cmder}' }],
    ['kitty', { TERM: 'xterm-kitty', KITTY_WINDOW_ID: '1' }],
    ['WezTerm', { TERM_PROGRAM: 'WezTerm' }],
    ['tmux', { TMUX: '/tmp/tmux-1000/default,123,0' }],
    ['VS Code', { TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '1.90.0' }],
    ['bare cmd.exe', {}],
  ];

  test('all hosts produce byte-identical launch envs', () => {
    // The relation: whatever launched the server, cc must receive the same
    // terminal identity. Comparing hosts against EACH OTHER (rather than each
    // against a list I wrote) means a newly-invented terminal variable that
    // cc starts reading will break this the moment it changes the outcome.
    const base = { PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: 'sk-x' };
    const envs = HOSTS.map(([name, hostEnv]) => ({
      name,
      env: normalizeTerminalEnv({ ...base, ...hostEnv }),
    }));

    const reference = envs[0]!;
    for (const { name, env } of envs.slice(1)) {
      expect(env, `${name} must present the same identity as ${reference.name}`).toEqual(reference.env);
    }
  });

  test('the non-terminal parts of the env survive untouched', () => {
    // The other half of the relation: the strip must be narrow. A fix that
    // achieved agreement by deleting everything would satisfy the test above.
    const payload = {
      PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: 'sk-x', ANTHROPIC_BASE_URL: 'http://x',
      CLAUDE_CODE_EFFORT_LEVEL: 'high', HTTP_PROXY: 'http://127.0.0.1:1', HOME: '/home/x',
    };
    for (const [name, hostEnv] of HOSTS) {
      const out = normalizeTerminalEnv({ ...payload, ...hostEnv });
      for (const [k, v] of Object.entries(payload)) {
        expect(out[k], `${name} lost ${k}`).toBe(v);
      }
    }
  });

  test('the pre-fix env would have failed this', () => {
    // Anti-vacuity: without the strip, hosts disagree. `{...process.env}` was
    // the old behaviour, modelled here as no normalization at all.
    const wt = { PATH: '/usr/bin', WT_SESSION: 'guid' };
    const conemu = { PATH: '/usr/bin', ConEmuPID: '1' };
    expect(wt).not.toEqual(conemu);
    // And with the strip they agree — the same relation the test above asserts.
    expect(normalizeTerminalEnv(wt)).toEqual(normalizeTerminalEnv(conemu));
  });
});

test.describe('metamorphic: geometry', () => {
  // cc lays its UI out against the cols it was told. Replaying a capture at its
  // own width must produce a coherent screen; replaying it at a different width
  // must not, which is what makes "the client and the PTY agree on cols" a
  // property worth asserting rather than a formality.

  test('a capture replayed at its own width has a closed right border', async () => {
    for (const [file, cols, rows] of [
      ['startup-conemu-170x40.raw', 170, 40],
      ['startup-wt-54x30.raw', 54, 30],
    ] as const) {
      const grid = await renderGrid(liveFrame(readFileSync(join(FIXTURE_DIR, file), 'utf8')), cols, rows);
      const bordered = grid.lines.filter((l) => l.trimEnd().endsWith('│'));
      const widths = new Set(bordered.map((l) => l.trimEnd().length));
      expect(widths.size, `${file} at its own ${cols} cols must have one border column`).toBe(1);
      // And the border sits within the terminal, not past it.
      expect([...widths][0]!).toBeLessThanOrEqual(cols);
    }
  });

  test('replaying at the wrong width visibly breaks the layout', async () => {
    // Anti-vacuity for the test above, and a demonstration that the grid
    // assertions are sensitive to the cols mismatch that the 54-vs-170 report
    // was about. The 170-col capture squeezed into 54 cols must NOT come out
    // looking well-formed.
    const text = liveFrame(readFileSync(join(FIXTURE_DIR, 'startup-conemu-170x40.raw'), 'utf8'));
    const squeezed = await renderGrid(text, 54, 30);
    const bordered = squeezed.lines.filter((l) => l.trimEnd().endsWith('│'));
    const widths = new Set(bordered.map((l) => l.trimEnd().length));
    // Either the borders land in inconsistent columns, or they vanish entirely.
    // Both are "broken"; asserting the disjunction avoids over-fitting to which.
    expect(widths.size === 1 && bordered.length > 2).toBe(false);
  });

  test('content never exceeds the width it was rendered at, at any width', async () => {
    // A property that must hold for every geometry: xterm wraps, so nothing can
    // extend past the right edge no matter how badly the width was chosen.
    const text = liveFrame(readFileSync(join(FIXTURE_DIR, 'startup-conemu-170x40.raw'), 'utf8'));
    for (const cols of [54, 80, 120, 170, 200]) {
      const grid: Grid = await renderGrid(text, cols, 40);
      for (let row = 0; row < grid.rows; row += 1) {
        expect(renderedWidth(grid, row), `row ${row} exceeds ${cols} cols`).toBeLessThanOrEqual(cols);
      }
    }
  });

  test('content is never lost entirely, at any width', async () => {
    // Invariant across the sweep: the frame still renders something. Deliberately
    // NOT "the string 'Claude' is present" — at 54 cols a 170-col frame reflows
    // hard enough to split words across line boundaries, which is correct xterm
    // behaviour, and asserting the text survives verbatim would contradict the
    // previous test (which requires the layout to break at the wrong width).
    // What must hold at every width is that cells still carry glyphs.
    const text = liveFrame(readFileSync(join(FIXTURE_DIR, 'startup-conemu-170x40.raw'), 'utf8'));
    for (const cols of [54, 80, 120, 170, 200]) {
      const grid = await renderGrid(text, cols, 40);
      expect(visibleCells(grid).length, `empty grid at ${cols} cols`).toBeGreaterThan(20);
    }
    // At its own width the text is intact — the reflow above is a consequence of
    // the mismatch, not of the capture being unreadable.
    const own = await renderGrid(text, 170, 40);
    expect(findRow(own, 'Claude Code')).toBeGreaterThanOrEqual(0);
  });
});
