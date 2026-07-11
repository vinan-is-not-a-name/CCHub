import { test, expect } from '@playwright/test';
import themes from 'xterm-theme';
import { withHiddenCursor, withVisibleCursor } from '../src/client/terminalTheme.js';

// The exact literal MUST be `#00000000` (alpha-0 hex), not the CSS keyword
// `transparent`. xterm's `parseColor` (ThemeService.ts) validates colours
// via a canvas fillStyle probe that REJECTS zero-alpha CSS keywords — the
// rejected value silently falls back to `DEFAULT_CURSOR = '#ffffff'`, and
// the resulting white outline is invisible on light themes but glaringly
// bright on dark ones. The `#rrggbbaa` form is matched by the fast-path
// regex before the canvas check ever runs, so it survives to render as an
// actually-transparent cursor / outline. This is a load-bearing detail —
// don't relax the assertion to `expect.stringContaining('0')` or similar.
test.describe('withHiddenCursor', () => {
  test('OneHalfLight normally exposes a coloured cursor (baseline)', () => {
    const base = (themes as any).OneHalfLight;
    // Sanity: if xterm-theme ever ships a transparent cursor upstream, this
    // helper becomes redundant — surface that here.
    expect(base.cursor).toBe('#bfceff');
  });

  test('overrides cursor + cursorAccent to #00000000, leaves other keys intact', () => {
    const base = (themes as any).OneHalfLight;
    const patched = withHiddenCursor(base);
    expect(patched.cursor).toBe('#00000000');
    expect(patched.cursorAccent).toBe('#00000000');
    expect(patched.background).toBe(base.background);
    expect(patched.foreground).toBe(base.foreground);
    expect(patched.blue).toBe(base.blue);
  });

  test('returns a new object without mutating the source theme', () => {
    const base = (themes as any).OneHalfLight;
    const beforeCursor = base.cursor;
    const patched = withHiddenCursor(base);
    expect(patched).not.toBe(base);
    expect(base.cursor).toBe(beforeCursor);
  });

  test('works on an unknown / minimal theme too', () => {
    const patched = withHiddenCursor({ background: '#000', foreground: '#fff' });
    expect(patched.cursor).toBe('#00000000');
    expect(patched.cursorAccent).toBe('#00000000');
    expect(patched.background).toBe('#000');
    expect(patched.foreground).toBe('#fff');
  });
});

// withVisibleCursor is the runtime companion — terminal.ts detects DECTCEM
// (CSI ?25l/?25h) emitted by newer CC versions and upgrades the session from
// Hidden to Visible cursor mode. The upgrade must produce a contrast-safe
// caret against the theme's background, which is why we lock the cursor to
// theme.foreground rather than theme.cursor (many xterm-theme entries assign
// low-contrast tints like #bfceff to cursor that are hard to see).
test.describe('withVisibleCursor', () => {
  test('cursor uses theme.foreground, not theme.cursor', () => {
    const base = (themes as any).OneHalfLight;
    // Sanity: OneHalfLight ships a distinct (paler) cursor colour.
    expect(base.cursor).toBe('#bfceff');
    expect(base.foreground).toBe('#383a42');
    const patched = withVisibleCursor(base);
    // We deliberately use foreground for contrast — pinning this so a future
    // refactor doesn't silently switch to base.cursor and leave users with a
    // near-invisible caret on light themes.
    expect(patched.cursor).toBe('#383a42');
    expect(patched.cursorAccent).toBe(base.background);
  });

  test('leaves non-cursor theme keys intact', () => {
    const base = (themes as any).OneHalfLight;
    const patched = withVisibleCursor(base);
    expect(patched.background).toBe(base.background);
    expect(patched.foreground).toBe(base.foreground);
    expect(patched.blue).toBe(base.blue);
  });

  test('returns a new object without mutating the source', () => {
    const base = (themes as any).OneHalfLight;
    const beforeCursor = base.cursor;
    const patched = withVisibleCursor(base);
    expect(patched).not.toBe(base);
    expect(base.cursor).toBe(beforeCursor);
  });

  test('falls back to safe defaults on a minimal theme with no foreground', () => {
    const patched = withVisibleCursor({});
    expect(patched.cursor).toBe('#000000');
    expect(patched.cursorAccent).toBe('#ffffff');
  });
});
