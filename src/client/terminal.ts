import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import themes from 'xterm-theme';
import type { TerminalSnapshot } from '../shared/protocol.js';
import { attachClipboard } from './terminalClipboard.js';
import { clampImePosition } from './terminalIme.js';
import { loadFontScale, scaleToPx } from './views/fontScale.js';
import { withHiddenCursor, withVisibleCursor } from './terminalTheme.js';
import { resolveThemeName } from './themeCatalog.js';

/** Read the persisted theme name and coerce to a name the picker still
 *  offers. If a browser has an older, now-hidden value stored (e.g.
 *  `default`, whose bg/fg were unset), we hand back OneHalfLight rather
 *  than let xterm render the placeholder theme. */
export function getStoredTheme(): string {
  return resolveThemeName(localStorage.getItem('cchub-theme'));
}


export function createTerminal(container: HTMLElement) {
  const params = new URLSearchParams(location.search);
  const fontFamily = params.get('font') || 'Maple Mono NF CN, Cascadia Code, Consolas, monospace';
  const themeName = getStoredTheme();
  let currentBaseTheme = (themes as any)[themeName] || (themes as any).OneHalfLight;
  // CC's cursor strategy differs by version, and the two need opposite handling:
  //   - Legacy CC (≤ v2.1.139) paints its own caret as reverse-video
  //     ([CSI 7m]<char>[CSI 27m]) and NEVER sends DECTCEM. The terminal's own
  //     cursor would collide with cc's pseudo-caret (both visible + xterm's bar
  //     dragging along cc's 40+ CUP moves per spinner tick = "cursor everywhere"
  //     regression). Hidden mode: withHiddenCursor + cursorInactiveStyle: 'none'
  //     keeps xterm out of the way; cc's reverse-video is the only visible caret.
  //   - Modern CC (v2.1.206+) does NOT paint its own caret. It emits DECTCEM
  //     (CSI ?25l/?25h) expecting the terminal to draw a real cursor. In this
  //     mode, hidden xterm cursor = nothing visible at all (bug #262). Visible
  //     mode: withVisibleCursor uses theme.foreground for the bar; xterm's
  //     built-in DECTCEM handling shows/hides it as cc requests.
  //
  // We can't distinguish versions statically (a session on a remote SSH host may
  // run any cc version). Instead we start in Hidden mode and a CSI ?l/?h parser
  // handler (registered below, after term.open) upgrades to Visible mode the
  // first time cc uses DECTCEM param 25. One-way switch: once a session proves
  // it drives DECTCEM, the terminal draws the caret for the rest of the
  // session's life. Legacy cc never triggers the switch and stays Hidden.
  let cursorVisibleMode = false;
  const cursorTheme = () =>
    cursorVisibleMode ? withVisibleCursor(currentBaseTheme) : withHiddenCursor(currentBaseTheme);

  const measureOnly = container.dataset.measure === 'true';
  const term = new Terminal({
    cursorBlink: true,
    // 'bar' uses `box-shadow` for the decoration and doesn't recolour the
    // character underneath (unlike 'block', which overrides char colour with
    // theme.cursorAccent). In Hidden mode the box-shadow renders transparent
    // (#00000000 fast-path through xterm's parseColor); in Visible mode it
    // renders in theme.foreground. cursorInactiveStyle starts as 'none' so
    // hidden panes never show an outline; the DECTCEM detector switches it to
    // 'bar' when upgrading to Visible mode so unfocused panes still show a
    // dimmed cursor (xterm-dim class) matching cc's DECTCEM state.
    cursorStyle: 'bar',
    cursorInactiveStyle: 'none',
    fontSize: scaleToPx(loadFontScale()),
    fontFamily,
    fontWeight: '500',
    fontWeightBold: '700',
    theme: cursorTheme(),
    scrollback: 5000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  // DECTCEM detection: CC v2.1.206+ manages cursor visibility itself via
  // CSI ?25l/?25h. First time we see param 25 in either handler, upgrade this
  // session from Hidden to Visible cursor mode so xterm draws a real caret
  // whose show/hide state cc controls via the DECTCEM byte-stream itself.
  // Returning false lets xterm's default handler run — we only observe, we
  // don't consume. One-way switch: no need to detect a downgrade because a
  // given cc process only uses one strategy.
  //
  // Params comes in the documented `(number | number[])[]` shape — xterm's
  // ParserApi (common/public/ParserApi.ts) already runs `.toArray()` on the
  // internal IParams before invoking us. Sub-parametered forms like `?25:1;h`
  // show up as `[25, [1]]`, which is why `some` needs the Array.isArray
  // branch; single-param and multi-param variants (?1049;25h — the modeSetup
  // reattach path) come in flat as `[25]` and `[1049, 25]` respectively.
  const detectDectcem = (params: (number | number[])[]): boolean => {
    if (cursorVisibleMode) return false;
    const has25 = params.some((p) => Array.isArray(p) ? p.includes(25) : p === 25);
    if (has25) {
      cursorVisibleMode = true;
      term.options.theme = cursorTheme();
      term.options.cursorInactiveStyle = 'bar';
    }
    return false;
  };
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, detectDectcem);
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, detectDectcem);
  // The viewport scrollbar is hidden in CSS (cc runs in alt-screen; scrollback
  // never surfaces), but FitAddon still subtracts the browser's native
  // scrollbar width (~17px on Windows) from the width it uses to compute cols
  // — reserving a column-width strip of dead space at the pane's right edge.
  // Zero it out so cols fills the full pane. The property is a getter reading
  // an internal `_browserScrollbarWidth`; redefine it as a plain 0 that
  // survives xterm's own re-probes.
  try {
    const viewportCore = (term as any)._core?.viewport;
    if (viewportCore) {
      Object.defineProperty(viewportCore, 'scrollBarWidth', { value: 0, writable: true, configurable: true });
    }
  } catch {}
  if (!measureOnly) term.focus();
  let raf = 0;
  let lastCols = term.cols;
  let lastRows = term.rows;
  // Sticky fit: skip a ±1-col proposal that keeps rows unchanged. cell.width
  // is fractional (Consolas @ 14px → 8.408) and the parent pane can drift by
  // ~half a cell from grid-track rounding or a font-metrics swap when the CJK
  // fallback finishes loading, so fit.propose() can jitter cols by 1 with no
  // real layout change. Each jitter fires a term.resize which round-trips as
  // a resize WS msg; cc's conpty only applies its new cols after the msg is
  // processed, so bytes cc emitted at the old cols keep flowing during the
  // gap — landing in a client already reflowed to new cols and producing the
  // "1 char at right edge + next line clipped" wrap seen in the bug screenshot.
  // A ≥2-col or any-row change is a real layout shift (tabs↔grid, viewport
  // resize) and must still go through.
  const H_PAD = 7;
  const fitSticky = (force = false) => {
    const dims = fit.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
    // Reserve H_PAD pixels of horizontal breathing room on each side. FitAddon
    // proposes cols = floor(paneWidth / cellWidth); we recompute against
    // (paneWidth - 2*H_PAD) so the rendered grid stops short of both edges.
    // The residual fractional-cell slack after that is split evenly by
    // shifting .xterm-screen right (xterm mouse-coord translation reads
    // screen.getBoundingClientRect, so shifting via `left` stays consistent).
    const core = (term as any)._core;
    const cellWidth: number = core?._renderService?.dimensions?.css?.cell?.width
      ?? core?._renderService?.dimensions?.actualCellWidth
      ?? (container.clientWidth / Math.max(dims.cols, 1));
    const paneW = container.clientWidth;
    const targetCols = Math.max(2, Math.floor((paneW - H_PAD * 2) / cellWidth));
    const targetRows = dims.rows;
    const stable =
      !force &&
      targetRows === term.rows &&
      Math.abs(targetCols - term.cols) <= 1;
    if (!stable) {
      try { term.resize(targetCols, targetRows); } catch {}
    }
    const el = term.element;
    const screen = el?.querySelector('.xterm-screen') as HTMLElement | null;
    if (screen) {
      const screenW = term.cols * cellWidth;
      const slack = Math.max(0, paneW - screenW);
      screen.style.left = Math.round(slack / 2) + 'px';
    }
  };
  const fitToContainer = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => fitSticky(false));
  };
  fitToContainer();
  // Primary font (Maple Mono NF CN) loads asynchronously. Two problems the
  // initial fitToContainer() above can't solve on its own:
  //   1. When fonts.ready resolves, xterm has NOT yet remeasured cell.width —
  //      the render service still holds the fallback (Cascadia/Consolas)
  //      metrics until something forces a fresh char-size probe. So a plain
  //      refit here reads the same stale cellWidth and computes the same
  //      cols, no-op.
  //   2. Even after forcing a remeasure, the delta from fallback → primary
  //      typically moves cols by exactly 1, which the sticky guard suppresses
  //      to prevent conpty round-trip jitter. On first mount there's no
  //      round-trip to protect, so we must commit that 1-col shift.
  // Fix: on fonts.ready, poke xterm's char-size service to remeasure, then
  // run fitSticky with force=true so the ±1-col guard steps aside.
  const fontsReady = (document as any).fonts?.ready;
  if (fontsReady && typeof fontsReady.then === 'function') {
    fontsReady.then(() => {
      try { (term as any)._core?._charSizeService?.measure(); } catch {}
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => fitSticky(true));
    }, () => {});
  }

  // Only observe the pane container. It's the grid item cc sits inside, so
  // window resizes and layout-mode changes both bubble through here. Also
  // observing documentElement fires an extra refit on every font-loaded /
  // scrollbar-toggled / devtools-docked event without adding real information,
  // and each extra refit is another chance to trip the resize/conpty gap above.
  const ro = measureOnly ? null : new ResizeObserver(fitToContainer);
  ro?.observe(container);

  clampImePosition(container, term);

  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.key === 'Enter' && e.ctrlKey && !e.shiftKey && !e.altKey) {
      term.input('\n');
      return false;
    }
    // Let the browser dispatch a real `paste` event for Ctrl+V / Cmd+V.
    // Without this, xterm swallows the keystroke and emits `^V` (\x16) to the
    // PTY, so neither text nor images ever flow through the clipboard pipeline.
    if (e.type === 'keydown' && (e.key === 'v' || e.key === 'V') &&
        (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      return false;
    }
    return true;
  });

  const clipboard = attachClipboard(container, term);
  container.addEventListener('mousedown', () => term.focus());

  return {
    term,
    // Shadow the raw addon so callers that trigger a refit externally
    // (attach.ts relayout, session/index.ts window.resize, loadSnapshot below)
    // route through the sticky path too — the H_PAD-7 offset + ±1-col guard
    // must apply uniformly, or a raw fit will resize cols wider than the
    // visible pane and any writes that follow wrap at the wrong column.
    // `proposeDimensions` stays wired to the raw addon for measureSize's probe.
    fit: { fit: fitSticky, proposeDimensions: () => fit.proposeDimensions() },
    write(data: string) { term.write(data); },
    /** Swap the base theme (user picked a different theme in the topbar) while
     * preserving this session's cursor mode. Direct `term.options.theme = ...`
     * would reinstate the theme's raw cursor colour and blow away either the
     * Hidden or Visible override — so topbar's onchange calls this instead. */
    setBaseTheme(theme: any): void {
      currentBaseTheme = theme;
      term.options.theme = cursorTheme();
    },
    loadSnapshot(snapshot: TerminalSnapshot) {
      // Fit BEFORE replay so xterm's grid matches the pane it will paint into —
      // otherwise a snapshot taller than the default 80×24 grid gets truncated.
      // Must go through fitSticky (not the raw addon), same reason as above:
      // the raw addon computes cols = floor(bodyW / cellW), which overshoots
      // the H_PAD-7-adjusted target by ~2 cols. `session.attached` runs this
      // on every fresh mount (session.created → session.attach → this) so a
      // raw fit here was the "right-edge overflow until a layout toggle" bug —
      // the toggle re-ran fitSticky and restored the correct cols. Force=true
      // so the ±1-col sticky guard steps aside on first mount.
      try { fitSticky(true); } catch {}
      term.reset();
      const lines = snapshot.lines;
      const body = lines.map((line, index) => {
        const clearLine = '\x1b[2K';
        const nextLine = index === lines.length - 1 ? '' : '\r\n';
        return `${clearLine}${line}${nextLine}`;
      }).join('');
      // Restore DEC private modes BEFORE the buffer text: cc runs in alt-screen
      // (`?1049h`) with SGR mouse tracking (`?1000h;?1006h`) + bracketed paste
      // (`?2004h`) enabled during startup, and the snapshot is only the rendered
      // text — the mode state itself was never in the byte stream. Without this
      // prefix, a fresh xterm re-attaches with mouse tracking OFF, wheel goes
      // to empty local scrollback, and the terminal looks unscrollable until
      // the user types (any keypress round-trips through the PTY and cc's
      // rewrite re-emits the mode sets).
      // `?? ''` guards against an older server that doesn't emit modeSetup —
      // without it the template literal would `String(undefined)` and write
      // the literal 8-char string "undefined" into the buffer as the first
      // row. `?? ''` also treats null/absent identically to "no modes on".
      term.write(`${snapshot.modeSetup ?? ''}${body}`, () => {
        const lastLineIndex = Math.max(lines.length - 1, 0);
        const offsetFromBottom = lastLineIndex - snapshot.cursorY;
        const relativeRow = Math.max(0, Math.min(term.rows - 1, term.rows - 1 - offsetFromBottom));
        const relativeCol = Math.max(0, Math.min(term.cols - 1, snapshot.cursorX));
        term.write(`\x1b[${relativeRow + 1};${relativeCol + 1}H`, () => {
          if (term.rows > 0) term.refresh(0, term.rows - 1);
        });
      });
    },
    onInput(handler: (data: string) => void) { term.onData(handler); },
    onResize(handler: (cols: number, rows: number) => void) {
      term.onResize(({ cols, rows }) => {
        if (cols === lastCols && rows === lastRows) return;
        lastCols = cols;
        lastRows = rows;
        handler(cols, rows);
      });
    },
    dispose() { cancelAnimationFrame(raf); ro?.disconnect(); clipboard.dispose(); term.dispose(); },
  };
}
