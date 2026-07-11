import type { Terminal } from '@xterm/xterm';

/**
 * Pin xterm's inline IME preview (`.composition-view`) and the helper textarea
 * (`.xterm-helper-textarea`) to cc's *visible* caret cell for the duration of
 * an IME composition. This keeps the DOM-rendered preview AND the OS-rendered
 * candidate window from teleporting across the screen as cc redraws its UI.
 *
 * Problem: cc paints its progress UI and status rows by moving the PTY cursor
 * as a drawing primitive, so `buffer.active.cursorX/Y` reflects "where cc
 * last wrote", not "where the user's caret is". xterm's
 * `CompositionHelper.updateCompositionElements` reads that cursor on every
 * `compositionupdate` plus a recursive `setTimeout(0)`, so the preview and
 * candidate window follow it around the screen.
 *
 * Approach: cc paints its own visible caret as a REVERSE-VIDEO cell (see
 * computeAnchor). We scan the buffer for that inverse cell, and pin the
 * preview to it with `!important` inline vars (`--cc-ime-left/-top`) — those
 * outrank xterm's regular `style.left/top` writes, so xterm's later cursor-
 * following updates never visibly move the elements. Class is removed on
 * `compositionend` so xterm's normal cursor-tracking resumes.
 *
 * Registered with `capture: true` so this runs before xterm's bubble-phase
 * compositionstart listener. Not strictly required — !important wins either
 * way — but it keeps the very first layout snapshot pinned, shrinking the
 * window in which the OS IME could see a stale rect.
 */
export function clampImePosition(container: HTMLElement, term: Terminal): void {
  const ta = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
  if (!ta) return;

  // term.write() batches into xterm's writeBuffer and flushes on rAF. If cc
  // is still mid-redraw when the user hits compositionstart, the caret marker
  // (an attribute on some cell) may not have moved yet. Re-anchor on every
  // onCursorMove during the composition to catch that flush.
  let cursorMoveDisposable: { dispose(): void } | null = null;

  const applyAnchor = (source: string, e?: CompositionEvent): void => {
    const screen = container.querySelector('.xterm-screen') as HTMLElement | null;
    if (!screen) return;
    const cv = container.querySelector('.composition-view') as HTMLElement | null;

    const rowHeight = measureRowHeight(screen);
    const cellWidth = screen.clientWidth / Math.max(term.cols, 1);
    const { row, col } = computeAnchor(term);
    const anchorLeftPx = col * cellWidth;

    // Cap left so the inline preview's trailing end never overflows the
    // screen. xterm copies ta.value into cv.textContent on compositionupdate
    // *after* it fires (in xterm's bubble-phase handler), so we estimate
    // content width from e.data (the about-to-be-rendered string). One IME
    // composing column ≈ one ASCII cell (pinyin is ASCII pre-commit), so
    // length × cellWidth is a reasonable proxy.
    const composingLen = e?.data?.length ?? ta.value.length;
    const contentWidth = composingLen * cellWidth;
    const maxLeft = Math.max(0, screen.clientWidth - contentWidth - cellWidth);
    const finalLeft = Math.min(anchorLeftPx, maxLeft);

    const topPx = `${row * rowHeight}px`;
    const leftPx = `${finalLeft}px`;
    // max-width for cv so even an exceptionally long composing string can't
    // push the inline preview past the right edge of `.xterm-screen` and
    // visually squeeze surrounding layout. We compute against the screen's
    // pixel width because cv's parent `.xterm-helpers` is `position: absolute;
    // width: auto`, so a percentage-based cap collapses to ~0.
    const maxWidthPx = `${Math.max(0, screen.clientWidth - finalLeft)}px`;

    if (cv) {
      cv.style.setProperty('--cc-ime-left', leftPx);
      cv.style.setProperty('--cc-ime-top', topPx);
      cv.style.setProperty('--cc-ime-max-width', maxWidthPx);
    }
    ta.style.setProperty('--cc-ime-left', leftPx);
    ta.style.setProperty('--cc-ime-top', topPx);

    logImeAnchor(source, term, screen, cv, ta, {
      row, col, cellWidth, anchorLeftPx, finalLeft, composingLen, contentWidth, maxLeft,
    });
  };

  const pin = (e: Event): void => {
    applyAnchor('compositionstart', e as CompositionEvent);
    const cv = container.querySelector('.composition-view') as HTMLElement | null;
    cv?.classList.add('cc-ime-pinned');
    ta.classList.add('cc-ime-pinned');
    cursorMoveDisposable?.dispose();
    cursorMoveDisposable = term.onCursorMove(() => applyAnchor('cursorMove'));
  };

  const update = (e: Event): void => {
    applyAnchor('compositionupdate', e as CompositionEvent);
  };

  const unpin = (): void => {
    const cv = container.querySelector('.composition-view') as HTMLElement | null;
    cv?.classList.remove('cc-ime-pinned');
    ta.classList.remove('cc-ime-pinned');
    cursorMoveDisposable?.dispose();
    cursorMoveDisposable = null;
    logImeAnchor('compositionend', term, container.querySelector('.xterm-screen'), cv, ta);
  };

  ta.addEventListener('compositionstart', pin, true);
  ta.addEventListener('compositionupdate', update, true);
  ta.addEventListener('compositionend', unpin, true);
}

/** Minimal structural view of xterm.Terminal that computeAnchor needs. Kept
 * separate from `Terminal` so tests can supply a plain object; the real
 * Terminal type satisfies this shape via structural subtyping. */
export interface AnchorTerm {
  rows: number;
  cols: number;
  buffer: {
    active: {
      cursorX: number;
      cursorY: number;
      viewportY: number;
      getLine(y: number): AnchorLine | undefined;
    };
  };
}
export interface AnchorLine {
  translateToString(trim: boolean): string;
  getCell(col: number): AnchorCell | undefined;
}
export interface AnchorCell {
  getChars(): string;
  getWidth(): number;
  isInverse?(): number;
}

/**
 * Where the inline preview should sit, viewport-relative (row, col). Pure
 * w.r.t. the passed term — no DOM access — so tests can drive it with a
 * hand-built buffer.
 *
 * cc runs in the alt screen and paints its own visible caret as a REVERSE-
 * VIDEO cell (a single cell for ASCII/space caret, or the two cells of a
 * CJK wide char when the caret sits on one). The PTY cursor exposed by
 * xterm is unrelated to the user's typing head — cc parks it wherever it
 * last wrote (usually a status row well below the input area). So the
 * anchor is: find the caret cell by scanning for the inverse-video
 * attribute, and pin the preview there.
 *
 * Fallback (no inverse cell found, or an ambiguous multi-region inverse
 * selection): use the PTY cursor. This is the "cc hasn't painted the caret
 * yet" or "there's a text selection" case; the PTY cursor is a reasonable
 * best-effort last resort but is not expected to hit under normal typing.
 */
export function computeAnchor(term: AnchorTerm): { row: number; col: number } {
  const caret = findCaret(term);
  if (caret) return caret;
  const buf = term.buffer.active;
  return { row: buf.cursorY, col: buf.cursorX };
}

/**
 * Scan the viewport for cc's inverse-video caret cell.
 *
 * Per-row bottom-up: for each row, count its inverse cells. A row is
 * "caret-shaped" if it has exactly one hit (narrow / space-EOL caret) or two
 * horizontally-adjacent hits (CJK wide-char caret, isInverse on both cells).
 * Return the caret from the BOTTOM-MOST caret-shaped row.
 *
 * Why bottom-most: cc's input caret always sits in the input box at the
 * bottom of the viewport. Unrelated inverse decorations elsewhere (a
 * highlighted menu item, a tool badge, a syntax-highlight span) live above.
 * Picking the lowest caret-shaped row is a robust way to hop over those
 * decorations without needing to know what each one is.
 *
 * Why per-row (vs. the old global-hit-count): a menu-like inverse region on
 * ONE row used to poison the entire scan (hits went past a global cap,
 * findCaret returned null, applyAnchor fell back to buf.cursorX/Y — which cc
 * parks at col 0 during input-line repaints, so the IME preview landed on
 * top of the `>` prompt). Per-row disqualifies only the offending row.
 *
 * Returns null when no row is caret-shaped: no inverse cells anywhere (cc
 * hasn't painted the caret yet), or every row exceeds 2 hits (a big
 * selection covering multiple rows). Fallback to PTY cursor handles both.
 */
function findCaret(term: AnchorTerm): { row: number; col: number } | null {
  const buf = term.buffer.active;
  let best: { row: number; col: number } | null = null;
  for (let r = 0; r < term.rows; r++) {
    const line = buf.getLine(buf.viewportY + r);
    if (!line) continue;
    const hits: number[] = [];
    let disqualified = false;
    for (let c = 0; c < term.cols; c++) {
      const cell = line.getCell(c);
      if (!cell) continue;
      const inv = typeof cell.isInverse === 'function' ? cell.isInverse() : 0;
      if (!inv) continue;
      hits.push(c);
      if (hits.length > 2) { disqualified = true; break; }
    }
    if (disqualified) continue;
    let caretCol = -1;
    if (hits.length === 1) caretCol = hits[0]!;
    else if (hits.length === 2 && hits[1]! === hits[0]! + 1) caretCol = hits[0]!;
    if (caretCol >= 0) best = { row: r, col: caretCol };
  }
  return best;
}

/**
 * Diagnostic ring buffer for the IME anchor. Every applyAnchor call pushes a
 * snapshot into `window.__ccImeLog`. Cheap to gather (composition events are
 * rare); kept on so a user can dump it after reproducing a bug — the only
 * reliable channel for issues that resist automated repro.
 */
const IME_LOG_CAP = 500;
declare global {
  interface Window {
    __ccImeLog?: unknown[];
  }
}

function logImeAnchor(
  source: string,
  term: Terminal,
  screen: HTMLElement | null,
  cv: HTMLElement | null,
  ta: HTMLTextAreaElement,
  computed?: {
    row: number; col: number; cellWidth: number;
    anchorLeftPx: number; finalLeft: number;
    composingLen: number; contentWidth: number; maxLeft: number;
  },
): void {
  try {
    const buf = window.__ccImeLog ?? (window.__ccImeLog = []);
    const rect = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { l: r.left, t: r.top, w: r.width, h: r.height };
    };
    const cvStyle = cv && getComputedStyle(cv);
    const buffer = term.buffer.active;
    buf.push({
      t: performance.now() | 0,
      src: source,
      cursor: { x: buffer.cursorX, y: buffer.cursorY, vY: buffer.viewportY },
      cols: term.cols,
      rows: term.rows,
      // Full inverse-cell scan for diagnostics — cheap, and lets us verify
      // the caret is where we think it is if something regresses.
      caretScan: scanInverseCells(term),
      computed,
      cvRect: rect(cv),
      screenRect: rect(screen),
      taRect: rect(ta),
      cvVarLeft: cvStyle?.getPropertyValue('--cc-ime-left').trim(),
      cvVarTop: cvStyle?.getPropertyValue('--cc-ime-top').trim(),
      cvComputedLeft: cvStyle?.left,
      cvComputedTop: cvStyle?.top,
      cvActive: cv?.classList.contains('active') ?? false,
      cvPinned: cv?.classList.contains('cc-ime-pinned') ?? false,
      cvInlineLeft: cv?.style.left,
      taInlineWidth: ta.style.width,
    });
    if (buf.length > IME_LOG_CAP) buf.splice(0, buf.length - IME_LOG_CAP);
  } catch {
    // logging must never break rendering — swallow any measurement error
  }
}

function scanInverseCells(term: AnchorTerm): { r: number; c: number; ch: string; width: number }[] {
  const out: { r: number; c: number; ch: string; width: number }[] = [];
  const buf = term.buffer.active;
  for (let r = 0; r < term.rows; r++) {
    const line = buf.getLine(buf.viewportY + r);
    if (!line) continue;
    for (let c = 0; c < term.cols; c++) {
      const cell = line.getCell(c);
      if (!cell) continue;
      const inv = typeof cell.isInverse === 'function' ? cell.isInverse() : 0;
      if (inv) out.push({ r, c, ch: cell.getChars(), width: cell.getWidth() });
    }
  }
  return out;
}

function measureRowHeight(screen: HTMLElement): number {
  const rows = screen.querySelector('.xterm-rows');
  if (rows && rows.firstElementChild) {
    const h = (rows.firstElementChild as HTMLElement).offsetHeight;
    if (h > 0) return h;
  }
  return 18;
}
