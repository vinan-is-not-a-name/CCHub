import type { SessionInfo, SessionState } from '../../shared/protocol.js';
import { createTerminal } from '../terminal.js';
import { isGridLayout, layoutColumns, type LayoutMode } from './layout.js';
import { renderSessionLabel, sessionLabel } from './sessionLabel.js';
import { t } from '../i18n.js';

export type TerminalHandle = ReturnType<typeof createTerminal>;

export { reportedRows } from './reportedRows.js';

/** The DOM a single session owns: an outer pane (grid item / absolute stack
 * layer), a head bar (state dot + name + close, shown only in grid mode), and
 * a body that the xterm instance mounts into. */
export interface PaneParts {
  pane: HTMLDivElement;
  body: HTMLDivElement;
  terminal: TerminalHandle;
}

/**
 * Probe the actual container with a hidden xterm + FitAddon to derive the cols/rows
 * the real session will see. Hardcoded width/8 estimation is off by ±6 columns
 * under different fonts and DPRs and produces visible wrap mismatches.
 *
 * The probe MUST occupy the same box the real xterm will:
 *
 *  - Cell 1/1 of the grid — a stand-in for the pane's grid item. An
 *    `absolute; inset:0` probe would stretch to the container's padding-box
 *    (1128px) while a grid item sits in the content-box (1112px), so the probe
 *    would over-estimate cols by ~2 and the first PTY screen would wrap 2 chars
 *    wider than the xterm view that immediately re-fits down. The resulting
 *    first-paint wrap looked like cc's content was wrapping in a column
 *    narrower than the visible terminal — most obvious in wide viewports where
 *    banners and box-drawing lines straddle the 2-col delta.
 *  - In grid layouts (cols-*), `.pane-head` (dot + name + close) is visible
 *    above `.pane-body` and eats ~33px + 1px border-bottom of the pane's
 *    height. A bare-div probe misses that entirely and over-estimates rows by
 *    ~2. Claude then paints its input area (border / `❯` / border / bypass
 *    status) using absolute cursor moves at those rows; xterm clamps positions
 *    past its last row to the bottom row, and the overlapping writes collapse
 *    into a single compound row like `──⏵⏵ bypass permissions ... · …─` at the
 *    bottom of the visible terminal. So in grid mode the probe mirrors the
 *    real pane's DOM: `.term-pane.is-grid` with a fully-populated `.pane-head`
 *    (so CSS gives it the same computed height) and a `.pane-body` that hosts
 *    the xterm.
 *
 *  In tabs mode `.pane-head` is `display: none` and the pane fills the whole
 *  grid cell, so the historical bare-div probe already matches — no head/body
 *  scaffolding needed.
 */
export function measureSize(container: HTMLElement): { cols: number; rows: number } {
  const isGrid = container.dataset.layout?.startsWith('cols-') ?? false;

  const probe = document.createElement('div');
  probe.dataset.measure = 'true';
  probe.style.cssText = 'grid-area:1/1;min-width:0;min-height:0;overflow:hidden;visibility:hidden;pointer-events:none;z-index:-1;';

  let mount: HTMLElement = probe;
  if (isGrid) {
    probe.className = 'term-pane is-grid';
    const head = document.createElement('div');
    head.className = 'pane-head';
    // The head's height is content-driven (padding + tallest child), so give
    // it the same children the real head has. Empty <span>/<button> tags with
    // the same classes let CSS recreate the same 33px.
    const dot = document.createElement('span');
    dot.className = 'pane-state-dot';
    dot.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'pane-name';
    name.textContent = 'probe';
    const close = document.createElement('button');
    close.className = 'pane-close';
    close.type = 'button';
    close.textContent = '×';
    head.append(dot, name, close);
    const body = document.createElement('div');
    body.className = 'pane-body';
    body.dataset.measure = 'true';
    probe.append(head, body);
    mount = body;
  }

  container.appendChild(probe);
  try {
    const t = createTerminal(mount);
    // Run the sticky fit synchronously — its H_PAD-7 offset shrinks cols by
    // ~2 vs the raw FitAddon.proposeDimensions. If we sent the raw cols to
    // the server, the PTY would launch 2 cols wider than the client's real
    // grid, and every box-drawing line cc emits would get truncated on the
    // right until the user did a layout toggle (which re-fits sticky).
    t.fit.fit();
    const cols = t.term.cols;
    const rows = t.term.rows;
    t.dispose();
    if (cols > 0 && rows > 0) {
      return { cols: Math.max(20, cols), rows: Math.max(5, rows) };
    }
  } finally {
    probe.remove();
  }
  const rect = container.getBoundingClientRect();
  return {
    cols: Math.max(20, Math.floor(rect.width / 8)),
    rows: Math.max(5, Math.floor(rect.height / 17)),
  };
}

/** Build a session's pane. The head is always in the DOM but hidden by CSS in
 * tabs mode (where the rail carries identity); it surfaces in grid mode so each
 * tiled pane shows its own name + live state and can be closed independently.
 * `onFocus` lets the controller move the active ring to whichever pane the user
 * clicks — the xterm textarea focus is the source of truth, so a click anywhere
 * in a pane (which focuses the terminal) activates it. */
export function attachTerminal(
  container: HTMLElement,
  handlers: {
    onInput: (data: string) => void;
    onResize: (cols: number, rows: number) => void;
    onFocus: () => void;
    onClose: () => void;
  },
): PaneParts {
  const pane = document.createElement('div');
  pane.className = 'term-pane';
  // The pane is always a grid item in #terminal-container; it starts hidden and
  // placeTerminal() reveals it. No absolute positioning — the container's grid
  // is the single sizing/clipping authority. Inline visibility is also the
  // signal the e2e suite uses to find the active terminal.
  pane.style.cssText = 'visibility:hidden;pointer-events:none;';

  const head = document.createElement('div');
  head.className = 'pane-head';

  const dot = document.createElement('span');
  dot.className = 'pane-state-dot';
  dot.setAttribute('aria-hidden', 'true');

  const name = document.createElement('span');
  name.className = 'pane-name';

  const close = document.createElement('button');
  close.className = 'pane-close';
  close.type = 'button';
  close.textContent = '×';
  close.title = t('session.close.aria');
  close.setAttribute('aria-label', t('session.close.aria'));
  close.onclick = (event) => {
    event.stopPropagation();
    handlers.onClose();
  };

  head.append(dot, name, close);

  const body = document.createElement('div');
  body.className = 'pane-body';

  pane.append(head, body);
  container.appendChild(pane);

  const terminal = createTerminal(body);
  terminal.onInput(handlers.onInput);
  terminal.onResize(handlers.onResize);
  // The textarea is xterm's focus sink; focusing it (via click or keyboard)
  // is the canonical "this pane is now active" signal.
  terminal.term.textarea?.addEventListener('focus', handlers.onFocus);

  return { pane, body, terminal };
}

/** Set the container's grid mode. CSS keys off `data-layout`; the column count
 * is handed over as a custom property so the grid template stays data-driven.
 * Also mirrors the mode onto <html> so the rail can collapse in grid modes. */
export function applyLayout(container: HTMLElement, mode: LayoutMode): void {
  container.dataset.layout = mode;
  container.style.setProperty('--grid-cols', String(layoutColumns(mode)));
  document.documentElement.dataset.layout = mode;
}

/** Refresh a pane's head: the live state (drives the dot colour + pulse via a
 * CSS class) and the display name. Cheap DOM writes, safe to call on every
 * store notification. The `tooltip` (when given) is the full session detail
 * surfaced on hover so a truncated name still shows its cwd + target. When
 * `info` is supplied the label is rendered as structured DOM (with a
 * clickable reveal link for local targets); the string-only `label` remains
 * the fallback for the harness and other bare callers. */
export function updatePaneHead(
  pane: HTMLDivElement,
  opts: {
    state: SessionState;
    label: string;
    tooltip?: string;
    info?: SessionInfo;
    onReveal?: (anchor: HTMLElement) => void;
  },
): void {
  const head = pane.querySelector('.pane-head');
  if (head) head.className = `pane-head state-${opts.state}`;
  const name = pane.querySelector<HTMLElement>('.pane-name');
  if (!name) return;
  if (opts.info) {
    renderSessionLabel(name, opts.info, opts.onReveal ?? null);
  } else {
    name.textContent = opts.label;
  }
  name.setAttribute('title', opts.tooltip ?? opts.label);
}

/** Style a pane for the current layout. The pane is always a grid item in
 * #terminal-container, so there is no position juggling: tabs mode stacks every
 * pane in cell 1/1 (CSS) and shows only the active one; grid mode tiles them all
 * (every pane visible, `active` only drives the focus ring). Always refreshes
 * the head so a pane that gains/keeps identity stays in sync on a relayout. */
export function placeTerminal(
  pane: HTMLDivElement,
  opts: {
    mode: LayoutMode;
    active: boolean;
    label: string;
    state: SessionState;
    tooltip?: string;
    info?: SessionInfo;
    onReveal?: (anchor: HTMLElement) => void;
  },
): void {
  const grid = isGridLayout(opts.mode);
  pane.dataset.ccLabel = opts.info ? sessionLabel(opts.info) : opts.label;
  pane.classList.toggle('is-active', opts.active);
  pane.classList.toggle('is-grid', grid);
  updatePaneHead(pane, {
    state: opts.state,
    label: opts.label,
    tooltip: opts.tooltip,
    info: opts.info,
    onReveal: opts.onReveal,
  });
  const visible = grid || opts.active;
  pane.style.visibility = visible ? 'visible' : 'hidden';
  pane.style.pointerEvents = visible ? 'auto' : 'none';
  pane.style.zIndex = opts.active ? '1' : '0';
}
