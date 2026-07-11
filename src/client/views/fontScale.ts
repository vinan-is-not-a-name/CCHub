// Pure, DOM-free core of the terminal font-size feature. The compact grid
// layouts shrink each pane, so users need to trade glyph size for information
// density. This module owns the scale math + persistence; the topbar view
// applies the result to live terminals (mirrors how layout.ts splits logic
// from the applyLayout DOM step). See [[layout]] for the sibling pattern.

/** xterm's base fontSize in px at 100%. Kept in sync with createTerminal(). */
export const BASE_FONT_PX = 14;

const STORAGE_KEY = 'cchub-font-scale';

/** Selectable percentages shown in the control, in ascending order. */
export const FONT_SCALES = [75, 90, 100, 110, 125, 150] as const;

export const DEFAULT_SCALE = 100;

const MIN_SCALE = 60;
const MAX_SCALE = 200;

/** Coerce arbitrary input to an in-range integer percentage, else the default.
 * Accepts numbers or numeric strings (localStorage round-trips as strings). */
export function parseFontScale(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SCALE;
  const rounded = Math.round(n);
  if (rounded < MIN_SCALE || rounded > MAX_SCALE) return DEFAULT_SCALE;
  return rounded;
}

/** Convert a percentage to the px fontSize xterm consumes. */
export function scaleToPx(scale: number): number {
  return Math.max(1, Math.round((BASE_FONT_PX * parseFontScale(scale)) / 100));
}

export function loadFontScale(store: Pick<Storage, 'getItem'> = localStorage): number {
  try {
    return parseFontScale(store.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_SCALE;
  }
}

export function saveFontScale(scale: number, store: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    store.setItem(STORAGE_KEY, String(parseFontScale(scale)));
  } catch {
    /* storage may be blocked (private mode / quota) — a non-persisted scale
       is still fully functional for the session. */
  }
}
