import { test, expect } from '@playwright/test';
import themes from 'xterm-theme';
import {
  HIDDEN_THEMES,
  POPULAR_THEMES,
  DEFAULT_THEME_NAME,
  getThemeCatalog,
  resolveThemeName,
} from '../src/client/themeCatalog.js';

// The catalog is the whole answer to "how do we cut ~150 shipped themes
// down to a picker a human can scan." Everything in here is opinionated
// — the tests lock the opinions in place so a well-meaning refactor
// can't quietly ship an unreadable option or a duplicate.

test.describe('HIDDEN_THEMES', () => {
  test('every hidden name actually exists in xterm-theme', () => {
    // Guards against typos in the hidden list — a name that isn't in the
    // upstream package can't hide anything and just noises up the code.
    const all = new Set(Object.keys(themes as Record<string, unknown>));
    for (const name of HIDDEN_THEMES) {
      expect(all.has(name), `HIDDEN theme "${name}" missing from xterm-theme`).toBe(true);
    }
  });

  test('every non-default hidden theme has contrast(fg, bg) < 3 or is a duplicate', () => {
    // The rule is: only hide entries that are either unreadable (< 3:1
    // WCAG) or a documented duplicate. If someone adds a theme here
    // because they personally don't like it, the test flunks and forces
    // them to justify the exclusion.
    const documentedDuplicates = new Set([
      'Parasio_Dark',
      'Solarized_Dark_Patched',
      'Violet_Light',
    ]);
    for (const name of HIDDEN_THEMES) {
      if (name === 'default') continue; // no fg/bg by design
      if (documentedDuplicates.has(name)) continue;
      const th = (themes as any)[name];
      const ratio = contrast(th.foreground, th.background);
      expect(ratio, `HIDDEN theme "${name}" has contrast ${ratio.toFixed(2)} ≥ 3:1 — not hideable on readability grounds`).toBeLessThan(3);
    }
  });
});

test.describe('POPULAR_THEMES', () => {
  test('every popular name exists in xterm-theme', () => {
    // Same guard as the HIDDEN list; a popular typo would render as a
    // "select something and get an empty terminal" landmine.
    const all = new Set(Object.keys(themes as Record<string, unknown>));
    for (const name of POPULAR_THEMES) {
      expect(all.has(name), `POPULAR theme "${name}" missing from xterm-theme`).toBe(true);
    }
  });

  test('no popular theme is also hidden', () => {
    // A rename mistake could put the same name in both lists. Since
    // getThemeCatalog filters HIDDEN out of popular silently, this
    // check surfaces the contradiction loudly.
    for (const name of POPULAR_THEMES) {
      expect(HIDDEN_THEMES.has(name), `POPULAR theme "${name}" is also in HIDDEN — pick one`).toBe(false);
    }
  });

  test('every popular theme is readable (contrast ≥ 4.5)', () => {
    // 4.5:1 is WCAG AA for normal text (terminals are "normal" — under the
    // ~18pt / 14pt-bold "large" threshold). A Popular entry pitched to a
    // first-time user should clear at least AA-normal, otherwise we're
    // pointing them at an actively uncomfortable choice. If a Popular
    // entry drops below 4.5, replace it rather than relaxing the guard —
    // Solarized_Dark (4.29 in xterm-theme's port) is the reason this rule
    // exists as a Popular check, and it lives in "More" for that reason.
    for (const name of POPULAR_THEMES) {
      const th = (themes as any)[name];
      const ratio = contrast(th.foreground, th.background);
      expect(ratio, `POPULAR theme "${name}" has contrast ${ratio.toFixed(2)} < 4.5:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('POPULAR order is preserved by getThemeCatalog.popular', () => {
    // getThemeCatalog filters unavailable / hidden names, but the
    // remaining list must be in the curation order — that ordering
    // is what puts light-mode picks near the default at the top.
    const cat = getThemeCatalog();
    const stillOffered = POPULAR_THEMES.filter(
      n => !HIDDEN_THEMES.has(n) && (themes as any)[n],
    );
    expect(cat.popular).toEqual(stillOffered);
  });
});

test.describe('getThemeCatalog', () => {
  test('popular and others are disjoint', () => {
    const cat = getThemeCatalog();
    const popSet = new Set(cat.popular);
    for (const name of cat.others) {
      expect(popSet.has(name), `"${name}" appears in both popular and others`).toBe(false);
    }
  });

  test('neither list contains a HIDDEN theme', () => {
    // Regression fence: HIDDEN is filtered inside getThemeCatalog, not
    // in every consumer. If a hidden name leaks into either group, the
    // picker starts offering it again — which is exactly what we're
    // trying to prevent.
    const cat = getThemeCatalog();
    for (const name of [...cat.popular, ...cat.others]) {
      expect(HIDDEN_THEMES.has(name), `HIDDEN theme "${name}" leaked into the catalog`).toBe(false);
    }
  });

  test('every shipped non-hidden theme is offered somewhere', () => {
    // Together, popular ∪ others must equal (all - hidden). Otherwise
    // a theme is quietly missing from the picker without being on the
    // hidden list — an unintended drop.
    const cat = getThemeCatalog();
    const offered = new Set([...cat.popular, ...cat.others]);
    for (const name of Object.keys(themes as Record<string, unknown>)) {
      if (HIDDEN_THEMES.has(name)) continue;
      expect(offered.has(name), `theme "${name}" is neither offered nor hidden — where did it go?`).toBe(true);
    }
  });

  test('others is sorted alphabetically (case-insensitive)', () => {
    // The "More" group is a long alphabetized list. Verifying the sort
    // means a user scanning for "Ubuntu" can trust it's near the U's.
    const cat = getThemeCatalog();
    const sorted = [...cat.others].sort((a, b) => a.localeCompare(b));
    expect(cat.others).toEqual(sorted);
  });
});

test.describe('resolveThemeName', () => {
  test('accepts a currently-offered name unchanged', () => {
    expect(resolveThemeName('OneHalfLight')).toBe('OneHalfLight');
    expect(resolveThemeName('Dracula')).toBe('Dracula');
  });

  test('maps hidden names to the default', () => {
    // A user with a persisted `default` from an earlier version must not
    // get the placeholder theme (no fg/bg) — coerce back to OneHalfLight.
    expect(resolveThemeName('default')).toBe(DEFAULT_THEME_NAME);
    expect(resolveThemeName('C64')).toBe(DEFAULT_THEME_NAME);
  });

  test('maps unknown names to the default', () => {
    // A theme that xterm-theme dropped between releases won't be found;
    // don't crash — hand back the default and let the user reselect.
    expect(resolveThemeName('SomeThemeThatNeverExisted')).toBe(DEFAULT_THEME_NAME);
  });

  test('null / undefined / empty resolve to the default', () => {
    // These are the "fresh browser, nothing stored" cases and the
    // "storage returned null" case — both must land on the default
    // rather than propagating `null` into the terminal constructor.
    expect(resolveThemeName(null)).toBe(DEFAULT_THEME_NAME);
    expect(resolveThemeName(undefined)).toBe(DEFAULT_THEME_NAME);
    expect(resolveThemeName('')).toBe(DEFAULT_THEME_NAME);
  });
});

/** WCAG 2.x relative-luminance contrast, same formula the CSS4 color-contrast
 *  spec references. Kept private to this file — the runtime doesn't need it,
 *  only the specs that lock the "unreadable" rule for HIDDEN entries. */
function contrast(fg: string, bg: string): number {
  const l1 = relLum(fg);
  const l2 = relLum(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}
function relLum(hex: string): number {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
