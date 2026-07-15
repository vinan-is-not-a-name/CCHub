import { test, expect } from '@playwright/test';
import { computeAnchor, pickRowHeight, AnchorTerm, AnchorCell, AnchorLine } from '../src/client/terminalIme.js';

// computeAnchor is now purely "scan the buffer for the reverse-video caret
// cell cc paints; use it if found, else fall back to the PTY cursor". No more
// prompt-row / continuation-walking heuristics. The scan is PER-ROW BOTTOM-UP:
// a row qualifies as "caret-shaped" if it has exactly one inverse cell
// (narrow-char / space-EOL caret) or two horizontally-adjacent inverse cells
// (CJK wide-char caret). The BOTTOM-MOST qualifying row wins. Rows with 0 or
// >2 inverse cells, or 2 non-adjacent cells, are skipped — they represent
// non-caret UI (selection, menu highlight, tool badge) and don't block other
// rows from anchoring.
//
// Why bottom-most: cc's input caret always lives in the input box at the
// bottom of the viewport. Any unrelated inverse decoration (menu, badge,
// syntax highlight) that cc paints elsewhere sits above.
//
// Fallback: if no row is caret-shaped anywhere in the viewport (cc hasn't
// painted the caret yet, or the whole viewport is a selection), use the PTY
// cursor. Not ideal, but caller is guaranteed a valid (row, col).

interface CellSpec {
  ch?: string;   // getChars(); default '' (empty/blank cell)
  width?: number; // getWidth(); default 1
  inv?: boolean;  // isInverse() returns 1 when true; default false
}

/**
 * Build a fake Terminal from a 2-D array of CellSpec. cursor is where the
 * PTY cursor sits (the fallback target when no caret is found). Every
 * unspecified cell is blank/non-inverse.
 */
function makeTerm(opts: {
  rows: number;
  cols: number;
  cursorX: number;
  cursorY: number;
  cells?: Record<number, Record<number, CellSpec>>; // cells[row][col] = spec
  viewportY?: number;
}): AnchorTerm {
  const viewportY = opts.viewportY ?? 0;
  const cells = opts.cells ?? {};
  return {
    rows: opts.rows,
    cols: opts.cols,
    buffer: {
      active: {
        cursorX: opts.cursorX,
        cursorY: opts.cursorY,
        viewportY,
        getLine(y: number): AnchorLine | undefined {
          const vRow = y - viewportY;
          if (vRow < 0 || vRow >= opts.rows) return undefined;
          const row = cells[vRow] ?? {};
          return {
            translateToString(_trim: boolean) {
              let s = '';
              for (let c = 0; c < opts.cols; c++) s += row[c]?.ch ?? '';
              return s;
            },
            getCell(col: number): AnchorCell | undefined {
              const spec = row[col];
              if (!spec) return { getChars: () => '', getWidth: () => 1, isInverse: () => 0 };
              return {
                getChars: () => spec.ch ?? '',
                getWidth: () => spec.width ?? 1,
                isInverse: () => (spec.inv ? 1 : 0),
              };
            },
          };
        },
      },
    },
  };
}

test.describe('computeAnchor', () => {
  // The base case that motivates the whole rewrite: one reverse-video cell
  // at the user's caret position. Location within the buffer is irrelevant
  // to the anchor — no more prompt row / continuation row logic.
  test('single inverse cell → anchor lands on that cell, ignoring PTY cursor', () => {
    const term = makeTerm({
      rows: 10,
      cols: 40,
      cursorX: 90, // far right — where cc parked the PTY cursor after redraw
      cursorY: 33, // way below the input area — status row
      cells: {
        5: {
          10: { ch: ' ', inv: true }, // cc's caret: reverse-video space
        },
      },
    });
    expect(computeAnchor(term)).toEqual({ row: 5, col: 10 });
  });

  // The caret can also land on a CJK wide char (`阿` in the log we captured).
  // xterm sets isInverse on both cells of the wide char; anchor at the
  // leftmost cell so the preview appears at the char's visible left edge.
  test('two adjacent inverse cells on same row (CJK caret) → anchor at leftmost', () => {
    const term = makeTerm({
      rows: 10,
      cols: 40,
      cursorX: 0,
      cursorY: 0,
      cells: {
        3: {
          10: { ch: '阿', width: 2, inv: true }, // wide-char first cell
          11: { ch: '', width: 0, inv: true },   // wide-char placeholder cell
        },
      },
    });
    expect(computeAnchor(term)).toEqual({ row: 3, col: 10 });
  });

  // No inverse cell anywhere — cc hasn't drawn a caret yet (startup, or the
  // spinner has hidden the cursor). Fall back to the PTY cursor. Not ideal,
  // but the caller is guaranteed to get a valid (row, col) so IME preview
  // still has somewhere to sit.
  test('no inverse cells anywhere → falls back to PTY cursor', () => {
    const term = makeTerm({
      rows: 5,
      cols: 20,
      cursorX: 7,
      cursorY: 2,
      cells: {
        1: { 0: { ch: 'x' }, 1: { ch: 'y' } }, // plain content, no inverse
      },
    });
    expect(computeAnchor(term)).toEqual({ row: 2, col: 7 });
  });

  // Two rows each with a single inverse cell — bottom-up picks the lower row.
  // Real-world case (this is the middle-pane bug fix): cc paints a stray
  // inverse decoration somewhere in its UI above the input, AND paints the
  // real input caret. The old algorithm rejected both as "ambiguous", fell
  // back to buf.cursorX/Y (col 0 during a repaint) and dropped the IME
  // preview onto the `>` prompt. New algorithm anchors on the bottom-most
  // caret-shaped row — which is the real input caret in every observed case.
  test('two caret-shaped rows → picks the bottom-most (real input caret)', () => {
    const term = makeTerm({
      rows: 10,
      cols: 20,
      cursorX: 3,
      cursorY: 4,
      cells: {
        2: { 5: { ch: 'a', inv: true } },       // stray decoration above
        6: { 5: { ch: 'b', inv: true } },       // real input caret
      },
    });
    expect(computeAnchor(term)).toEqual({ row: 6, col: 5 });
  });

  // Two inverse cells on the same row but non-adjacent — not a CJK caret
  // shape (those are always c and c+1). That row is disqualified. With no
  // other caret-shaped row, fall back to the PTY cursor.
  test('two inverse cells same row but non-adjacent → row disqualified → fallback', () => {
    const term = makeTerm({
      rows: 5,
      cols: 20,
      cursorX: 1,
      cursorY: 1,
      cells: {
        3: {
          5: { ch: 'a', inv: true },
          9: { ch: 'b', inv: true }, // gap between them
        },
      },
    });
    expect(computeAnchor(term)).toEqual({ row: 1, col: 1 });
  });

  // A long selection creates a big inverse region on one row. That row is
  // disqualified (>2 hits); with no other caret-shaped row, fall back.
  test('many inverse cells on one row (selection-like) → row disqualified → fallback', () => {
    const cells: Record<number, Record<number, CellSpec>> = { 2: {} };
    for (let c = 0; c < 6; c++) cells[2]![c] = { ch: 'x', inv: true };
    const term = makeTerm({
      rows: 5,
      cols: 20,
      cursorX: 3,
      cursorY: 3,
      cells,
    });
    expect(computeAnchor(term)).toEqual({ row: 3, col: 3 });
  });

  // The middle-pane bug in executable form: cc paints a menu-like inverse
  // region on one row (would poison the OLD scan and force fallback) AND
  // paints the real input caret as a single inverse cell below it. The
  // per-row algorithm disqualifies only the menu row, so the caret still
  // wins. This is the primary regression test for the fix.
  test('menu-like inverse row + input caret below → picks the caret', () => {
    const cells: Record<number, Record<number, CellSpec>> = { 3: {} };
    // 6-cell reverse region on row 3 — the "menu highlight" / tool badge.
    for (let c = 0; c < 6; c++) cells[3]![c] = { ch: 'x', inv: true };
    // Real input caret on row 8.
    cells[8] = { 12: { ch: ' ', inv: true } };
    const term = makeTerm({
      rows: 10,
      cols: 40,
      cursorX: 0, // cc parked PTY cursor at col 0 mid-repaint — the exact
      cursorY: 8, // condition that produced the "> is covered" symptom.
      cells,
    });
    expect(computeAnchor(term)).toEqual({ row: 8, col: 12 });
  });

  // Same middle-pane scenario but the input caret is CJK (2 adjacent inverse
  // cells). Two hits on that row must NOT disqualify it; must still resolve
  // to the leftmost of the pair.
  test('menu-like inverse row + CJK caret below → picks the CJK caret leftmost cell', () => {
    const cells: Record<number, Record<number, CellSpec>> = { 3: {} };
    for (let c = 0; c < 6; c++) cells[3]![c] = { ch: 'x', inv: true };
    cells[8] = {
      12: { ch: '阿', width: 2, inv: true },
      13: { ch: '', width: 0, inv: true },
    };
    const term = makeTerm({
      rows: 10,
      cols: 40,
      cursorX: 0,
      cursorY: 8,
      cells,
    });
    expect(computeAnchor(term)).toEqual({ row: 8, col: 12 });
  });

  // Real xterm builds all expose isInverse, but the interface marks it
  // optional so tests can supply a minimal cell. If a cell literally has
  // no isInverse method, treat it as non-inverse — never crash — and fall
  // back to the cursor. Guards a bad shim from breaking IME entirely.
  test('cell missing isInverse method → treated as non-inverse → fallback', () => {
    const term: AnchorTerm = {
      rows: 3,
      cols: 10,
      buffer: {
        active: {
          cursorX: 4,
          cursorY: 1,
          viewportY: 0,
          getLine() {
            return {
              translateToString: () => '',
              // Cell without isInverse — the "?" in the interface must
              // shield us from a TypeError.
              getCell: () => ({ getChars: () => '', getWidth: () => 1 }),
            };
          },
        },
      },
    };
    expect(computeAnchor(term)).toEqual({ row: 1, col: 4 });
  });

  // Sanity: viewportY offsetting. When the buffer has scrolled, getLine is
  // called with (viewportY + row); the anchor's row is still reported
  // viewport-relative. Prevents a future refactor from accidentally
  // returning a scrollback-relative row.
  test('inverse cell in a scrolled viewport → row is viewport-relative', () => {
    const term = makeTerm({
      rows: 5,
      cols: 20,
      cursorX: 0,
      cursorY: 0,
      viewportY: 100, // scrolled 100 lines down
      cells: {
        2: { 8: { ch: ' ', inv: true } }, // viewport row 2 (absolute buffer row 102)
      },
    });
    expect(computeAnchor(term)).toEqual({ row: 2, col: 8 });
  });
});

// pickRowHeight is the pixel-conversion half of the IME pin. The bug it guards:
// under a fractional devicePixelRatio (a 125%/150%-scaled secondary monitor)
// at a non-100% font, xterm lays each row out at a fractional pitch (e.g.
// 17.3203px) while offsetHeight rounds it to 17. `applyAnchor` multiplies that
// by the caret's row index, so a caret ~21 rows down drifted the preview ~6.7px
// above the real caret. The fix reads the fractional getBoundingClientRect
// height instead. 100% font / integer DPR keeps integer heights, so the two
// agree there and this is a no-op.
function fakeRow(rectHeight: number, offsetHeight: number) {
  return { getBoundingClientRect: () => ({ height: rectHeight }), offsetHeight };
}

test.describe('pickRowHeight', () => {
  // The regression: fractional rendered pitch, integer offsetHeight. Must
  // return the fractional value, NOT the rounded-down integer.
  test('fractional rect height + integer offsetHeight → returns fractional rect height', () => {
    expect(pickRowHeight(fakeRow(17.3203125, 17))).toBe(17.3203125);
  });

  // Integer height case (100% font, or integer DPR): both agree, no behavior
  // change vs the old offsetHeight path.
  test('integer heights → returns that integer (no-op vs old behavior)', () => {
    expect(pickRowHeight(fakeRow(18, 18))).toBe(18);
  });

  // Row exists but has not been laid out (rect height 0) — fall back to
  // offsetHeight, matching pre-fix behavior for the not-yet-rendered case.
  test('rect height 0 → falls back to offsetHeight', () => {
    expect(pickRowHeight(fakeRow(0, 20))).toBe(20);
  });

  // No row element at all → the sane default. Guards against a null/undefined
  // firstElementChild during teardown or before first paint.
  test('null element → default 18', () => {
    expect(pickRowHeight(null)).toBe(18);
    expect(pickRowHeight(undefined)).toBe(18);
  });

  // Both measurements 0 (detached/hidden) → default rather than returning 0,
  // which would collapse every row to the same Y.
  test('both heights 0 → default 18', () => {
    expect(pickRowHeight(fakeRow(0, 0))).toBe(18);
  });
});
