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
    const lines: string[] = [];
    for (let i = start; i < total; i += 1) {
      lines.push(stripControl(buffer.getLine(i)?.translateToString(true) ?? ''));
    }
    const trimmed = trimTrailingEmptyLines(lines);
    const absCursorY = buffer.baseY + buffer.cursorY;
    return {
      cols: this.term.cols,
      rows: this.term.rows,
      cursorX: buffer.cursorX,
      cursorY: Math.max(0, absCursorY - start),
      lines: trimmed,
      modeSetup: this.buildModeSetup(),
    };
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

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === '') end -= 1;
  return lines.slice(0, end);
}

function stripControl(line: string): string {
  // C0/C1 control chars except TAB; xterm headless already consumed escape
  // sequences, so any residual bytes here are noise that would otherwise
  // render as boxes/garbage on the client.
  return line.replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, '');
}
