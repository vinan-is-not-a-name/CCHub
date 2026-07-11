import { test, expect } from '@playwright/test';
import {
  LAYOUT_MODES,
  LAYOUT_LABELS,
  DEFAULT_LAYOUT,
  isLayoutMode,
  parseLayoutMode,
  layoutColumns,
  isGridLayout,
  loadLayoutMode,
  saveLayoutMode,
} from '../src/client/views/layout.js';

// layout.ts is the pure, DOM-free core of the multi-session display feature:
// the mode enum, the tabs-vs-grid predicate, the column count CSS keys off, and
// the localStorage round-trip. The DOM application (applyLayout/placeTerminal)
// is covered end-to-end in e2e.spec; here we pin the logic that decides *what*
// gets applied so a loosened mode or a wrong column count is caught cheaply.

test.describe('layout mode enum', () => {
  test('the three shipped modes, in control order', () => {
    expect([...LAYOUT_MODES]).toEqual(['tabs', 'cols-2', 'cols-3']);
  });

  test('default is the legacy single-terminal mode', () => {
    expect(DEFAULT_LAYOUT).toBe('tabs');
  });

  test('every mode has a control label', () => {
    for (const m of LAYOUT_MODES) expect(LAYOUT_LABELS[m]).toBeTruthy();
  });
});

test.describe('isLayoutMode / parseLayoutMode', () => {
  test('accepts exactly the known modes', () => {
    for (const m of LAYOUT_MODES) expect(isLayoutMode(m)).toBe(true);
  });

  test('rejects anything else', () => {
    for (const bad of ['', 'cols-4', '2x2', 'grid', undefined, null, 2]) {
      expect(isLayoutMode(bad)).toBe(false);
    }
  });

  test('parse coerces unknown input to the default', () => {
    expect(parseLayoutMode('cols-3')).toBe('cols-3');
    expect(parseLayoutMode('bogus')).toBe(DEFAULT_LAYOUT);
    expect(parseLayoutMode(undefined)).toBe(DEFAULT_LAYOUT);
  });
});

test.describe('layoutColumns / isGridLayout', () => {
  test('column count matches the mode', () => {
    expect(layoutColumns('tabs')).toBe(1);
    expect(layoutColumns('cols-2')).toBe(2);
    expect(layoutColumns('cols-3')).toBe(3);
  });

  test('only tabs is non-grid', () => {
    expect(isGridLayout('tabs')).toBe(false);
    expect(isGridLayout('cols-2')).toBe(true);
    expect(isGridLayout('cols-3')).toBe(true);
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

  test('save then load returns the same mode', () => {
    const store = fakeStorage();
    saveLayoutMode('cols-3', store);
    expect(loadLayoutMode(store)).toBe('cols-3');
  });

  test('empty storage loads the default', () => {
    expect(loadLayoutMode(fakeStorage())).toBe(DEFAULT_LAYOUT);
  });

  test('a corrupt stored value falls back to the default', () => {
    expect(loadLayoutMode(fakeStorage({ 'cchub-layout': 'junk' }))).toBe(DEFAULT_LAYOUT);
  });

  test('a throwing storage is swallowed (load + save never throw)', () => {
    const throwing = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    expect(loadLayoutMode(throwing)).toBe(DEFAULT_LAYOUT);
    expect(() => saveLayoutMode('cols-2', throwing)).not.toThrow();
  });
});
