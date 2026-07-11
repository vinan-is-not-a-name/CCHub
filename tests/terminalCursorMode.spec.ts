import { test, expect } from '@playwright/test';

/**
 * DECTCEM-driven cursor mode switch (bug #262).
 *
 * CC's cursor strategy differs by version:
 *   - Legacy (v2.1.139 and earlier): paints its own caret as reverse-video
 *     ([CSI 7m]<char>[CSI 27m]); never emits DECTCEM. Session must stay in
 *     Hidden mode (theme.cursor = #00000000) or xterm's cursor collides with
 *     cc's pseudo-caret and drags along every CUP move during a spinner.
 *   - Modern (v2.1.206+): emits CSI ?25l/?25h (DECTCEM) expecting the terminal
 *     to draw the caret. Session must upgrade to Visible mode (theme.cursor =
 *     theme.foreground) or the user sees no caret at all — the #262 bug.
 *
 * terminal.ts registers a CSI ?l/?h handler that detects DECTCEM (param 25)
 * and one-way-upgrades Hidden → Visible on the first sighting. This spec pins
 * every branch of that decision so a future refactor of createTerminal cannot
 * silently revert one CC generation without failing here first.
 *
 * Runs against the harness (harness.ts) so createTerminal + its CSI-handler
 * registration go through the exact production path — no mock parser. All
 * writes use `writeSync` so the parser flush completes before we read state
 * (xterm's `term.write` is asynchronous — parse runs on a microtask).
 */
test.describe('terminal cursor mode (DECTCEM detection)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/harness.html?e2e=1');
    await page.waitForFunction(() => '__ccHarness' in window);
  });

  test('starts in Hidden mode: cursor + accent are transparent, inactive is none', async ({ page }) => {
    const state = await page.evaluate(() => {
      const h = (window as any).__ccHarness;
      const id = h.addSession();
      return h.cursorState(id);
    });
    expect(state.cursor).toBe('#00000000');
    expect(state.cursorAccent).toBe('#00000000');
    expect(state.cursorInactiveStyle).toBe('none');
  });

  test('non-25 DEC private modes do NOT trigger upgrade', async ({ page }) => {
    // Everything CC v2.1.139 actually emits at startup (mouse tracking +
    // bracketed paste). These share final=h / prefix=? with DECTCEM and go
    // through the same registered handler, so this test proves the param
    // filter `params.includes(25)` is doing real work.
    const state = await page.evaluate(async () => {
      const h = (window as any).__ccHarness;
      const id = h.addSession();
      await h.writeSync(id, '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?2004h');
      return h.cursorState(id);
    });
    expect(state.cursor).toBe('#00000000');
    expect(state.cursorInactiveStyle).toBe('none');
  });

  test('CSI ?25h upgrades to Visible: cursor becomes theme.foreground, inactive becomes bar', async ({ page }) => {
    const state = await page.evaluate(async () => {
      const h = (window as any).__ccHarness;
      const id = h.addSession();
      await h.writeSync(id, '\x1b[?25h');
      return h.cursorState(id);
    });
    // OneHalfLight is the harness default (localStorage is empty in the
    // fresh Chromium context). Its foreground is #383a42 — that is what
    // withVisibleCursor pins on cursor.
    expect(state.cursor).toBe('#383a42');
    expect(state.cursorAccent).toBe('#fafafa');
    expect(state.cursorInactiveStyle).toBe('bar');
  });

  test('CSI ?25l alone also upgrades — either l or h is a DECTCEM signal', async ({ page }) => {
    // cc v2.1.206 often opens by hiding the caret before the first spinner
    // tick, so ?25l may arrive before ?25h. Both handlers must upgrade.
    const state = await page.evaluate(async () => {
      const h = (window as any).__ccHarness;
      const id = h.addSession();
      await h.writeSync(id, '\x1b[?25l');
      return h.cursorState(id);
    });
    expect(state.cursor).toBe('#383a42');
    expect(state.cursorInactiveStyle).toBe('bar');
  });

  test('multi-param CSI (?1049;25h) also triggers upgrade — modeSetup replay path', async ({ page }) => {
    // Server-side terminalScreen.buildModeSetup concatenates every enabled
    // DEC private mode into ONE CSI on reattach. If cc had ever emitted
    // ?25h, the client sees ?1049;1000;...;25h as a single sequence with
    // params = [1049, 1000, ..., 25]. The detector must find 25 anywhere in
    // that param list, or reattaching to a modern-cc session loses the
    // cursor upgrade.
    const state = await page.evaluate(async () => {
      const h = (window as any).__ccHarness;
      const id = h.addSession();
      await h.writeSync(id, '\x1b[?1049;1000;25h');
      return h.cursorState(id);
    });
    expect(state.cursor).toBe('#383a42');
  });

  test('upgrade is one-way: once Visible, a subsequent ?25l does not revert to Hidden', async ({ page }) => {
    // cc emits ?25l/?25h many times per spinner tick to hide + reshow the
    // caret. Downgrading each time would flash Hidden between ticks and
    // negate the point of the upgrade. One-way is the invariant.
    const state = await page.evaluate(async () => {
      const h = (window as any).__ccHarness;
      const id = h.addSession();
      await h.writeSync(id, '\x1b[?25h');
      await h.writeSync(id, '\x1b[?25l');
      return h.cursorState(id);
    });
    expect(state.cursor).toBe('#383a42');
    expect(state.cursorInactiveStyle).toBe('bar');
  });

  test('setBaseTheme preserves Hidden state — theme swap without prior DECTCEM stays Hidden', async ({ page }) => {
    // Local (legacy-cc) session picks a different theme in the topbar. The
    // cursor must NOT surface, because the pseudo-caret would double up.
    const state = await page.evaluate(() => {
      const h = (window as any).__ccHarness;
      const id = h.addSession();
      h.setBaseTheme(id, { background: '#000', foreground: '#fff', cursor: '#aaa' });
      return h.cursorState(id);
    });
    expect(state.cursor).toBe('#00000000');
    expect(state.cursorAccent).toBe('#00000000');
  });

  test('setBaseTheme preserves Visible state and rebases on the new theme foreground', async ({ page }) => {
    // Remote (modern-cc) session that has already upgraded. Switching themes
    // must keep the cursor visible AND recompute its colour from the new
    // theme's foreground — otherwise a dark→light theme swap leaves the
    // cursor a stale colour that may blend into the new background.
    const state = await page.evaluate(async () => {
      const h = (window as any).__ccHarness;
      const id = h.addSession();
      await h.writeSync(id, '\x1b[?25h');
      h.setBaseTheme(id, { background: '#000', foreground: '#fff', cursor: '#aaa' });
      return h.cursorState(id);
    });
    expect(state.cursor).toBe('#fff');
    expect(state.cursorAccent).toBe('#000');
  });
});
