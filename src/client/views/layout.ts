/**
 * Session display layouts. `tabs` is the legacy single-visible-terminal mode;
 * the `cols-*` modes tile every session simultaneously in a CSS grid with the
 * given column count (cols-2 covers two-column / 2x2, cols-3 covers the
 * nine-grid). Column-count tiling — the model tmux / VS Code editor groups use —
 * means the layout degrades gracefully for any session count instead of
 * hard-coding pane slots.
 *
 * Pure + DOM-free so it unit-tests in Node; the DOM application lives in
 * views/terminal.ts (applyLayout/placeTerminal).
 */
export const LAYOUT_MODES = ['tabs', 'cols-2', 'cols-3'] as const;
export type LayoutMode = (typeof LAYOUT_MODES)[number];

export const DEFAULT_LAYOUT: LayoutMode = 'tabs';
const STORAGE_KEY = 'cchub-layout';

/** Short control labels, ordered to match LAYOUT_MODES. */
export const LAYOUT_LABELS: Record<LayoutMode, string> = {
  'tabs': 'Tabs',
  'cols-2': '2-cols',
  'cols-3': '3-cols',
};

export function isLayoutMode(value: unknown): value is LayoutMode {
  return typeof value === 'string' && (LAYOUT_MODES as readonly string[]).includes(value);
}

/** Coerce arbitrary input (querystring, stored value) to a valid mode. */
export function parseLayoutMode(value: unknown): LayoutMode {
  return isLayoutMode(value) ? value : DEFAULT_LAYOUT;
}

/** Column count for a mode; `tabs` reports 1 (single visible terminal). */
export function layoutColumns(mode: LayoutMode): number {
  return mode === 'cols-3' ? 3 : mode === 'cols-2' ? 2 : 1;
}

/** True when more than one terminal is shown at once. */
export function isGridLayout(mode: LayoutMode): boolean {
  return mode !== 'tabs';
}

/** localStorage is injectable so the round-trip is unit-testable in Node. */
export function loadLayoutMode(store: Pick<Storage, 'getItem'> = localStorage): LayoutMode {
  try {
    return parseLayoutMode(store.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function saveLayoutMode(mode: LayoutMode, store: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    store.setItem(STORAGE_KEY, mode);
  } catch {
    /* private-mode / disabled storage: layout simply won't persist */
  }
}
