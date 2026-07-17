import xtermHeadless from '@xterm/headless';
import type { TerminalSnapshot } from '../../../shared/protocol.js';

const { Terminal } = xtermHeadless;

/** Max lines a reattach snapshot replays. The browser xterm caps scrollback at
 * 5000 (client/terminal.ts), so sending the server's full 64K-line history is
 * both wasted bytes and — for a very heavy session — a multi-MB frame that
 * stalls/garbles the client replay (blank-then-flash). We cap at the client's
 * own limit: it physically cannot display more, and live `output` keeps
 * flowing after attach so nothing recent is lost. */
const MAX_SNAPSHOT_LINES = 5000;

export function snapshotToText(snapshot: TerminalSnapshot): string {
  return snapshot.lines.join('\r\n');
}

/** The subset of xterm's IBufferCell we read to reproduce a cell's SGR state.
 * Declared locally (rather than importing from @xterm/headless) to keep this
 * serializer decoupled from the headless type surface — same pattern as
 * terminalIme.ts's minimal buffer shims. `isX()` attribute probes return a
 * number (0/1) in xterm's API; the color-mode probes return booleans. */
interface StyledCell {
  getChars(): string;
  getWidth(): number;
  getFgColor(): number;
  getBgColor(): number;
  isFgPalette(): boolean;
  isBgPalette(): boolean;
  isFgRGB(): boolean;
  isBgRGB(): boolean;
  isBold(): number;
  isDim(): number;
  isItalic(): number;
  isUnderline(): number;
  isBlink(): number;
  isInverse(): number;
  isInvisible(): number;
  isStrikethrough(): number;
  isAttributeDefault(): boolean;
}

interface StyledLine {
  getCell(x: number): StyledCell | undefined;
}

/** Encode a cell's visual attributes as the `;`-joined body of an SGR sequence
 * (no leading `ESC[`, no trailing `m`). Empty string == fully default.
 * Foreground/background handle xterm's three color modes: default (emit
 * nothing), 256-color palette (`38;5;N` / `48;5;N`), and truecolor RGB
 * (`38;2;R;G;B` / `48;2;R;G;B`, unpacked from the packed 24-bit int). */
function cellSgr(cell: StyledCell): string {
  const p: string[] = [];
  if (cell.isBold()) p.push('1');
  if (cell.isDim()) p.push('2');
  if (cell.isItalic()) p.push('3');
  if (cell.isUnderline()) p.push('4');
  if (cell.isBlink()) p.push('5');
  if (cell.isInverse()) p.push('7');
  if (cell.isInvisible()) p.push('8');
  if (cell.isStrikethrough()) p.push('9');
  if (cell.isFgRGB()) {
    const c = cell.getFgColor();
    p.push('38', '2', String((c >>> 16) & 0xff), String((c >>> 8) & 0xff), String(c & 0xff));
  } else if (cell.isFgPalette()) {
    p.push('38', '5', String(cell.getFgColor()));
  }
  if (cell.isBgRGB()) {
    const c = cell.getBgColor();
    p.push('48', '2', String((c >>> 16) & 0xff), String((c >>> 8) & 0xff), String(c & 0xff));
  } else if (cell.isBgPalette()) {
    p.push('48', '5', String(cell.getBgColor()));
  }
  return p.join(';');
}

/** Serialize one buffer line to text with inline SGR sequences that reproduce
 * its colors when the client `term.write()`s it. Each style change emits a
 * `CSI 0;<params> m` (leading 0 resets first, so runs never inherit stale
 * attributes from a preceding run), and the line ends with a `CSI 0 m` reset
 * whenever it left a non-default style in effect — otherwise the client's
 * per-line `CSI 2K` erase in loadSnapshot would paint the *next* row with this
 * row's trailing background color (the classic "bg bleeds past line end" bug).
 *
 * Trailing cells that are a default-attribute space are dropped so an ordinary
 * line doesn't carry `cols` padding spaces; but a trailing run that is a space
 * with a non-default background (or inverse/underline — all of which paint on a
 * blank glyph) IS significant and kept, so cc's full-width diff/line-change
 * highlights survive to the right edge. A fully-default line round-trips to the
 * exact same plain text `translateToString(true)` would produce. */
export function serializeStyledLine(line: StyledLine, cols: number): string {
  let last = -1;
  for (let x = 0; x < cols; x += 1) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    const ch = cell.getChars();
    const blank = ch === '' || ch === ' ';
    if (!blank || !cell.isAttributeDefault()) last = x;
  }
  if (last < 0) return '';
  let out = '';
  let cur = ''; // SGR params currently in effect on the client; '' == default
  for (let x = 0; x <= last; x += 1) {
    const cell = line.getCell(x);
    if (!cell) {
      if (cur !== '') { out += '\x1b[0m'; cur = ''; }
      out += ' ';
      continue;
    }
    if (cell.getWidth() === 0) continue; // trailing half of a wide (CJK) glyph
    const key = cellSgr(cell);
    if (key !== cur) {
      out += key ? `\x1b[0;${key}m` : '\x1b[0m';
      cur = key;
    }
    const ch = cell.getChars();
    out += stripControl(ch === '' ? ' ' : ch);
  }
  if (cur !== '') out += '\x1b[0m';
  return out;
}

export class TerminalScreen {
  private term: InstanceType<typeof Terminal>;
  /** DEC private modes the writer has turned on/off during this session's
   * lifetime, last-write-wins. Populated by pre-scanning `write()` payloads
   * for `CSI ? N[;M...] h/l` sequences — xterm's public API does not
   * expose this state, and the reattach snapshot needs it so the client
   * can restore mouse tracking / alt-screen / bracketed paste / etc.
   * before replaying the buffer text. */
  private privateModes = new Map<number, boolean>();

  constructor(cols = 120, rows = 40, scrollback = 64 * 1024) {
    this.term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  }

  write(data: string, callback?: () => void) {
    this.trackPrivateModes(data);
    this.term.write(data, callback);
  }

  resize(cols: number, rows: number) {
    this.term.resize(cols, rows);
  }

  snapshot(): TerminalSnapshot {
    const buffer = this.term.buffer.active;
    const total = buffer.length;
    // Replay only the tail the client can actually hold. `start` rebases every
    // absolute buffer index (including the cursor) into the sliced window.
    const start = Math.max(0, total - MAX_SNAPSHOT_LINES);
    const styled: string[] = [];
    const plain: string[] = [];
    for (let i = start; i < total; i += 1) {
      const line = buffer.getLine(i);
      plain.push(stripControl(line?.translateToString(true) ?? ''));
      styled.push(line ? serializeStyledLine(line as unknown as StyledLine, this.term.cols) : '');
    }
    // Trim trailing rows that are truly blank. A row is blank only when BOTH
    // its plain text AND its styled form are empty — a row whose glyphs are all
    // spaces but carries a background fill has empty plain text yet a non-empty
    // styled string, and must be kept so a highlight that ends the screen isn't
    // silently dropped.
    let end = plain.length;
    while (end > 0 && plain[end - 1] === '' && styled[end - 1] === '') end -= 1;
    const absCursorY = buffer.baseY + buffer.cursorY;
    return {
      cols: this.term.cols,
      rows: this.term.rows,
      cursorX: buffer.cursorX,
      cursorY: Math.max(0, absCursorY - start),
      lines: styled.slice(0, end),
      modeSetup: this.buildModeSetup(),
    };
  }

  /** Plain-text projection of the buffer tail for server-side state scraping
   * (StateMachine's looksBusy / looksIdle / interrupt detection). Deliberately
   * SGR-free: the state machine matches literal substrings like "esc to
   * interrupt", and the inline ANSI that `snapshot()` now embeds would break
   * those matches. Also cheaper than snapshot() — no per-cell SGR walk, no
   * private-mode encode — which matters because this runs on every output
   * frame, whereas snapshot() only runs on (re)attach. */
  plainText(): string {
    const buffer = this.term.buffer.active;
    const total = buffer.length;
    const start = Math.max(0, total - MAX_SNAPSHOT_LINES);
    const lines: string[] = [];
    for (let i = start; i < total; i += 1) {
      lines.push(stripControl(buffer.getLine(i)?.translateToString(true) ?? ''));
    }
    return lines.join('\r\n');
  }

  /** Scan a write payload for CSI `? N[;M;...] h` / `l` sequences and
   * update the private-mode ledger. A single sequence can carry multiple
   * numbers, so split on `;`. We deliberately look at raw text, not xterm's
   * parsed AST — xterm-headless does not surface mode changes via any
   * public event, and shipping an intercepting parser would be many times
   * the code for the same result. */
  private trackPrivateModes(data: string): void {
    const re = /\x1b\[\?([\d;]+)([hl])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(data)) !== null) {
      const on = m[2] === 'h';
      for (const numStr of m[1].split(';')) {
        const n = Number.parseInt(numStr, 10);
        if (Number.isFinite(n)) this.privateModes.set(n, on);
      }
    }
  }

  /** Encode the currently-enabled private modes as a single CSI sequence
   * the client can `term.write()` before replaying `lines`. We emit ONLY
   * the enabled set: the client's fresh xterm defaults every mode to off,
   * so a `?N l` for a currently-disabled mode would be redundant noise. */
  private buildModeSetup(): string {
    const on: number[] = [];
    for (const [n, enabled] of this.privateModes) {
      if (enabled) on.push(n);
    }
    if (on.length === 0) return '';
    return `\x1b[?${on.join(';')}h`;
  }
}

function stripControl(line: string): string {
  // C0/C1 control chars except TAB; xterm headless already consumed escape
  // sequences, so any residual bytes here are noise that would otherwise
  // render as boxes/garbage on the client.
  return line.replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, '');
}
