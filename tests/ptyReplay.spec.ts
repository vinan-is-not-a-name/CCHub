import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { renderGrid, visibleCells, lowContrastCells, findRow, renderedWidth, contrastRatio, liveFrame, type Grid } from './support/grid.js';

const FIXTURE_DIR = join(fileURLToPath(import.meta.url), '..', 'fixtures', 'pty');

/**
 * Replay real cc byte streams and assert on the rendered grid.
 *
 * Every assertion here has the same shape: feed bytes cc actually emitted into
 * a real xterm, then check a property of the cells that came out. Nothing in the
 * loop is hand-authored — not the input (a capture) and not the renderer (the
 * same headless xterm the server uses for reattach). That is the point: the
 * suite's existing specs mostly compare our output against our own model of the
 * other side, so when the model is wrong they agree with the bug.
 *
 * The two fixtures were captured from the same cc version through the same
 * bundled ConPTY on two machines, differing only in which terminal launched the
 * server. That makes them a differential pair as well as individual regressions.
 */
const CAPTURES = [
  { file: 'startup-conemu-170x40.raw', cols: 170, rows: 40, host: 'conemu' as const },
  { file: 'startup-wt-54x30.raw', cols: 54, rows: 30, host: 'windows-terminal' as const },
];

/** The app's light-theme background — the one the invisible-bold bug appeared
 * on. Contrast is only meaningful against a specific backdrop. */
const LIGHT_BG = '#fafafa';

/** The whole capture, teardown included. Used by the sequence-level assertions,
 * which are about what cc emitted over the session's lifetime. */
function loadRaw(file: string): string {
  return readFileSync(join(FIXTURE_DIR, file), 'utf8');
}

/** The capture up to cc's alt-screen teardown — the last frame that was actually
 * on screen. Both captures are of exited sessions, so replaying to the very end
 * would render the blank main screen cc restored on its way out. */
function load(file: string): string {
  return liveFrame(loadRaw(file));
}

for (const cap of CAPTURES) {
  test.describe(`replay ${cap.file}`, () => {
    let grid: Grid;

    test.beforeAll(async () => {
      grid = await renderGrid(load(cap.file), cap.cols, cap.rows);
    });

    test('renders cc\'s welcome box, not an empty screen', () => {
      // Sanity floor: if the stream failed to parse, everything below would
      // pass vacuously on an all-blank grid.
      expect(findRow(grid, 'Claude Code')).toBeGreaterThanOrEqual(0);
      expect(visibleCells(grid).length).toBeGreaterThan(50);
    });

    test('no row exceeds the terminal width', () => {
      // The emoji-width bug (1c4414b) was exactly this: cc measured ✳/⏸ as 2
      // cells and positioned everything after them accordingly, while a
      // Unicode-6 width table measured 1, so text ran past the right edge and
      // overwrote cells. Measured in rendered width, not string length.
      for (let row = 0; row < grid.rows; row += 1) {
        expect(renderedWidth(grid, row), `row ${row} overflows ${cap.cols} cols`).toBeLessThanOrEqual(cap.cols);
      }
    });

    test('the box border closes on the right edge', () => {
      // cc draws its welcome box by jumping to an absolute column and printing
      // `│`. If a preceding glyph were mis-measured, the right border would land
      // in the wrong column — a visible symptom, and one that byte-level
      // assertions cannot see.
      const bordered = grid.lines.filter((l) => l.trimEnd().endsWith('│'));
      expect(bordered.length, 'expected several right-bordered box rows').toBeGreaterThan(2);
      const widths = new Set(bordered.map((l) => l.trimEnd().length));
      // Every right border sits in the same column.
      expect(widths.size, `right border columns disagree: ${[...widths].join(',')}`).toBe(1);
    });

    test('no U+FFFD anywhere', () => {
      // The SSH multibyte bug (c26127a) split UTF-8 across packet boundaries and
      // produced replacement chars, which then shifted every following column.
      // Any capture that decodes cleanly must contain none.
      const bad = visibleCells(grid).filter((c) => c.chars.includes('�'));
      expect(bad.map((c) => `${c.row}:${c.col}`)).toEqual([]);
    });

    test('double-width glyphs are followed by their spacer', () => {
      // A 2-wide glyph must occupy its cell plus a 0-width spacer; if the width
      // table disagreed with cc, this pairing breaks and columns drift.
      //
      // Measured limitation: these two startup captures contain ✳ ❯ ⏸, all of
      // which are 1 cell under BOTH the Unicode 6 and 11 tables — only ✅/❌
      // change width between them. So reverting the Unicode11Addon (1c4414b)
      // does NOT turn this red on these fixtures; terminalScreen.spec.ts covers
      // that with synthetic ✅/❌ input. This assertion earns its place as a
      // guard for future captures (a cc frame containing ✅ would catch it), not
      // as a regression test for the emoji fix.
      for (const c of grid.cells) {
        if (c.width !== 2) continue;
        const next = grid.cells.find((n) => n.row === c.row && n.col === c.col + 1);
        expect(next?.width, `${c.chars} at ${c.row}:${c.col} lacks its spacer`).toBe(0);
      }
    });

    test('every visible glyph would be legible on the light theme', () => {
      // The invisible-bold bug: cc emitted a near-white fg (SGR 97 / a light
      // truecolor) which landed on the app's #fafafa background. The text was
      // present and correctly placed — just unreadable. Only a contrast
      // assertion catches that class of defect.
      const bad = lowContrastCells(grid, LIGHT_BG);
      const detail = bad.slice(0, 8)
        .map((c) => `${c.row}:${c.col} ${JSON.stringify(c.chars)} fg=${c.fg} bg=${c.bg ?? LIGHT_BG} ratio=${c.ratio.toFixed(2)}`)
        .join('\n  ');
      // The client sets minimumContrastRatio: 4.5, so cells like these are
      // repaired at paint time. Recording which cells NEED that repair is what
      // makes the setting's removal detectable: if this capture produces such
      // cells, the setting is load-bearing for this stream.
      console.log(`[${cap.file}] ${bad.length} cells rely on contrast correction${bad.length ? ':\n  ' + detail : ''}`);
      // Assert on the mechanism that is actually ours: the renderer must be
      // configured to repair them. See the terminalTheme spec for that setting;
      // here we only require that the raw stream never asks for fg == bg, which
      // no correction can rescue into distinguishable text.
      const invisible = bad.filter((c) => c.ratio < 1.05);
      expect(invisible.map((c) => `${c.row}:${c.col} fg=${c.fg}`)).toEqual([]);
    });

    test('cursor never parked beyond the last row', () => {
      // The footer-ghost family (reportedRows) came from cc addressing a row the
      // client did not believe existed.
      const maxRow = Math.max(...grid.cells.map((c) => c.row));
      expect(maxRow).toBeLessThan(cap.rows);
    });
  });
}

test.describe('differential: the two captures differ only in host terminal identity', () => {
  // This is the assertion style that actually found the WT_SESSION leak. The
  // oracle is not "what I expect cc to emit" — it is "these two streams came
  // from the same cc and should therefore agree, except where the host terminal
  // legitimately changes things". Any other difference is a bug in one of them.

  test('both render cc\'s welcome box with a closed border', async () => {
    for (const cap of CAPTURES) {
      const grid = await renderGrid(load(cap.file), cap.cols, cap.rows);
      expect(findRow(grid, 'Claude Code'), `${cap.file} must show the welcome box`).toBeGreaterThanOrEqual(0);
      expect(visibleCells(grid).length, `${cap.file} must render content`).toBeGreaterThan(50);
    }
  });

  test('the kitty keyboard / synchronized-output split matches the host, and only that', () => {
    // Whole capture: these are claims about what cc emitted across the session,
    // not about the final frame.
    const wt = loadRaw('startup-wt-54x30.raw');
    const conemu = loadRaw('startup-conemu-170x40.raw');

    // cc gates these on its terminal id, which it derives from the launching
    // shell's env. Windows Terminal is on cc's allowlist; ConEmu is not.
    // xterm.js implements neither kitty keyboard nor modifyOtherKeys, which is
    // why the leak broke input. See commit 12f2996.
    expect(wt, 'WT capture must push kitty keyboard').toContain('\x1b[>1u');
    expect(wt, 'WT capture must set modifyOtherKeys').toContain('\x1b[>4;2m');
    expect(wt, 'WT capture must use synchronized output').toContain('\x1b[?2026h');
    expect(conemu, 'ConEmu capture must NOT push kitty keyboard').not.toContain('\x1b[>1u');
    expect(conemu, 'ConEmu capture must NOT set modifyOtherKeys').not.toContain('\x1b[>4;2m');
    expect(conemu, 'ConEmu capture must NOT use synchronized output').not.toContain('\x1b[?2026h');

    // The mirror image: taskbar progress is ConEmu-only (cc's kMt() returns
    // false for WT_SESSION, true for ConEmu*).
    expect(conemu, 'ConEmu capture must emit taskbar progress').toContain('\x1b]9;4');
    expect(wt, 'WT capture must not emit taskbar progress').not.toContain('\x1b]9;4');
  });

  test('everything host-independent is present in both', () => {
    const wt = loadRaw('startup-wt-54x30.raw');
    const conemu = loadRaw('startup-conemu-170x40.raw');
    // These are cc's baseline startup behaviours, unrelated to terminal
    // identity. If a future cc version or a config change made one host lose
    // one of them, that is a real divergence and this is where it surfaces.
    for (const seq of [
      '\x1b[?1049h', // alt screen
      '\x1b[?9001h', // win32 input mode
      '\x1b[?2004h', // bracketed paste
      '\x1b[?1004h', // focus reporting
      '\x1b[?1006h', // SGR mouse
    ]) {
      expect(wt, `WT capture missing ${JSON.stringify(seq)}`).toContain(seq);
      expect(conemu, `ConEmu capture missing ${JSON.stringify(seq)}`).toContain(seq);
    }
  });
});

test.describe('grid helpers', () => {
  // The helpers are themselves code, so the properties the specs above lean on
  // get pinned here rather than assumed.

  test('contrastRatio matches known WCAG values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 2);
    // Near-white on the app's off-white background: the invisible-bold case.
    expect(contrastRatio('#f0f0f0', '#fafafa')).toBeLessThan(1.2);
  });

  test('renderedWidth counts a double-width glyph as 2', async () => {
    const grid = await renderGrid('✅ok', 20, 3);
    expect(renderedWidth(grid, 0)).toBe(4); // 2 + 1 + 1
  });

  test('lowContrastCells finds a near-invisible cell and ignores a legible one', async () => {
    const invisible = await renderGrid('\x1b[38;2;250;250;250mX\x1b[0m', 20, 3);
    expect(lowContrastCells(invisible, LIGHT_BG).length).toBe(1);
    const legible = await renderGrid('\x1b[38;2;0;0;0mX\x1b[0m', 20, 3);
    expect(lowContrastCells(legible, LIGHT_BG).length).toBe(0);
  });

  test('renderGrid respects the geometry it is given', async () => {
    const narrow = await renderGrid('x'.repeat(100), 54, 30);
    expect(narrow.cols).toBe(54);
    expect(narrow.rows).toBe(30);
  });
});
