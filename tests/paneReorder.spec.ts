import { test, expect } from '@playwright/test';
import { computeDropIndex, type PaneRect, type PaneRectEntry } from '../src/client/views/paneReorder.js';

// Rect helpers. Widths are 100px for readable arithmetic; centers land at
// (left + right) / 2 = left + 50.
function rect(left: number, top: number, width = 100, height = 80): PaneRect {
  return { left, top, right: left + width, bottom: top + height };
}
function row(...lefts: number[]): PaneRectEntry[] {
  return lefts.map((l, i) => ({ id: String.fromCharCode(65 + i), rect: rect(l, 0) }));
}

test.describe('computeDropIndex', () => {
  test('single pane → always returns fromIndex', () => {
    const panes = row(0);
    expect(computeDropIndex(panes, 0, 50, 40)).toBe(0);
    expect(computeDropIndex(panes, 0, 9999, 40)).toBe(0);
  });

  test('mouse on source pane center → no-op (returns fromIndex)', () => {
    // Two panes A@0 B@100, from=A.
    const panes = row(0, 100);
    expect(computeDropIndex(panes, 0, 50, 40)).toBe(0);
  });

  test('two panes, drag A onto B left half → still 0 (no move)', () => {
    // B center = 150. Mouse at 120 (left half) → insertBefore B → 1, minus 1 → 0.
    const panes = row(0, 100);
    expect(computeDropIndex(panes, 0, 120, 40)).toBe(0);
  });

  test('two panes, drag A onto B right half → 1 (order becomes B A)', () => {
    // Mouse at 180 (right half of B) → insertAfter B → 2, minus 1 → 1.
    const panes = row(0, 100);
    expect(computeDropIndex(panes, 0, 180, 40)).toBe(1);
  });

  test('two panes, drag B onto A left half → 0 (order becomes B A)', () => {
    // Mouse at 20 (left half of A) → insertBefore A → 0. From=1, 0 < 1 → no
    // normalization → 0.
    const panes = row(0, 100);
    expect(computeDropIndex(panes, 1, 20, 40)).toBe(0);
  });

  test('two panes, drag B onto A right half → 1 (self, no move)', () => {
    // Mouse at 80 (right half of A) → insertAfter A → 1. from=1 not > 1 →
    // no normalization → 1 (self).
    const panes = row(0, 100);
    expect(computeDropIndex(panes, 1, 80, 40)).toBe(1);
  });

  test('three panes, drag middle to far right → 2 (last)', () => {
    // A@0 B@100 C@200. from=B(1). Mouse at 280 (right half of C, center=250)
    // → insertAfter C → 3, minus 1 (3>1) → 2.
    const panes = row(0, 100, 200);
    expect(computeDropIndex(panes, 1, 280, 40)).toBe(2);
  });

  test('three panes, drag middle to far left → 0 (first)', () => {
    // from=B(1). Mouse at 20 (left half of A, center=50) → insertBefore A
    // → 0. 0 not > 1 → 0.
    const panes = row(0, 100, 200);
    expect(computeDropIndex(panes, 1, 20, 40)).toBe(0);
  });

  test('mouse beyond right edge → nearest pane is last; drops at end', () => {
    // from=A(0). Mouse at 500 (way outside), nearest is C (center=250, closer
    // than A@50, B@150). Mouse > C center → insertAfter C → 3, minus 1 → 2.
    const panes = row(0, 100, 200);
    expect(computeDropIndex(panes, 0, 500, 40)).toBe(2);
  });

  test('mouse beyond left edge → nearest pane is first; drops at start', () => {
    // from=C(2). Mouse at -500 (outside left), nearest A. Mouse < A center →
    // insertBefore A → 0. 0 not > 2 → 0.
    const panes = row(0, 100, 200);
    expect(computeDropIndex(panes, 2, -500, 40)).toBe(0);
  });

  test('cols-3 multirow: drop into second-row pane picks the second-row pane, not the one directly above', () => {
    // A@(0,0)  B@(100,0)  C@(200,0)
    // D@(0,80) E@(100,80) F@(200,80)
    // from=A(0). Mouse at (150, 120): inside E's rect (100..200 x 80..160).
    // Even though pane B directly above has the same X, Y matches E.
    // insertBefore E? Mouse X=150 = E center → insertAfter E → target 4+1=5,
    // minus 1 (5>0) → 4.
    const panes: PaneRectEntry[] = [
      { id: 'A', rect: rect(0, 0) },
      { id: 'B', rect: rect(100, 0) },
      { id: 'C', rect: rect(200, 0) },
      { id: 'D', rect: rect(0, 80) },
      { id: 'E', rect: rect(100, 80) },
      { id: 'F', rect: rect(200, 80) },
    ];
    // Mouse X=140 (< E center 150 → insertBefore) → target=4 → 4 > 0 → 4-1=3.
    expect(computeDropIndex(panes, 0, 140, 120)).toBe(3);
    // Mouse X=160 (> E center → insertAfter) → target=5 → 5>0 → 5-1=4.
    expect(computeDropIndex(panes, 0, 160, 120)).toBe(4);
  });

  test('cols-3 multirow: hover exactly on the last pane in second row → tail placement', () => {
    // from=A(0). Mouse over F (200..300 x 80..160). Right half → insertAfter F
    // → 6 → 6>0 → 5. Left half → insertBefore F → 5 → 5-1=4.
    const panes: PaneRectEntry[] = [
      { id: 'A', rect: rect(0, 0) },
      { id: 'B', rect: rect(100, 0) },
      { id: 'C', rect: rect(200, 0) },
      { id: 'D', rect: rect(0, 80) },
      { id: 'E', rect: rect(100, 80) },
      { id: 'F', rect: rect(200, 80) },
    ];
    expect(computeDropIndex(panes, 0, 280, 120)).toBe(5);
    expect(computeDropIndex(panes, 0, 220, 120)).toBe(4);
  });

  test('empty pane list → returns fromIndex unchanged', () => {
    expect(computeDropIndex([], 0, 50, 40)).toBe(0);
  });

  test('axis=y vertical stack, drag A onto B top half → still 0 (no move)', () => {
    // Three tabs stacked vertically at y=0/60/120, width=200, height=40.
    // A center y = 20, B center y = 80. from=A(0). Mouse at (100, 65) is inside
    // B (y=60..100) and 65 < 80 → insertBefore B → 1, minus 1 → 0.
    const stack: PaneRectEntry[] = [
      { id: 'A', rect: { left: 0, right: 200, top: 0, bottom: 40 } },
      { id: 'B', rect: { left: 0, right: 200, top: 60, bottom: 100 } },
      { id: 'C', rect: { left: 0, right: 200, top: 120, bottom: 160 } },
    ];
    expect(computeDropIndex(stack, 0, 100, 65, 'y')).toBe(0);
  });

  test('axis=y drag A onto B bottom half → 1 (order becomes B A C)', () => {
    const stack: PaneRectEntry[] = [
      { id: 'A', rect: { left: 0, right: 200, top: 0, bottom: 40 } },
      { id: 'B', rect: { left: 0, right: 200, top: 60, bottom: 100 } },
      { id: 'C', rect: { left: 0, right: 200, top: 120, bottom: 160 } },
    ];
    // Mouse at (100, 95): inside B (60..100), 95 > 80 → insertAfter B → 2,
    // minus 1 → 1.
    expect(computeDropIndex(stack, 0, 100, 95, 'y')).toBe(1);
  });

  test('axis=y drag last tab to first tab top half → 0 (move to front)', () => {
    const stack: PaneRectEntry[] = [
      { id: 'A', rect: { left: 0, right: 200, top: 0, bottom: 40 } },
      { id: 'B', rect: { left: 0, right: 200, top: 60, bottom: 100 } },
      { id: 'C', rect: { left: 0, right: 200, top: 120, bottom: 160 } },
    ];
    // from=C(2). Mouse at (100, 5): inside A (0..40), 5 < 20 → insertBefore A
    // → 0. 0 not > 2 → 0.
    expect(computeDropIndex(stack, 2, 100, 5, 'y')).toBe(0);
  });

  test('axis=y horizontal cursor coord is ignored for before/after decision', () => {
    const stack: PaneRectEntry[] = [
      { id: 'A', rect: { left: 0, right: 200, top: 0, bottom: 40 } },
      { id: 'B', rect: { left: 0, right: 200, top: 60, bottom: 100 } },
    ];
    // from=A(0). Wildly different X, but Y is what counts. y=95 → after B → 1.
    expect(computeDropIndex(stack, 0, 9999, 95, 'y')).toBe(1);
    // y=65 → before B → 0.
    expect(computeDropIndex(stack, 0, -9999, 65, 'y')).toBe(0);
  });

  test('axis=y mouse above the whole stack → nearest is top, drops at 0', () => {
    const stack: PaneRectEntry[] = [
      { id: 'A', rect: { left: 0, right: 200, top: 0, bottom: 40 } },
      { id: 'B', rect: { left: 0, right: 200, top: 60, bottom: 100 } },
      { id: 'C', rect: { left: 0, right: 200, top: 120, bottom: 160 } },
    ];
    expect(computeDropIndex(stack, 2, 100, -500, 'y')).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// Harness-driven end-to-end: real DOM + real attach controller + real listeners
// via /harness.html?e2e=1. Uses page.mouse for pointer events (Chromium emits
// pointer events alongside mouse events by default).
// -----------------------------------------------------------------------------

const SETTLE_MS = 60;

async function boot(page: import('@playwright/test').Page, layout: string, sessions: number): Promise<string[]> {
  await page.goto('/harness.html?e2e=1');
  await page.waitForFunction(() => '__ccHarness' in window);
  return page.evaluate(
    ({ layout, sessions }) => {
      const h = (window as any).__ccHarness;
      h.setLayout(layout);
      const ids: string[] = [];
      for (let i = 0; i < sessions; i++) ids.push(h.addSession());
      h.setLayout(layout);
      return ids;
    },
    { layout, sessions },
  );
}

async function paneOrder(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => {
    const nodes = document.querySelectorAll<HTMLElement>('#terminal-container > .term-pane');
    return Array.from(nodes).map(n => n.dataset.sessionId ?? '');
  });
}

async function storeOrder(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => (window as any).__ccHarness.ids());
}

async function dragBetween(
  page: import('@playwright/test').Page,
  fromId: string,
  toId: string,
  side: 'left' | 'right' | 'center',
): Promise<void> {
  const src = await page.locator(`.term-pane[data-session-id="${fromId}"] .pane-head`).boundingBox();
  const dst = await page.locator(`.term-pane[data-session-id="${toId}"]`).boundingBox();
  if (!src || !dst) throw new Error(`boundingBox missing for ${fromId} / ${toId}`);
  const startX = src.x + src.width / 2;
  const startY = src.y + src.height / 2;
  const fracX = side === 'left' ? 0.25 : side === 'right' ? 0.75 : 0.5;
  const endX = dst.x + dst.width * fracX;
  const endY = dst.y + dst.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Multi-step move so pointermove crosses the 4px threshold and updates the
  // drop indicator.
  await page.mouse.move((startX + endX) / 2, (startY + endY) / 2, { steps: 5 });
  await page.mouse.move(endX, endY, { steps: 5 });
  await page.mouse.up();
}

test.describe('pane drag-to-reorder (DOM)', () => {
  test('drag first pane to right half of second → swaps [B, A, C]', async ({ page }) => {
    const ids = await boot(page, 'cols-2', 3);
    expect(await paneOrder(page)).toEqual(ids);
    await dragBetween(page, ids[0]!, ids[1]!, 'right');
    await page.waitForTimeout(SETTLE_MS);
    expect(await paneOrder(page)).toEqual([ids[1], ids[0], ids[2]]);
    expect(await storeOrder(page)).toEqual([ids[1], ids[0], ids[2]]);
  });

  test('drag last pane to left of first → [C, A, B]', async ({ page }) => {
    const ids = await boot(page, 'cols-2', 3);
    await dragBetween(page, ids[2]!, ids[0]!, 'left');
    await page.waitForTimeout(SETTLE_MS);
    expect(await paneOrder(page)).toEqual([ids[2], ids[0], ids[1]]);
    expect(await storeOrder(page)).toEqual([ids[2], ids[0], ids[1]]);
  });

  test('drag onto self center → no change', async ({ page }) => {
    const ids = await boot(page, 'cols-2', 3);
    await dragBetween(page, ids[0]!, ids[0]!, 'center');
    await page.waitForTimeout(SETTLE_MS);
    expect(await paneOrder(page)).toEqual(ids);
  });

  test('cols-3: drag pane 0 to right of pane 2 → [B, C, A]', async ({ page }) => {
    const ids = await boot(page, 'cols-3', 3);
    await dragBetween(page, ids[0]!, ids[2]!, 'right');
    await page.waitForTimeout(SETTLE_MS);
    expect(await paneOrder(page)).toEqual([ids[1], ids[2], ids[0]]);
  });

  test('tabs mode → drag handler is a no-op (getMode early return)', async ({ page }) => {
    const ids = await boot(page, 'tabs', 3);
    // .pane-head is display:none in tabs mode, so a real mouse click wouldn't
    // even land on it. We synthesize the pointerdown directly so we can prove
    // the handler's mode check fires. If reorder somehow ran anyway, the store
    // order would change.
    await page.evaluate((id) => {
      const head = document.querySelector<HTMLElement>(`[data-session-id="${id}"] .pane-head`);
      if (!head) return;
      const r = head.getBoundingClientRect();
      const opts = { bubbles: true, pointerId: 1, button: 0, clientX: r.left + 5, clientY: r.top + 5 };
      head.dispatchEvent(new PointerEvent('pointerdown', opts));
      head.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: r.left + 300, clientY: r.top + 5 }));
      head.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: r.left + 300, clientY: r.top + 5 }));
    }, ids[0]);
    await page.waitForTimeout(SETTLE_MS);
    expect(await storeOrder(page)).toEqual(ids);
  });

  test('Escape during drag → cancels without commit', async ({ page }) => {
    const ids = await boot(page, 'cols-2', 3);
    const src = await page.locator(`.term-pane[data-session-id="${ids[0]}"] .pane-head`).boundingBox();
    const dst = await page.locator(`.term-pane[data-session-id="${ids[1]}"]`).boundingBox();
    if (!src || !dst) throw new Error('boundingBox missing');
    await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
    await page.mouse.down();
    await page.mouse.move(dst.x + dst.width * 0.75, dst.y + dst.height / 2, { steps: 10 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForTimeout(SETTLE_MS);
    // Order should be unchanged despite the drag reaching the drop-commit zone.
    expect(await storeOrder(page)).toEqual(ids);
  });

  test('drop indicator classes are cleared after commit', async ({ page }) => {
    const ids = await boot(page, 'cols-2', 3);
    await dragBetween(page, ids[0]!, ids[1]!, 'right');
    await page.waitForTimeout(SETTLE_MS);
    const stuck = await page.evaluate(() => {
      return document.querySelectorAll('.term-pane.drop-before, .term-pane.drop-after, .term-pane.is-dragging').length;
    });
    expect(stuck).toBe(0);
    expect(await page.evaluate(() => document.body.classList.contains('dragging-pane'))).toBe(false);
  });

  test('sends session.reorder over WS so the server persists the order across a refresh', async ({ page }) => {
    const ids = await boot(page, 'cols-2', 3);
    await page.evaluate(() => (window as any).__ccHarness.clearSent());
    await dragBetween(page, ids[0]!, ids[1]!, 'right');
    await page.waitForTimeout(SETTLE_MS);
    // Bug: without this WS notify, the drag stays client-only. A page refresh
    // re-requests session.list from the server, which still returns the
    // original insertion order, and the reorder is lost.
    const sent = await page.evaluate(() => (window as any).__ccHarness.sent());
    const reorderMsgs = sent.filter((m: any) => m && m.type === 'session.reorder');
    expect(reorderMsgs).toEqual([{ type: 'session.reorder', id: ids[0], toIndex: 1 }]);
  });

  test('drag preserves pane count and terminal instances (nothing recreated)', async ({ page }) => {
    const ids = await boot(page, 'cols-2', 3);
    const before = await page.evaluate(() => Object.keys((window as any).__cc_terminals ?? {}).sort());
    await dragBetween(page, ids[0]!, ids[1]!, 'right');
    await page.waitForTimeout(SETTLE_MS);
    const after = await page.evaluate(() => Object.keys((window as any).__cc_terminals ?? {}).sort());
    expect(after).toEqual(before);
    expect(await page.evaluate(() => document.querySelectorAll('#terminal-container > .term-pane').length)).toBe(3);
  });
});

// -----------------------------------------------------------------------------
// Rail tab drag-to-reorder: same Store.reorderSession backend, vertical axis.
// -----------------------------------------------------------------------------

async function tabOrder(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => {
    const nodes = document.querySelectorAll<HTMLElement>('#tabs > .tab');
    return Array.from(nodes).map(n => n.dataset.sessionId ?? '');
  });
}

async function dragTabToTab(
  page: import('@playwright/test').Page,
  fromId: string,
  toId: string,
  half: 'top' | 'bottom',
): Promise<void> {
  const src = await page.locator(`.tab[data-session-id="${fromId}"]`).boundingBox();
  const dst = await page.locator(`.tab[data-session-id="${toId}"]`).boundingBox();
  if (!src || !dst) throw new Error(`boundingBox missing for tab ${fromId} / ${toId}`);
  const startX = src.x + src.width / 2;
  const startY = src.y + src.height / 2;
  const endX = dst.x + dst.width / 2;
  const endY = dst.y + dst.height * (half === 'top' ? 0.25 : 0.75);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move((startX + endX) / 2, (startY + endY) / 2, { steps: 5 });
  await page.mouse.move(endX, endY, { steps: 5 });
  await page.mouse.up();
}

test.describe('rail tab drag-to-reorder', () => {
  test('tabs mode: drag tab 0 to bottom half of tab 1 → [B, A, C], panes stay in sync', async ({ page }) => {
    const ids = await boot(page, 'tabs', 3);
    expect(await tabOrder(page)).toEqual(ids);
    await dragTabToTab(page, ids[0]!, ids[1]!, 'bottom');
    await page.waitForTimeout(SETTLE_MS);
    expect(await tabOrder(page)).toEqual([ids[1], ids[0], ids[2]]);
    expect(await storeOrder(page)).toEqual([ids[1], ids[0], ids[2]]);
    // Panes reordered too (even though only one is visible in tabs mode).
    expect(await paneOrder(page)).toEqual([ids[1], ids[0], ids[2]]);
  });

  test('tabs mode: drag last tab to top of first → moves to front', async ({ page }) => {
    const ids = await boot(page, 'tabs', 3);
    await dragTabToTab(page, ids[2]!, ids[0]!, 'top');
    await page.waitForTimeout(SETTLE_MS);
    expect(await tabOrder(page)).toEqual([ids[2], ids[0], ids[1]]);
  });

  test('rail is hidden in cols-N modes → tab drag naturally unreachable', async ({ page }) => {
    // Sanity: pane drag is the only reorder affordance in grid modes; rail is
    // display:none (see html[data-layout^="cols-"] .session-rail rule).
    await boot(page, 'cols-2', 3);
    const rect = await page.evaluate(() => {
      const rail = document.querySelector<HTMLElement>('.session-rail');
      const r = rail?.getBoundingClientRect();
      return { hidden: !!rail && (r!.width === 0 || r!.height === 0), display: rail ? getComputedStyle(rail).display : null };
    });
    expect(rect.hidden).toBe(true);
    expect(rect.display).toBe('none');
  });

  test('close button click on tab does not start a drag', async ({ page }) => {
    // Sanity: pointerdown on .tab-close inside a tab must NOT trigger drag
    // (ignoreSelector should filter it out). Also: no reorder happens.
    const ids = await boot(page, 'tabs', 3);
    const bbox = await page.locator(`.tab[data-session-id="${ids[0]}"] .tab-close`).boundingBox();
    if (!bbox) throw new Error('close btn boundingBox missing');
    await page.mouse.move(bbox.x + bbox.width / 2, bbox.y + bbox.height / 2);
    await page.mouse.down();
    // Move far enough to would-have-triggered a drag.
    await page.mouse.move(bbox.x + bbox.width / 2, bbox.y + bbox.height / 2 + 200, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(SETTLE_MS);
    expect(await storeOrder(page)).toEqual(ids);
    expect(await page.evaluate(() => document.body.classList.contains('dragging-tab'))).toBe(false);
  });

  test('click on a tab (no drag) still activates it', async ({ page }) => {
    const ids = await boot(page, 'tabs', 3);
    // Right after boot, ids[2] is the active session (harness auto-activates
    // the last-added). A plain click on tab 0 must move active to it.
    await page.locator(`.tab[data-session-id="${ids[0]}"]`).click();
    await page.waitForTimeout(SETTLE_MS);
    const active = await page.evaluate(() =>
      document.querySelector('#tabs > .tab.active')?.getAttribute('data-session-id'),
    );
    expect(active).toBe(ids[0]);
    expect(await storeOrder(page)).toEqual(ids);
  });

  test('drag does NOT activate the source tab (click after pointerup is swallowed)', async ({ page }) => {
    const ids = await boot(page, 'tabs', 3);
    // Boot leaves ids[2] active. Dragging ids[0] should reorder but leave the
    // active session untouched — the pointerup's synthesized click must be
    // suppressed by the drag handler.
    await dragTabToTab(page, ids[0]!, ids[1]!, 'bottom');
    await page.waitForTimeout(SETTLE_MS);
    const active = await page.evaluate(() =>
      document.querySelector('#tabs > .tab.active')?.getAttribute('data-session-id'),
    );
    expect(active).toBe(ids[2]);
    expect(await storeOrder(page)).toEqual([ids[1], ids[0], ids[2]]);
  });

  test('sends session.reorder over WS so the server persists the order across a refresh', async ({ page }) => {
    const ids = await boot(page, 'tabs', 3);
    await page.evaluate(() => (window as any).__ccHarness.clearSent());
    await dragTabToTab(page, ids[0]!, ids[1]!, 'bottom');
    await page.waitForTimeout(SETTLE_MS);
    // Without the WS notify, the server never learns the new order, so a
    // page refresh (which re-requests session.list) would come back with the
    // original insertion order — the reported bug.
    const sent = await page.evaluate(() => (window as any).__ccHarness.sent());
    const reorderMsgs = sent.filter((m: any) => m && m.type === 'session.reorder');
    expect(reorderMsgs).toEqual([{ type: 'session.reorder', id: ids[0], toIndex: 1 }]);
  });

  test('renderTabs is incremental: tab elements survive a re-render', async ({ page }) => {
    const ids = await boot(page, 'tabs', 3);
    // Mark tabs so we can detect element replacement.
    await page.evaluate(() => {
      document.querySelectorAll<HTMLElement>('#tabs > .tab').forEach((t, i) => (t.dataset.mark = String(i)));
    });
    // Trigger a re-render by activating a different session (fires notify).
    // ids[2] is currently active (harness.addSession auto-activates), so pick
    // ids[0] to force a real state transition.
    await page.evaluate((id) => window.__ccHarness.activate(id), ids[0]);
    await page.waitForTimeout(SETTLE_MS);
    const marks = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('#tabs > .tab')).map(t => t.dataset.mark ?? ''),
    );
    // Same three marks, in same insertion order — proves elements were reused,
    // not rebuilt.
    expect(marks).toEqual(['0', '1', '2']);
  });

  test('click on rail .reveal-cwd opens the reveal menu; picking Files fires shell.reveal', async ({ page }) => {
    // Regression: pointerdown on `.reveal-cwd` inside a `.tab-meta` used to
    // start drag tracking on `.tab` (its handleSelector) — setPointerCapture
    // then rerouted the follow-up click to the tab, so the link's own click
    // handler never fired. `ignoreSelector: '.tab-close, .reveal-cwd'` gates
    // that out. Local sessions now pop a 6-item reveal menu (files / vscode /
    // 4 shells) instead of firing 'files' inline, so we click the menu item
    // to complete the round-trip and prove the drag capture didn't swallow
    // the initial click.
    const ids = await boot(page, 'tabs', 1);
    await page.evaluate(() => (window as any).__ccHarness.clearSent());
    await page.locator(`.tab[data-session-id="${ids[0]}"] .reveal-cwd`).click();
    // Menu is a body-appended fixed-position popover; wait for it to render.
    await page.locator('.reveal-menu .reveal-menu-item').first().click();
    await page.waitForTimeout(SETTLE_MS);
    const sent = await page.evaluate(() => (window as any).__ccHarness.sent());
    const reveals = sent.filter((m: any) => m && m.type === 'shell.reveal');
    expect(reveals).toEqual([{ type: 'shell.reveal', id: ids[0], app: 'files' }]);
    // And the tab still exists (i.e. the click didn't accidentally reorder).
    expect(await storeOrder(page)).toEqual(ids);
  });

  test('click on pane-head .reveal-cwd opens the reveal menu; picking Files fires shell.reveal (grid mode)', async ({ page }) => {
    // Same regression as above, but for the pane-head path: drag reorder on
    // `.pane-head` was capturing pointer on the head, killing the link click.
    // `ignoreSelector: '.pane-close, .reveal-cwd'` fixes it.
    //
    // The pane-head is rebuilt on every store notify (renderSessionLabel
    // clears + rebuilds the .pane-name subtree), so playwright's stability
    // wait times out. Do a raw programmatic `element.click()` which skips the
    // stability check and still exercises the click handler + drag guard.
    // Local sessions pop the reveal menu; picking the first item ('files')
    // completes the round-trip.
    const ids = await boot(page, 'cols-2', 2);
    await page.evaluate(() => (window as any).__ccHarness.clearSent());
    await page.locator(`.term-pane[data-session-id="${ids[0]}"] .pane-head .reveal-cwd`)
      .evaluate((el: HTMLElement) => el.click());
    await page.locator('.reveal-menu .reveal-menu-item').first().click();
    await page.waitForTimeout(SETTLE_MS);
    const sent = await page.evaluate(() => (window as any).__ccHarness.sent());
    const reveals = sent.filter((m: any) => m && m.type === 'shell.reveal');
    expect(reveals).toEqual([{ type: 'shell.reveal', id: ids[0], app: 'files' }]);
    expect(await paneOrder(page)).toEqual(ids);
  });
});
