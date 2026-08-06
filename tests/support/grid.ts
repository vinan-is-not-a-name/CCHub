/**
 * Read a rendered terminal grid, cell by cell.
 *
 * Most of this repo's specs assert on the bytes we *send* or on a fake's
 * recorded calls. But every bug the user actually reported was about what ended
 * up on screen: text overwritten after an emoji, a bold word rendered
 * invisible, a footer ghost, columns drifting. Those are properties of the grid
 * — the thing at the far end of the pipeline — and asserting them requires
 * looking at cells, not at escape sequences.
 *
 * The grid is produced by feeding a capture into `TerminalScreen`, the same
 * headless xterm the server already uses for reattach snapshots, configured
 * with the same Unicode 11 width table as the browser. So the oracle here is
 * "what a real xterm did with real cc bytes", with neither side hand-written.
 *
 * Contrast ratios are computed because "invisible bold text" (fixed by
 * `minimumContrastRatio: 4.5` in terminal.ts) is otherwise untestable: the text
 * is present, correctly positioned, and correctly coloured — it is only
 * *unreadable*, which no text or position assertion can see.
 */
import { TerminalScreen } from '../../src/server/infrastructure/terminal/terminalScreen.js';

/** One rendered cell. */
export interface Cell {
  row: number;
  col: number;
  /** The glyph(s) in this cell. Empty string for the spacer cell that follows a
   * double-width glyph. */
  chars: string;
  /** 1 for a normal cell, 2 for a double-width glyph, 0 for its spacer. */
  width: number;
  bold: boolean;
  dim: boolean;
  inverse: boolean;
  /** Resolved fg/bg as `#rrggbb`, using the app's own palette for indexed
   * colours, or null when the cell uses the terminal default. */
  fg: string | null;
  bg: string | null;
}

export interface Grid {
  cols: number;
  rows: number;
  cells: Cell[];
  /** Plain text per row, trailing blanks trimmed. */
  lines: string[];
}

/**
 * xterm's default 16 ANSI colours, which is what cc's SGR 30-37/90-97 land on.
 * Needed to turn an indexed colour into something a contrast ratio can be
 * computed from. Values are xterm.js's defaults.
 */
const ANSI_16 = [
  '#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
  '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec',
];

/** 256-colour cube → hex, for palette indices above 15. */
function palette256(i: number): string {
  if (i < 16) return ANSI_16[i]!;
  if (i < 232) {
    const n = i - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    const r = steps[Math.floor(n / 36)]!;
    const g = steps[Math.floor((n % 36) / 6)]!;
    const b = steps[n % 6]!;
    return rgbHex(r, g, b);
  }
  const v = 8 + (i - 232) * 10;
  return rgbHex(v, v, v);
}

function rgbHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}

/** Resolve one cell's colour to hex, or null for the terminal default. */
function resolveColor(
  isPalette: boolean, isRGB: boolean, value: number,
): string | null {
  if (isRGB) return rgbHex((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
  if (isPalette) return palette256(value);
  return null; // default fg/bg — resolved by the theme, not by the stream
}

/**
 * Feed `data` into a headless xterm of the given geometry and read back the grid.
 *
 * Geometry matters: cc lays its UI out against the cols it was told, so
 * replaying a 54-col capture into an 80-col terminal produces a grid that
 * matches neither the capture nor anything a user saw.
 */
export async function renderGrid(data: string, cols: number, rows: number): Promise<Grid> {
  const screen = new TerminalScreen(cols, rows);
  await new Promise<void>((resolve) => screen.write(data, resolve));

  // Reach the buffer through the same private field the class uses; the public
  // snapshot() serializes to strings, which is lossy for per-cell attributes.
  const term = (screen as unknown as { term: { buffer: { active: BufferLike }; cols: number; rows: number } }).term;
  const buffer = term.buffer.active;
  const cells: Cell[] = [];
  const lines: string[] = [];

  for (let y = 0; y < term.rows; y += 1) {
    const line = buffer.getLine(buffer.viewportY + y);
    lines.push(line?.translateToString(true) ?? '');
    if (!line) continue;
    for (let x = 0; x < term.cols; x += 1) {
      const c = line.getCell(x);
      if (!c) continue;
      cells.push({
        row: y, col: x,
        chars: c.getChars(),
        width: c.getWidth(),
        bold: c.isBold() !== 0,
        dim: c.isDim() !== 0,
        inverse: c.isInverse() !== 0,
        fg: resolveColor(c.isFgPalette(), c.isFgRGB(), c.getFgColor()),
        bg: resolveColor(c.isBgPalette(), c.isBgRGB(), c.getBgColor()),
      });
    }
  }
  return { cols: term.cols, rows: term.rows, cells, lines };
}

interface BufferLike {
  viewportY: number;
  getLine(y: number): {
    translateToString(trim?: boolean): string;
    getCell(x: number): {
      getChars(): string; getWidth(): number;
      getFgColor(): number; getBgColor(): number;
      isFgPalette(): boolean; isBgPalette(): boolean;
      isFgRGB(): boolean; isBgRGB(): boolean;
      isBold(): number; isDim(): number; isInverse(): number;
    } | undefined;
  } | undefined;
}

/** Relative luminance per WCAG 2.x. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const chan = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * chan[0]! + 0.7152 * chan[1]! + 0.0722 * chan[2]!;
}

/** WCAG contrast ratio between two hex colours, 1..21. */
export function contrastRatio(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** Cells carrying a visible glyph — the ones whose legibility a user can judge.
 * Spacers, blanks and whitespace are excluded. */
export function visibleCells(grid: Grid): Cell[] {
  return grid.cells.filter((c) => c.chars.trim().length > 0 && c.width > 0);
}

/**
 * Trim a capture to the last frame drawn while cc still owned the alt screen.
 *
 * A capture taken over a session's whole lifetime ends with cc's teardown:
 * `CSI ?1006l ?1003l ?1002l ?1000l` then `CSI ?1049l`, which leaves the alt
 * screen. Replaying all of it therefore lands on an empty main screen — the UI
 * the assertions care about was on the buffer cc just discarded. (This is the
 * same property that made the raw captures unable to answer "was mouse tracking
 * ever on": their tail is the restore, not the steady state.)
 *
 * Cutting at the final `?1049l` leaves the last live frame in place. If the
 * capture never leaves the alt screen, it is returned unchanged.
 */
export function liveFrame(data: string): string {
  const exit = data.lastIndexOf('\x1b[?1049l');
  return exit === -1 ? data : data.slice(0, exit);
}

/**
 * Cells whose text would be unreadable against `themeBg` if the renderer did no
 * contrast correction.
 *
 * This models the *pre-fix* pipeline on purpose: `minimumContrastRatio: 4.5`
 * lives in the browser renderer, so the raw stream colours are what it has to
 * repair. A capture that produces such cells is evidence the setting is
 * load-bearing on that machine — which is why the bold text went invisible on
 * one machine and not another.
 */
export function lowContrastCells(grid: Grid, themeBg: string, threshold = 4.5): Array<Cell & { ratio: number }> {
  const out: Array<Cell & { ratio: number }> = [];
  for (const c of visibleCells(grid)) {
    // Inverse cells swap fg/bg at paint time; a default-coloured cell inherits
    // the theme and is the theme author's problem, not the stream's.
    if (c.inverse || c.fg === null) continue;
    const bg = c.bg ?? themeBg;
    const ratio = contrastRatio(c.fg, bg);
    if (ratio < threshold) out.push({ ...c, ratio });
  }
  return out;
}

/** Find the row index containing `needle`, or -1. */
export function findRow(grid: Grid, needle: string): number {
  return grid.lines.findIndex((l) => l.includes(needle));
}

/**
 * Rendered width of a row's content: the column just past its last visible
 * glyph, counting a double-width glyph as 2.
 *
 * This is the quantity cc's absolute column moves are computed against, so a
 * disagreement between this and cc's own idea of the width is exactly the
 * emoji-width class of bug. Trailing blank cells are excluded — every cell in
 * the grid has a width, so summing them all would just return `cols` for every
 * row and assert nothing.
 */
export function renderedWidth(grid: Grid, row: number): number {
  const inRow = grid.cells.filter((c) => c.row === row);
  let last = -1;
  for (const c of inRow) {
    if (c.chars.trim().length > 0 && c.width > 0) last = Math.max(last, c.col + c.width - 1);
  }
  return last + 1;
}
