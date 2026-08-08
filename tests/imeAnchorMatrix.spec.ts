import { test, expect } from '@playwright/test';
import { requireSignal } from './support/strictSkip.js';

/**
 * IME anchor alignment, searched across configurations instead of pinned to one.
 *
 * `imeAnchorDpr.spec.ts` asserts the same invariant and stays as-is. What this
 * file changes is the response to "this machine doesn't reproduce it": that spec
 * hardcodes DPR 1.5 + 90% font scale, and when the resulting row pitch comes out
 * integral it calls `test.skip`. Which is exactly what happened — the IME box
 * drifted on a machine where the whole test had silently deleted itself, so the
 * summary line read as success.
 *
 * The pitch being fractional is a property of (dpr, fontSize, platform font
 * metrics), and no single triple is fractional everywhere. So rather than fixing
 * one triple and opting out where it doesn't bite, this sweeps a matrix and
 * asserts the invariant on **every** cell that produces a fractional pitch. A
 * machine that renders one cell integrally almost certainly renders another
 * fractionally; only if the entire matrix comes out integral is there genuinely
 * nothing to test here, and then `requireSignal` reports it as a no-signal skip
 * that `CCHUB_TEST_STRICT=1` escalates to a failure.
 *
 * The invariant: the pinned `.composition-view` — the element the OS candidate
 * window anchors to — must sit on the caret's actual row, within 2px. Anchoring
 * from a rounded `offsetHeight` accumulates (pitch − round(pitch)) per row,
 * which is invisible at the top of the screen and several pixels off at the
 * bottom input row where the caret actually lives.
 */

/** Font scales to sweep. These are real UI choices (`FONT_SCALES` in
 * fontScale.ts), so a fractional pitch found here is one a user can hit. */
const FONT_SCALES = [75, 90, 100, 110, 125, 150];

/** Where to put the caret, as rows up from the bottom. Drift is proportional to
 * the row index, so a caret near the bottom is where it is visible — and where
 * cc's input line actually is. */
const CARET_DEPTHS_FROM_BOTTOM = [3, 6];

interface Probe {
  fontScale: number;
  dpr: number;
  rowCount: number;
  targetRow: number;
  caretRow: number;
  cvVisible: boolean;
  cvTop: number | null;
  rowTop: number | null;
  screenTop: number;
  rowRectH: number | null;
  rowOffsetH: number | null;
}

/** Mount a harness terminal at `fontScale`, paint a caret `depth` rows off the
 * bottom, drive a real composition, and measure where the preview landed
 * relative to the caret's row. */
async function probe(page: import('@playwright/test').Page, fontScale: number, depth: number): Promise<Probe> {
  await page.goto('/harness.html?e2e=1');
  await page.waitForFunction(() => '__ccHarness' in window);

  // createTerminal() reads loadFontScale() once at construction, so the scale
  // has to be in place before addSession.
  await page.evaluate((scale) => localStorage.setItem('cchub-font-scale', String(scale)), fontScale);

  const id = await page.evaluate(() =>
    (window as unknown as { __ccHarness: { addSession(o?: unknown): string } })
      .__ccHarness.addSession({ id: 'ime-matrix', label: 'IME matrix' }));

  return page.evaluate(async ([sid, dep, scale]) => {
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

    const rowCount = rows.children.length;
    const targetRow = Math.max(0, rowCount - (dep as number));
    // Paint cc's caret as a reverse-video space, which is what the anchor
    // detector looks for.
    await h.writeSync(sid as string, '\x1b[2J\x1b[H');
    await h.writeSync(sid as string, `\x1b[${targetRow + 1};3H\x1b[7m \x1b[27m`);

    const settle = () => new Promise<void>((res) =>
      setTimeout(() => requestAnimationFrame(() => res()), 8));

    // Drive the same path the OS IME drives: xterm listens on the textarea and
    // clampImePosition's capture-phase handler pins the preview.
    ta.focus();
    ta.value = '';
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    ta.value = 'ni';
    ta.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 'ni' }));
    ta.dispatchEvent(new InputEvent('input', {
      bubbles: true, data: 'ni', inputType: 'insertCompositionText', isComposing: true,
    }));
    await settle();

    const log = (window as unknown as { __ccImeLog?: Array<{ computed?: { row: number; col: number } }> }).__ccImeLog ?? [];
    const computed = log.length ? log[log.length - 1]!.computed : undefined;
    const cv = xtermEl.querySelector('.composition-view') as HTMLElement | null;
    const caretRow = computed?.row ?? -1;
    const rowEl = caretRow >= 0 ? (rows.children[caretRow] as HTMLElement | undefined) : undefined;

    return {
      fontScale: scale as number,
      dpr: window.devicePixelRatio,
      rowCount,
      targetRow,
      caretRow,
      cvVisible: !!cv && cv.offsetWidth > 0 && getComputedStyle(cv).display !== 'none',
      cvTop: cv?.getBoundingClientRect().top ?? null,
      rowTop: rowEl?.getBoundingClientRect().top ?? null,
      screenTop: screen.getBoundingClientRect().top,
      rowRectH: rowEl?.getBoundingClientRect().height ?? null,
      rowOffsetH: rowEl?.offsetHeight ?? null,
    };
  }, [id, depth, fontScale] as const);
}

/** Pixels the OLD (rounded-`offsetHeight`) anchor math would have been off by at
 * this caret row. Zero when the pitch is integral, i.e. this cell of the matrix
 * cannot exercise the bug. */
function wouldDrift(p: Probe): number {
  if (p.rowRectH === null || p.rowOffsetH === null) return 0;
  return Math.abs(p.caretRow * (p.rowRectH - p.rowOffsetH));
}

/** Assert the invariant on one probe. */
function expectAnchored(p: Probe): void {
  expect(p.cvVisible, 'composition preview must render').toBe(true);
  expect(p.caretRow, 'anchor must lock onto the painted caret row, not the PTY-cursor fallback').toBe(p.targetRow);
  expect(p.cvTop).not.toBeNull();
  expect(p.rowTop).not.toBeNull();
  // The invariant itself: the preview sits on the caret's row.
  expect(Math.abs(p.cvTop! - p.rowTop!),
    `preview must sit on the caret row (scale=${p.fontScale} dpr=${p.dpr} row=${p.caretRow})`).toBeLessThan(2);
}

// deviceScaleFactor is fixed when the browser context is created, so each DPR
// needs its own describe block — it cannot be swept inside one test, and a
// runtime resize would trip the resize-relayout defect (#125).
for (const dpr of [1.25, 1.5, 2]) {
  test.describe(`IME anchor @ DPR ${dpr}`, () => {
    test.use({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: dpr });

    test(`组字预览对齐光标行: 扫描字号 × 光标行深度,凡分数行距必断言`, async ({ page }, testInfo) => {
      // Pixel-precise and DPR-dependent: only chromium's layout is trustworthy
      // here. This is a real platform constraint, so it stays a skip even under
      // strict mode.
      test.skip(testInfo.project.name !== 'unit' && testInfo.project.name !== 'chromium',
        '[platform] DPR pixel-precision test is chromium-only');

      const probes: Probe[] = [];
      for (const scale of FONT_SCALES) {
        for (const depth of CARET_DEPTHS_FROM_BOTTOM) {
          probes.push(await probe(page, scale, depth));
        }
      }

      // Cells that actually render a fractional row pitch — the ones where a
      // regression to offsetHeight would visibly mis-pin the preview.
      const exercising = probes.filter((p) => wouldDrift(p) >= 3);

      const summary = probes
        .map((p) => `scale=${p.fontScale} depth=${p.rowCount - p.targetRow} pitch=${p.rowRectH}/${p.rowOffsetH} drift=${wouldDrift(p).toFixed(2)}`)
        .join('\n  ');
      console.log(`[ime matrix @ DPR ${dpr}] ${exercising.length}/${probes.length} cells exercise the bug:\n  ${summary}`);

      // Only if the WHOLE matrix comes out integral is there nothing to test.
      // That is a real possibility on some font stacks, but it is now reported
      // rather than invisible — and CCHUB_TEST_STRICT=1 turns it into a failure,
      // because "no cell reproduced it" and "the invariant broke" must not look
      // the same in a report.
      requireSignal(exercising.length > 0,
        `a fractional row pitch at DPR ${dpr} across scales ${FONT_SCALES.join('/')} ` +
        `(all cells rendered an integer pitch, so offsetHeight and the true pitch agree)`);

      for (const p of exercising) expectAnchored(p);

      // Regression witness: prove these cells would have FAILED under the old
      // math. Without this the assertions above could be passing simply because
      // nothing was capable of drifting.
      for (const p of exercising) {
        const oldPinTop = p.screenTop + p.caretRow * p.rowOffsetH!;
        expect(Math.abs(oldPinTop - p.rowTop!),
          `scale=${p.fontScale} row=${p.caretRow} must be a cell where the old ` +
          `offsetHeight anchor visibly drifted`).toBeGreaterThan(2);
      }
    });
  });
}
