import { test, expect } from '@playwright/test';
import {
  BASE_FONT_PX,
  FONT_SCALES,
  DEFAULT_SCALE,
  parseFontScale,
  scaleToPx,
  loadFontScale,
  saveFontScale,
} from '../src/client/views/fontScale.js';

// fontScale.ts is the pure core of the per-terminal font-size feature: the
// selectable percentages, the clamp/coerce, the px conversion xterm consumes,
// and the localStorage round-trip. The DOM application (topbar select →
// term.options.fontSize + refit) is exercised in e2e.spec; here we pin the
// math + persistence so a loosened clamp or a wrong px value is caught cheaply.

test.describe('font scale options', () => {
  test('ascending percentages with 100 present as default', () => {
    expect([...FONT_SCALES]).toEqual([75, 90, 100, 110, 125, 150]);
    expect(FONT_SCALES).toContain(DEFAULT_SCALE);
    const sorted = [...FONT_SCALES].sort((a, b) => a - b);
    expect([...FONT_SCALES]).toEqual(sorted);
  });
});

test.describe('parseFontScale', () => {
  test('passes through in-range integers', () => {
    expect(parseFontScale(100)).toBe(100);
    expect(parseFontScale(75)).toBe(75);
    expect(parseFontScale(150)).toBe(150);
  });

  test('accepts numeric strings (localStorage round-trips as string)', () => {
    expect(parseFontScale('125')).toBe(125);
  });

  test('rounds fractional input', () => {
    expect(parseFontScale(110.4)).toBe(110);
  });

  test('coerces out-of-range and garbage to the default', () => {
    for (const bad of [0, 10, 59, 201, 999, -100, NaN, Infinity, 'big', '', null, undefined, {}]) {
      expect(parseFontScale(bad)).toBe(DEFAULT_SCALE);
    }
  });
});

test.describe('scaleToPx', () => {
  test('100% maps to the base px', () => {
    expect(scaleToPx(100)).toBe(BASE_FONT_PX);
  });

  test('scales proportionally and rounds (in-range percentages)', () => {
    // scaleToPx clamps via parseFontScale ([60,200]→default), so it only does
    // proportional math for in-range values. Use real FONT_SCALES options to
    // pin the rounding; out-of-range coercion is covered separately below.
    expect(scaleToPx(150)).toBe(21); // 14*1.50 = 21
    expect(scaleToPx(125)).toBe(18); // 14*1.25 = 17.5 → 18
    expect(scaleToPx(110)).toBe(15); // 14*1.10 = 15.4 → 15
    expect(scaleToPx(90)).toBe(13);  // 14*0.90 = 12.6 → 13
    expect(scaleToPx(75)).toBe(11);  // 14*0.75 = 10.5 → 11
  });

  test('a sub-floor scale is clamped to the default px (not raw proportional)', () => {
    // 50 is below the 60 floor, so it coerces to the default rather than 7px —
    // mirrors parseFontScale's 59→default contract; guards against an
    // unreadable terminal from a corrupt stored value.
    expect(scaleToPx(50)).toBe(BASE_FONT_PX);
  });

  test('an out-of-range scale falls back to the default px', () => {
    expect(scaleToPx(9999)).toBe(BASE_FONT_PX);
  });
});

test.describe('load/save round-trip (injected storage)', () => {
  function fakeStorage(initial: Record<string, string> = {}) {
    const map = new Map(Object.entries(initial));
    return {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => { map.set(k, v); },
    };
  }

  test('save then load returns the same scale', () => {
    const store = fakeStorage();
    saveFontScale(125, store);
    expect(loadFontScale(store)).toBe(125);
  });

  test('empty storage loads the default', () => {
    expect(loadFontScale(fakeStorage())).toBe(DEFAULT_SCALE);
  });

  test('a corrupt stored value falls back to the default', () => {
    expect(loadFontScale(fakeStorage({ 'cchub-font-scale': 'junk' }))).toBe(DEFAULT_SCALE);
  });

  test('a throwing storage is swallowed (load + save never throw)', () => {
    const throwing = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    expect(loadFontScale(throwing)).toBe(DEFAULT_SCALE);
    expect(() => saveFontScale(125, throwing)).not.toThrow();
  });
});
