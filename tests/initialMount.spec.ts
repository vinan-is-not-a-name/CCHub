import { test, expect, type Page } from '@playwright/test';

/**
 * Regression test for the right-edge render defect on session initial mount.
 *
 * Repro path: messageRouter calls `terminal.loadSnapshot()` on
 * `session.attached`, which internally runs RAW `fit.fit()` — FitAddon's
 * native logic, without the H_PAD-7 offset and without setting
 * `.xterm-screen.style.left`. Native fit yields cols = floor(bodyW / cellW),
 * about 2 more than fitSticky's cols = floor((bodyW - 14) / cellW). So
 * `.xterm-screen` overflows pane-body by ~2*cellW ≈ 17px: the right-most
 * column is clipped and the next row's head is cut off. Changing layout
 * re-runs fitSticky via relayout, cols drop back to 75, and the state
 * self-heals.
 *
 * This test pins the invariant: after loadSnapshot + two xterm RAF frames,
 * the state must match the post-initial-mount state (fitSticky already ran)
 * — same cols, no right-overflow of `.xterm-screen` relative to body. No
 * pixel comparison, only DOM facts, and assertions tight enough to leave
 * no room for a "transiently wrong then re-stabilizes" state.
 */

async function boot(page: Page): Promise<string> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/harness.html?e2e=1');
  await page.waitForFunction(() => '__ccHarness' in window);
  return page.evaluate(() => {
    const h = (window as any).__ccHarness;
    h.setLayout('cols-2');
    return h.addSession() as string;
  });
}

interface RenderState {
  cols: number;
  rows: number;
  screenLeft: string;
  overflowRight: number;
  overflowLeft: number;
  bodyW: number;
}

async function measure(page: Page, id: string): Promise<RenderState> {
  return page.evaluate((sid) => {
    const term = (window as any).__cc_terminals[sid];
    const pane = document.querySelector(`.term-pane[data-session-id="${sid}"]`) as HTMLElement;
    const body = pane.querySelector('.pane-body') as HTMLElement;
    const screen = pane.querySelector('.xterm-screen') as HTMLElement;
    const b = body.getBoundingClientRect();
    const sc = screen.getBoundingClientRect();
    return {
      cols: term.cols,
      rows: term.rows,
      screenLeft: screen.style.left,
      overflowRight: +(sc.right - b.right).toFixed(2),
      overflowLeft: +(sc.left - b.left).toFixed(2),
      bodyW: b.width,
    };
  }, id);
}

async function raf(page: Page, n = 2): Promise<void> {
  await page.evaluate(async (times) => {
    for (let i = 0; i < times; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
  }, n);
}

test.describe('会话初挂载渲染不变量', () => {
  test('loadSnapshot 后不得让 .xterm-screen 溢出 pane-body 右边', async ({ page }) => {
    const id = await boot(page);
    await raf(page, 3);

    const initial = await measure(page, id);
    // 初挂载 fitSticky 跑完后应处正常状态:screen 有 left 补偿,右边不溢出
    expect(initial.screenLeft, '初挂载 fitSticky 应设 screen.style.left').not.toBe('');
    expect(initial.overflowRight, '初挂载 screen 不得右溢出 body').toBeLessThanOrEqual(2);

    // 触发生产上 `session.attached` 的真实路径 —— loadSnapshot 内 raw fit
    await page.evaluate((sid) => {
      (window as any).__ccHarness.loadSnapshot(sid, null);
    }, id);
    await raf(page, 3);

    const afterSnapshot = await measure(page, id);

    // Key invariant: the fit inside loadSnapshot must also go through
    // fitSticky's H_PAD-7 logic, so .xterm-screen can't overflow pane-body's
    // right edge — that overflow is exactly the "right-edge render bug"
    // symptom. 2px tolerance covers sub-pixel jitter.
    expect(afterSnapshot.overflowRight, 'loadSnapshot must not let .xterm-screen overflow body').toBeLessThanOrEqual(2);

    // cols 必须与初挂载后一致:loadSnapshot 不应把 cols 拉宽再回不来 —— 中间
    // 那段"拉宽"内 term.write 已按错误列数 wrap,cols 事后回落也救不回内容。
    expect(afterSnapshot.cols, `loadSnapshot 前后 cols 应保持一致(初=${initial.cols}, 后=${afterSnapshot.cols})`).toBe(initial.cols);

    // screen.style.left 也必须保留:raw fit 不动 left,若 cols 变大 screen 会
    // 从 [left, left+cols*cellW] 撑出右边 —— 断言用来锁死"left 加 cols*cellW 不
    // 超 bodyW"这个几何契约,不允许中间态破坏。
    expect(afterSnapshot.screenLeft, 'loadSnapshot 后 screen.style.left 应与初挂载一致').toBe(initial.screenLeft);
  });

  test('loadSnapshot 后左右留白应对称(与 layout 切换后的状态一致)', async ({ page }) => {
    const id = await boot(page);
    await raf(page, 3);
    const initial = await measure(page, id);

    await page.evaluate((sid) => (window as any).__ccHarness.loadSnapshot(sid, null), id);
    await raf(page, 3);
    const afterSnap = await measure(page, id);

    // Simulate the "toggle layout to fix render" workaround: tabs ↔ cols-2 roundtrip
    await page.evaluate(() => (window as any).__ccHarness.setLayout('tabs'));
    await raf(page, 2);
    await page.evaluate(() => (window as any).__ccHarness.setLayout('cols-2'));
    await raf(page, 3);
    const afterToggle = await measure(page, id);

    // The bug's core symptom is that toggling the layout fixes it — which
    // means the pre-toggle state is wrong. Pin the invariant: state after
    // loadSnapshot must already equal state after a layout toggle.
    expect(afterSnap.cols, `loadSnapshot 后 cols 应等于 layout toggle 后 cols`).toBe(afterToggle.cols);
    expect(afterSnap.overflowRight, `loadSnapshot 后 overflowRight 应等于 layout toggle 后 overflowRight`).toBe(afterToggle.overflowRight);
    expect(afterSnap.screenLeft, `loadSnapshot 后 screen.style.left 应等于 layout toggle 后 screen.style.left`).toBe(afterToggle.screenLeft);

    // 初挂载状态也应等于 toggle 后状态(sanity:确认 fitSticky 初挂载已生效)
    expect(initial.cols).toBe(afterToggle.cols);
  });
});
