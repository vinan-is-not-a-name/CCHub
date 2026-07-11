import { test, expect } from '@playwright/test';

// -----------------------------------------------------------------------------
// Harness-driven: real DOM + real attach controller + real listeners
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
    expect(await paneOrder(page)).toEqual([ids[1], ids[0], ids[2]]);
  });

  test('tabs mode: drag last tab to top of first → moves to front', async ({ page }) => {
    const ids = await boot(page, 'tabs', 3);
    await dragTabToTab(page, ids[2]!, ids[0]!, 'top');
    await page.waitForTimeout(SETTLE_MS);
    expect(await tabOrder(page)).toEqual([ids[2], ids[0], ids[1]]);
  });

  test('rail is hidden in cols-N modes → tab drag naturally unreachable', async ({ page }) => {
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
    const ids = await boot(page, 'tabs', 3);
    const bbox = await page.locator(`.tab[data-session-id="${ids[0]}"] .tab-close`).boundingBox();
    if (!bbox) throw new Error('close btn boundingBox missing');
    await page.mouse.move(bbox.x + bbox.width / 2, bbox.y + bbox.height / 2);
    await page.mouse.down();
    await page.mouse.move(bbox.x + bbox.width / 2, bbox.y + bbox.height / 2 + 200, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(SETTLE_MS);
    expect(await storeOrder(page)).toEqual(ids);
    expect(await page.evaluate(() => document.body.classList.contains('dragging-tab'))).toBe(false);
  });

  test('click on a tab (no drag) still activates it', async ({ page }) => {
    const ids = await boot(page, 'tabs', 3);
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
    const sent = await page.evaluate(() => (window as any).__ccHarness.sent());
    const reorderMsgs = sent.filter((m: any) => m && m.type === 'session.reorder');
    expect(reorderMsgs).toEqual([{ type: 'session.reorder', id: ids[0], toIndex: 1 }]);
  });

  test('renderTabs is incremental: tab elements survive a re-render', async ({ page }) => {
    const ids = await boot(page, 'tabs', 3);
    await page.evaluate(() => {
      document.querySelectorAll<HTMLElement>('#tabs > .tab').forEach((t, i) => (t.dataset.mark = String(i)));
    });
    await page.evaluate((id) => window.__ccHarness.activate(id), ids[0]);
    await page.waitForTimeout(SETTLE_MS);
    const marks = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('#tabs > .tab')).map(t => t.dataset.mark ?? ''),
    );
    expect(marks).toEqual(['0', '1', '2']);
  });

  test('click on rail .reveal-cwd opens the reveal menu; picking Files fires shell.reveal', async ({ page }) => {
    const ids = await boot(page, 'tabs', 1);
    await page.evaluate(() => (window as any).__ccHarness.clearSent());
    await page.locator(`.tab[data-session-id="${ids[0]}"] .reveal-cwd`).click();
    await page.locator('.reveal-menu .reveal-menu-item').first().click();
    await page.waitForTimeout(SETTLE_MS);
    const sent = await page.evaluate(() => (window as any).__ccHarness.sent());
    const reveals = sent.filter((m: any) => m && m.type === 'shell.reveal');
    expect(reveals).toEqual([{ type: 'shell.reveal', id: ids[0], app: 'files' }]);
    expect(await storeOrder(page)).toEqual(ids);
  });

  test('click on pane-head .reveal-cwd opens the reveal menu; picking Files fires shell.reveal (grid mode)', async ({ page }) => {
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
