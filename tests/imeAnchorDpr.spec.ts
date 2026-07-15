import { test, expect } from '@playwright/test';

// Fractional-DPR IME vertical-alignment regression.
//
// The bug: applyAnchor converts cc's caret ROW INDEX into a pixel Y with
// `row * rowHeight`. It used to read rowHeight from `.xterm-row`.offsetHeight,
// which the browser ROUNDS to an integer. But xterm sizes each row as an
// integer number of DEVICE pixels, so under a fractional devicePixelRatio (a
// 125%/150%-scaled monitor) the CSS row pitch is deviceCellPx / dpr — fractional
// whenever deviceCellPx isn't a multiple of the DPR's denominator (e.g. 26/1.5 =
// 17.33). offsetHeight reports 17, so the per-row 0.33px error multiplies by the
// row index — invisible near the top, ~6-7px off at the bottom input row where
// the caret actually sits. The pinned `.composition-view` (inline IME preview,
// which the OS candidate window anchors to) then floats visibly above the caret.
//
// The fix: pickRowHeight() prefers the fractional getBoundingClientRect().height.
// terminalIme.spec.ts unit-tests that decision in isolation; this test proves
// the END-TO-END pixel alignment under a real fractional DPR, which neither the
// unit test (no layout engine) nor the existing claude-gated IME e2e test (runs
// at DPR=1, ~1-row tolerance, and itself measures with offsetHeight) can.
//
// Portability: whether a fractional pitch actually appears depends on the
// platform's font metrics at 13px (deviceCellPx mod 3 at DPR 1.5). Where it
// can't be reproduced (integer pitch → offsetHeight == rectHeight), the test
// self-skips rather than false-fail — the pickRowHeight unit tests still guard
// the logic there. Locally on the reporter's scaled Windows monitor the drift
// is ~0.33px/row and this test catches a regression by ~7px.
//
// deviceScaleFactor is set at CONTEXT-CREATION time (test.use), not via a
// runtime resize — the app never sees a resize event, so this doesn't trip the
// resize-relayout defect a live setViewportSize would.
test.use({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1.5 });

test('IME 锚定: 分数 DPR + 90% 字号下,组字预览垂直对齐真实光标行(无累积漂移)', async ({ page }, testInfo) => {
  // Pixel-precise + DPR-dependent — only chromium is trustworthy. The unit
  // project runs chromium; guard anyway in case the file is retargeted.
  test.skip(testInfo.project.name !== 'unit' && testInfo.project.name !== 'chromium',
    'DPR pixel-precision test is chromium-only');

  await page.goto('/harness.html?e2e=1');
  await page.waitForFunction(() => '__ccHarness' in window);

  // Must land before addSession: createTerminal() reads loadFontScale() once at
  // construction. 90% → fontSize 13px, whose rendered row pitch is fractional
  // under DPR 1.5 on the reporter's platform (17.33px) while offsetHeight rounds
  // to 17 — the exact divergence the fix targets.
  await page.evaluate(() => localStorage.setItem('cchub-font-scale', '90'));

  const id = await page.evaluate(() =>
    (window as unknown as { __ccHarness: { addSession(o?: unknown): string } })
      .__ccHarness.addSession({ id: 'ime-dpr', label: 'IME DPR' }));

  const r = await page.evaluate(async (sid: string) => {
    const h = (window as unknown as {
      __ccHarness: { writeSync(id: string, data: string): Promise<void> };
    }).__ccHarness;

    const xtermEl = document.querySelector('#terminal-container .xterm') as HTMLElement | null;
    if (!xtermEl) throw new Error('no .xterm mounted');
    const ta = xtermEl.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
    if (!ta) throw new Error('no .xterm-helper-textarea');
    const screen = xtermEl.querySelector('.xterm-screen') as HTMLElement | null;
    if (!screen) throw new Error('no .xterm-screen');
    const rows = xtermEl.querySelector('.xterm-rows') as HTMLElement | null;
    if (!rows) throw new Error('no .xterm-rows');

    // Paint cc's caret as a single reverse-video space a few rows up from the
    // bottom. Depth is adaptive to the actual row count so the row-proportional
    // drift is large (a top-row caret would hide even a broken build), while
    // staying off the very last row to dodge any bottom-edge clipping.
    const rowCount = rows.children.length;
    const targetRow = Math.max(0, rowCount - 3); // 0-based viewport row
    await h.writeSync(sid, '\x1b[2J\x1b[H');
    await h.writeSync(sid, `\x1b[${targetRow + 1};3H\x1b[7m \x1b[27m`);

    // updateCompositionElements schedules a recursive setTimeout(0); give a real
    // macrotask + rAF so the pinned rect has settled before we snapshot.
    const settle = () => new Promise<void>((res) =>
      setTimeout(() => requestAnimationFrame(() => res()), 8));

    // Drive the same composition path the OS IME would: xterm listens on the
    // textarea, and clampImePosition's capture-phase handler pins the preview.
    ta.focus();
    ta.value = '';
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    ta.value = 'ni';
    ta.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 'ni' }));
    ta.dispatchEvent(new InputEvent('input', {
      bubbles: true, data: 'ni', inputType: 'insertCompositionText', isComposing: true,
    }));
    await settle();

    // The row applyAnchor actually resolved to (from the production diagnostic
    // ring buffer) — assert this is our painted caret row, not the PTY-cursor
    // fallback.
    const log = (window as unknown as { __ccImeLog?: Array<{ computed?: { row: number; col: number } }> }).__ccImeLog ?? [];
    const computed = log.length ? log[log.length - 1]!.computed : undefined;

    const cv = xtermEl.querySelector('.composition-view') as HTMLElement | null;
    const caretRow = computed?.row ?? -1;
    const rowEl = caretRow >= 0 ? (rows.children[caretRow] as HTMLElement | undefined) : undefined;

    const cvR = cv?.getBoundingClientRect();
    const rowR = rowEl?.getBoundingClientRect();

    return {
      dpr: window.devicePixelRatio,
      rowCount,
      targetRow,
      caretRow,
      caretCol: computed?.col ?? -1,
      cvVisible: !!cv && cv.offsetWidth > 0 && getComputedStyle(cv).display !== 'none',
      cvTop: cvR?.top ?? null,
      rowTop: rowR?.top ?? null,
      screenTop: screen.getBoundingClientRect().top,
      // Fractional (correct) vs rounded (old, buggy) row pitch.
      rowRectH: rowEl?.getBoundingClientRect().height ?? null,
      rowOffsetH: rowEl?.offsetHeight ?? null,
    };
  }, id);

  // The composition preview actually rendered, and the anchor locked onto our
  // painted caret row — not the PTY-cursor fallback.
  expect(r.cvVisible).toBe(true);
  expect(r.caretRow).toBe(r.targetRow);
  expect(r.cvTop).not.toBeNull();
  expect(r.rowTop).not.toBeNull();
  expect(r.rowRectH).not.toBeNull();
  expect(r.rowOffsetH).not.toBeNull();

  // How far the OLD offsetHeight math would have mis-pinned the preview at this
  // row. Only environments that render a fractional pitch can exercise the bug;
  // where the pitch is an integer (offsetHeight == rectHeight, e.g. a CI font
  // whose device cell height is a multiple of 3 at DPR 1.5) there's nothing to
  // catch here, so self-skip instead of asserting on a no-op. The pickRowHeight
  // unit tests still guard the decision logic on those platforms.
  const wouldDriftPx = Math.abs(r.caretRow * (r.rowRectH! - r.rowOffsetH!));
  test.skip(wouldDriftPx < 3,
    `platform renders an integer row pitch under DPR 1.5 (rectH=${r.rowRectH}, ` +
    `offsetH=${r.rowOffsetH}); no accumulated drift to exercise — covered by ` +
    `pickRowHeight unit tests`);

  // CORE: the pinned inline preview sits on the real caret row. With the fix
  // this holds at any row depth; a regression to offsetHeight would drift it
  // upward by caretRow × (pitch − offsetHeight).
  expect(Math.abs(r.cvTop! - r.rowTop!)).toBeLessThan(2);

  // REGRESSION WITNESS: prove this test would have FAILED against the old
  // offsetHeight math. The old code pinned cv at screenTop + caretRow ×
  // offsetHeight; show that point is >2px from where the caret row actually is,
  // i.e. the bug this guards is real and this test catches it.
  const oldPinTop = r.screenTop + r.caretRow * r.rowOffsetH!;
  expect(Math.abs(oldPinTop - r.rowTop!)).toBeGreaterThan(2);
});
