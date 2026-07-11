import { test, expect } from '@playwright/test';
import WebSocket from 'ws';

// ANTHROPIC_API_KEY is the definitive signal on CI (injected via GitHub
// Secrets). TEST_HAS_CLAUDE is a convenience gate for local dev where the
// user authenticated via `claude login` rather than setting the env var.
const hasClaude = !!process.env.ANTHROPIC_API_KEY || process.env.TEST_HAS_CLAUDE === 'true';

// Tests share one cchub server across all projects (chromium → firefox → webkit).
// Without per-test cleanup, sessions created by earlier projects leak and break
// tests that assume a clean slate (e.g. "首次加载弹出 launch dialog").
test.beforeEach(async () => {
  await new Promise<void>((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:3001/ws');
    ws.once('open', () => ws.send(JSON.stringify({ type: 'auth' })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'auth.ok') {
        // Wipe recentLaunches so tests that assert dropdown emptiness /
        // count don't inherit chips written by earlier tests in the same
        // shared server. Cheap: config write only, no session teardown.
        ws.send(JSON.stringify({ type: 'launch.recent.clear' }));
        ws.send(JSON.stringify({ type: 'session.list' }));
      }
      else if (msg.type === 'session.list') {
        for (const s of msg.sessions) ws.send(JSON.stringify({ type: 'session.destroy', id: s.id }));
        // Give the server a brief moment to process the destroys before closing.
        setTimeout(() => { ws.close(); resolve(); }, 100);
      }
    });
    ws.once('error', () => resolve());
  });
});

async function openConfig(page: any) {
  await page.goto('/');
  await page.click('.launch-dialog .dialog-close');
  await page.click('#config-button');
}

async function selectPresetByLabel(page: any, presetName: string) {
  await page.waitForFunction((name) => {
    const select = document.querySelector<HTMLSelectElement>('#launch-preset');
    return !!select && Array.from(select.options).some(o => o.textContent?.trim() === name);
  }, presetName, { timeout: 10000 });
  const selected = await page.evaluate((name) => {
    const select = document.querySelector<HTMLSelectElement>('#launch-preset');
    if (!select) throw new Error('missing #launch-preset');
    const option = Array.from(select.options).find(o => o.textContent?.trim() === name);
    if (!option) throw new Error(`missing preset ${name}`);
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value;
  }, presetName);
  expect(selected).toBeTruthy();
}

async function createSessionByPreset(page: any, presetName: string) {
  await page.goto('/?e2e=1');
  // Wait for the page to finish handling auth + session.list — only after
  // that do we know whether tabs from prior tests will appear (and need
  // cleanup) or the launch dialog will auto-open. Either signal is fine.
  await Promise.race([
    page.locator('#launch-dialog').waitFor({ state: 'visible', timeout: 10000 }),
    page.locator('.tab').first().waitFor({ state: 'visible', timeout: 10000 }),
  ]).catch(() => { /* either signal is fine; if neither shows we still try below */ });
  // Close any existing tabs left over from prior tests so this test starts clean.
  // Click each close button and wait for tab count to actually decrease before
  // moving to the next one — Firefox is slower to process WebSocket round-trips
  // and a 100ms fixed wait is unreliable.
  let prevCount = await page.locator('.tab').count();
  while (prevCount > 0) {
    await page.locator('.tab .tab-close').first().click();
    await expect(page.locator('.tab')).toHaveCount(prevCount - 1, { timeout: 5000 });
    prevCount = await page.locator('.tab').count();
  }
  // If there are existing sessions the dialog won't auto-open — force it open.
  if (!await page.locator('#launch-dialog').isVisible()) {
    await page.click('#new-session');
  }
  await selectPresetByLabel(page, presetName);
  await expect(page.locator('#launch-conda')).not.toBeDisabled({ timeout: 15000 });
  await page.click('#launch-create');
}

// Add another session on top of whatever already exists (no cleanup) — used by
// the multi-pane grid test, which needs ≥2 live terminals at once.
async function addSessionByPreset(page: any, presetName: string) {
  await page.click('#new-session');
  await expect(page.locator('#launch-dialog')).toBeVisible({ timeout: 5000 });
  await selectPresetByLabel(page, presetName);
  await expect(page.locator('#launch-conda')).not.toBeDisabled({ timeout: 15000 });
  await page.click('#launch-create');
}

test('首次加载弹出 launch dialog', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#launch-dialog')).toBeVisible();
});

test('连接状态在 3s 内变为 online', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#connection-badge')).toHaveText('online', { timeout: 3000 });
});

test('conda 下拉在 15s 内完成加载', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#launch-conda')).not.toBeDisabled({ timeout: 15000 });
  await expect(page.locator('#launch-conda')).not.toContainText('Loading');
});

test('切换 preset 更新字段', async ({ page }) => {
  await page.goto('/');
  // The seeded test config always provides ≥2 presets; wait for config to
  // arrive over the WebSocket and populate the select before reading options.
  // (Reading count() immediately races the round-trip and used to skip.)
  await expect(page.locator('#launch-dialog')).toBeVisible();
  const presets = page.locator('#launch-preset option');
  await expect(presets.nth(1)).toBeAttached({ timeout: 10000 });
  const second = await presets.nth(1).getAttribute('value');
  await page.selectOption('#launch-preset', second!);
  await expect(page.locator('#launch-server')).toBeVisible();
});

test('× 关闭 launch dialog', async ({ page }) => {
  await page.goto('/');
  await page.click('.launch-dialog .dialog-close');
  await expect(page.locator('#launch-dialog')).not.toBeVisible();
});

test('打开 config 对话框', async ({ page }) => {
  await openConfig(page);
  await expect(page.locator('#config-dialog')).toBeVisible();
});

test('新建 profile → 出现在列表', async ({ page }, testInfo) => {
  await openConfig(page);
  const name = `e2e-profile-${testInfo.testId.slice(-6)}`;
  await page.fill('#profile-name', name);
  await page.fill('#profile-base-url', 'http://example.com');
  await page.click('#profile-save');
  await expect(page.locator('#profile-list')).toContainText(name);
});

test('新建 local server → 出现在列表', async ({ page }, testInfo) => {
  await openConfig(page);
  // config-dialog opens on the "llm" tab; server fields live in a `hidden` panel until the tab clicks.
  await page.click('#config-dialog [data-tab="server"]');
  const name = `e2e-server-${testInfo.testId.slice(-6)}`;
  await page.selectOption('#server-kind', 'local');
  await page.fill('#server-name', name);
  await page.click('#server-save');
  await expect(page.locator('#server-list')).toContainText(name);
});

test('新建 preset → 出现在列表及 launch dialog', async ({ page }, testInfo) => {
  await openConfig(page);
  // config-dialog opens on the "llm" tab; preset fields live in a `hidden` panel until the tab clicks.
  await page.click('#config-dialog [data-tab="preset"]');
  const name = `e2e-preset-${testInfo.testId.slice(-6)}`;
  await page.fill('#preset-name', name);
  // server 和 cwd 是必填字段
  const firstServer = await page.locator('#preset-server option').nth(1).getAttribute('value');
  await page.selectOption('#preset-server', firstServer!);
  await page.fill('#preset-cwd', process.platform === 'win32' ? 'D:\\' : '/tmp');
  await page.click('#preset-save');
  await expect(page.locator('#preset-list')).toContainText(name);
  await page.click('.config-dialog .dialog-close');
  await page.click('#new-session');
  await expect(page.locator('#launch-preset')).toContainText(name);
});

// --- session 测试（需要 claude） ---

test('xterm 测量元素被 css 隐藏（不能渲染到视区内）', async ({ page }) => {
  await page.goto('/');
  // 关掉 launch dialog，让 terminal-card 处于初始无 session 的状态——
  // 即便没有 session，xterm 在创建后这些 helpers 也会出现；这里以
  // 创建 session 前的页面 css 加载状态做一次基础验证：xterm.css
  // 必须出现在文档样式表里。
  const has = await page.evaluate(() => {
    return Array.from(document.styleSheets).some(sheet => {
      try {
        return Array.from(sheet.cssRules).some(rule => /xterm-helpers|xterm-char-measure-element/.test(rule.cssText));
      } catch {
        return false;
      }
    });
  });
  expect(has).toBe(true);
});

test('生产模式不暴露 __cc_terminals 全局对象', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#connection-badge')).toHaveText('online', { timeout: 3000 });
  // 即使不创建 session 也应当确认 hook 完全不被装载。
  const present = await page.evaluate(() => '__cc_terminals' in (window as any));
  expect(present).toBe(false);
});

// --- 布局切换（多会话同时显示） ---

test('布局分段控件渲染三种模式且默认 tabs', async ({ page }) => {
  await page.goto('/');
  await page.click('.launch-dialog .dialog-close');
  const btns = page.locator('.layout-toggle .layout-toggle-btn');
  await expect(btns).toHaveCount(3);
  await expect(page.locator('.layout-toggle-btn[data-layout="tabs"]')).toHaveText('Tabs');
  await expect(page.locator('.layout-toggle-btn[data-layout="cols-2"]')).toHaveText('2-cols');
  await expect(page.locator('.layout-toggle-btn[data-layout="cols-3"]')).toHaveText('3-cols');
  // mountSessionView applies the persisted mode to the container on boot.
  await expect(page.locator('#terminal-container')).toHaveAttribute('data-layout', 'tabs');
});

test('点击布局按钮更新容器 data-layout 与高亮（无需 claude）', async ({ page }) => {
  await page.goto('/');
  await page.click('.launch-dialog .dialog-close');
  const container = page.locator('#terminal-container');

  await page.click('.layout-toggle-btn[data-layout="cols-2"]');
  await expect(container).toHaveAttribute('data-layout', 'cols-2');
  await expect(page.locator('.layout-toggle-btn[data-layout="cols-2"]')).toHaveClass(/is-active/);
  // 列数通过 CSS 自定义属性驱动 grid-template-columns
  const cols2 = await container.evaluate(el => getComputedStyle(el).getPropertyValue('--grid-cols').trim());
  expect(cols2).toBe('2');

  await page.click('.layout-toggle-btn[data-layout="cols-3"]');
  await expect(container).toHaveAttribute('data-layout', 'cols-3');
  const cols3 = await container.evaluate(el => getComputedStyle(el).getPropertyValue('--grid-cols').trim());
  expect(cols3).toBe('3');

  // 切回 tabs
  await page.click('.layout-toggle-btn[data-layout="tabs"]');
  await expect(container).toHaveAttribute('data-layout', 'tabs');
  await expect(page.locator('.layout-toggle-btn[data-layout="tabs"]')).toHaveClass(/is-active/);
});

test('布局偏好持久化到 localStorage 并在刷新后恢复', async ({ page }) => {
  await page.goto('/');
  await page.click('.launch-dialog .dialog-close');
  await page.click('.layout-toggle-btn[data-layout="cols-2"]');
  await expect(page.locator('#terminal-container')).toHaveAttribute('data-layout', 'cols-2');
  await page.reload();
  // 刷新后 launch dialog 复现（无 session）；容器仍应恢复成已存的 cols-2
  await expect(page.locator('#terminal-container')).toHaveAttribute('data-layout', 'cols-2', { timeout: 5000 });
  await expect(page.locator('.layout-toggle-btn[data-layout="cols-2"]')).toHaveClass(/is-active/);
  // 复位以免污染其它测试（beforeEach 只清 session，不清 localStorage）
  await page.click('.launch-dialog .dialog-close').catch(() => {});
  await page.click('.layout-toggle-btn[data-layout="tabs"]');
});

test('字体大小选择持久化到 localStorage 并在刷新后恢复（无需 claude）', async ({ page }) => {
  await page.goto('/');
  await page.click('.launch-dialog .dialog-close');
  const fontSelect = page.locator('#font-scale');
  // 默认 100%；切到一个非默认档位
  await expect(fontSelect).toHaveValue('100');
  await page.selectOption('#font-scale', '125');
  await expect(fontSelect).toHaveValue('125');
  // 已写入持久化键
  const saved = await page.evaluate(() => localStorage.getItem('cchub-font-scale'));
  expect(saved).toBe('125');
  await page.reload();
  // 刷新后无 session，launch dialog 复现；字体档位应恢复成 125
  await expect(page.locator('#font-scale')).toHaveValue('125', { timeout: 5000 });
  // 复位，避免污染其它测试
  await page.click('.launch-dialog .dialog-close').catch(() => {});
  await page.selectOption('#font-scale', '100');
});

test('切到 grid 布局时 sessions 侧栏收起，切回 tabs 复现（无需 claude）', async ({ page }) => {
  await page.goto('/');
  await page.click('.launch-dialog .dialog-close');
  const rail = page.locator('.session-rail');
  // 先归一到 tabs（localStorage 的布局会跨测试保留），确保已知基线：侧栏可见
  await page.click('.layout-toggle-btn[data-layout="tabs"]');
  await expect(rail).toBeVisible();

  // 切到两列网格：<html data-layout> 驱动侧栏 display:none，腾出版面
  await page.click('.layout-toggle-btn[data-layout="cols-2"]');
  await expect(page.locator('html')).toHaveAttribute('data-layout', 'cols-2');
  await expect(rail).toBeHidden();

  // 九宫格同样收起侧栏
  await page.click('.layout-toggle-btn[data-layout="cols-3"]');
  await expect(rail).toBeHidden();

  // 切回 tabs：侧栏复现
  await page.click('.layout-toggle-btn[data-layout="tabs"]');
  await expect(rail).toBeVisible();
});

test('local session: 创建 → tab 出现 → 终端有输出', async ({ page }) => {
  test.skip(!hasClaude, 'TEST_HAS_CLAUDE not set');
  const preset = process.env.TEST_LOCAL_PRESET ?? 'cchub';
  await createSessionByPreset(page, preset);
  // tab 出现
  await expect(page.locator('.tab')).toBeVisible({ timeout: 10000 });
  // 终端在 15s 内收到输出
  await expect(page.locator('#terminal-container .xterm-rows')).not.toBeEmpty({ timeout: 15000 });
});

test('local session: 创建后无需刷新即可看到内容、viewport 高度跟随容器', async ({ page }) => {
  test.skip(!hasClaude, 'TEST_HAS_CLAUDE not set');
  const preset = process.env.TEST_LOCAL_PRESET ?? 'cchub';
  await createSessionByPreset(page, preset);
  await expect(page.locator('.tab')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#terminal-container .xterm-rows')).not.toBeEmpty({ timeout: 15000 });
  // viewport 应填满容器（容差允许 1 行字符差），而非被毒化成 ~6 行
  const sizes = await page.evaluate(() => {
    const container = document.querySelector('#terminal-container > div')!;
    const viewport = document.querySelector('.xterm-viewport')!;
    const cm = document.querySelector('.xterm-char-measure-element')!;
    return {
      containerH: container.getBoundingClientRect().height,
      viewportH: viewport.getBoundingClientRect().height,
      charH: cm.getBoundingClientRect().height,
    };
  });
  expect(sizes.viewportH).toBeGreaterThan(sizes.containerH - sizes.charH * 2);
});

// 真实启动无残骸哨兵：这条与 terminalScreen.spec 的 "剥离 C0/C1 控制字符残骸"
// 不重复——后者直测剥离算法，本条端到端验证「真实 PTY 启动序列经 TerminalScreen
// 处理后屏幕顶部不残留垃圾」，是回归烟测。三引擎（chromium/firefox/webkit）各跑一遍，
// 确保每个浏览器的真实启动渲染都无残骸。
test('local session: 真实启动后顶部无控制字符残骸（端到端哨兵）', async ({ page }) => {
  test.skip(!hasClaude, 'TEST_HAS_CLAUDE not set');
  const preset = process.env.TEST_LOCAL_PRESET ?? 'cchub';
  await createSessionByPreset(page, preset);
  await expect(page.locator('.tab')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#terminal-container .xterm-rows')).not.toBeEmpty({ timeout: 15000 });
  await page.waitForTimeout(2000);
  const headLines = await page.evaluate(() => {
    const rows = document.querySelectorAll('.xterm-rows > div');
    return Array.from(rows).slice(0, 5).map(r => r.textContent ?? '');
  });
  // 任何 C0/C1 控制字符均视为残骸
  for (const line of headLines) {
    expect(line).not.toMatch(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/);
  }
});

test('local session: 发送输入 → 收到回显', async ({ page }) => {
  test.skip(!hasClaude, 'TEST_HAS_CLAUDE not set');
  const preset = process.env.TEST_LOCAL_PRESET ?? 'cchub';
  await createSessionByPreset(page, preset);
  await expect(page.locator('.tab')).toBeVisible({ timeout: 10000 });
  // 等待 claude 启动（出现 prompt 标志）
  await expect(page.locator('#terminal-container')).toContainText('❯', { timeout: 20000 });
  // 发送输入
  await page.locator('#terminal-container').click();
  await page.keyboard.type('echo hello-cchub');
  await page.keyboard.press('Enter');
  await expect(page.locator('#terminal-container')).toContainText('hello-cchub', { timeout: 5000 });
});

test('local session: 关闭 tab → tab 消失', async ({ page }) => {
  test.skip(!hasClaude, 'TEST_HAS_CLAUDE not set');
  const preset = process.env.TEST_LOCAL_PRESET ?? 'cchub';
  await createSessionByPreset(page, preset);
  const tab = page.locator('.tab').first();
  await expect(tab).toBeVisible({ timeout: 10000 });
  await tab.locator('.tab-close').click();
  await expect(page.locator('.tab')).toHaveCount(0, { timeout: 5000 });
});

// 多会话同时显示：cols-2 网格下两个 session 的终端 pane 应同时可见，并带浮动标签。
// 这是本功能的端到端核心验证——区别于上面"无 claude"的纯 UI 切换测试，这里需要真实
// 的两个终端 DOM 同框渲染。
test('grid 布局: 两个 session 的终端同时可见并带标签', async ({ page }) => {
  test.skip(!hasClaude, 'TEST_HAS_CLAUDE not set');
  const preset = process.env.TEST_LOCAL_PRESET ?? 'cchub';
  await createSessionByPreset(page, preset);
  await expect(page.locator('.tab')).toHaveCount(1, { timeout: 10000 });
  await addSessionByPreset(page, preset);
  await expect(page.locator('.tab')).toHaveCount(2, { timeout: 10000 });

  // 切到两列网格
  await page.click('.layout-toggle-btn[data-layout="cols-2"]');
  await expect(page.locator('#terminal-container')).toHaveAttribute('data-layout', 'cols-2');

  // 两个 pane 都进入 grid 模式且都可见（tabs 模式下只有 active 可见）
  const panes = page.locator('#terminal-container .term-pane.is-grid');
  await expect(panes).toHaveCount(2, { timeout: 5000 });
  const visibilities = await panes.evaluateAll(els =>
    els.map(el => getComputedStyle(el as HTMLElement).visibility),
  );
  expect(visibilities).toEqual(['visible', 'visible']);

  // 每个 pane 都带非空名称：data-cc-label 仍用于布局，且新的 .pane-head 真实
  // DOM 头部（状态点 + 名称 + 关闭）在 grid 模式下显示该 pane 自己的名称。
  const labels = await panes.evaluateAll(els =>
    els.map(el => (el as HTMLElement).dataset.ccLabel ?? ''),
  );
  for (const label of labels) expect(label.length).toBeGreaterThan(0);

  // 每个 pane 的头部都可见并显示非空名称（独立状态/标识，而非全局标题栏）
  const heads = page.locator('#terminal-container .term-pane.is-grid .pane-head');
  await expect(heads).toHaveCount(2);
  const headNames = await heads.evaluateAll(els =>
    els.map(el => (el.querySelector('.pane-name')?.textContent ?? '').trim()),
  );
  for (const name of headNames) expect(name.length).toBeGreaterThan(0);
  const headVisas = await heads.evaluateAll(els =>
    els.map(el => getComputedStyle(el as HTMLElement).display),
  );
  for (const d of headVisas) expect(d).not.toBe('none');

  // 两个 pane 在视口里横向并排（左右排列，x 不同、顶边相近）
  const boxes = await panes.evaluateAll(els =>
    els.map(el => { const r = (el as HTMLElement).getBoundingClientRect(); return { x: r.x, y: r.y }; }),
  );
  expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThan(4);
  expect(Math.abs(boxes[0].x - boxes[1].x)).toBeGreaterThan(40);

  // 复位布局，避免污染后续测试（localStorage 不被 beforeEach 清理）
  await page.click('.layout-toggle-btn[data-layout="tabs"]');

  // Explicitly close the two sessions this test opened. Leaving live claude
  // PTYs for the next beforeEach to tear down accumulates ConPTY shutdown
  // pressure on Windows and drags out the tail of the suite.
  let remaining = await page.locator('.tab').count();
  while (remaining > 0) {
    await page.locator('.tab .tab-close').first().click();
    await expect(page.locator('.tab')).toHaveCount(remaining - 1, { timeout: 5000 });
    remaining = await page.locator('.tab').count();
  }
});

test('session: PTY cols/rows 与 xterm 实际容纳行列一致', async ({ page }) => {
  test.skip(!hasClaude, 'TEST_HAS_CLAUDE not set');
  const preset = process.env.TEST_LOCAL_PRESET ?? process.env.TEST_REMOTE_PRESET ?? 'cchub';
  await createSessionByPreset(page, preset);
  await expect(page.locator('.tab')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#terminal-container .xterm-rows')).not.toBeEmpty({ timeout: 15000 });
  // Click to ensure layout is settled and the terminal is the active visible one
  await page.locator('#terminal-container').click();
  await page.waitForTimeout(300);

  const { ptyRows, fitRows, ptyCols, fitCols } = await page.evaluate(() => {
    // term.cols/rows is the authoritative PTY size from the active xterm instance
    const terms = (window as any).__cc_terminals || {};
    const term = Object.values(terms)[0] as any;
    const ptyCols = term?.cols ?? 0;
    const ptyRows = term?.rows ?? 0;
    // Find the visible terminal div for the rendered measurements
    const termEl = [...document.querySelectorAll('#terminal-container > div')].find(
      el => el.style.visibility === 'visible'
    );
    const vp = termEl && termEl.querySelector('.xterm-viewport');
    const screen = termEl && termEl.querySelector('.xterm-screen');
    const cm = document.querySelector('.xterm-char-measure-element');
    const charH = (cm && cm.getBoundingClientRect().height) || 18;
    const charW = (cm && cm.getBoundingClientRect().width)
      ? cm.getBoundingClientRect().width / ((cm.textContent && cm.textContent.length) || 32)
      : 8;
    const vpH = (vp && vp.getBoundingClientRect().height) || 0;
    const screenW = (screen && screen.getBoundingClientRect().width) || 0;
    return {
      ptyRows,
      fitRows: Math.floor(vpH / charH),
      ptyCols,
      fitCols: Math.floor(screenW / charW),
    };
  });

  // Allow ±2 tolerance for rounding
  expect(Math.abs(ptyRows - fitRows)).toBeLessThanOrEqual(2);
  expect(Math.abs(ptyCols - fitCols)).toBeLessThanOrEqual(2);
});

test('session: 滚动条可拖拽', async ({ page }) => {
  test.skip(!hasClaude, 'TEST_HAS_CLAUDE not set');
  const preset = process.env.TEST_LOCAL_PRESET ?? process.env.TEST_REMOTE_PRESET ?? 'cchub';
  await createSessionByPreset(page, preset);
  await expect(page.locator('.tab')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#terminal-container .xterm-rows')).not.toBeEmpty({ timeout: 15000 });

  // Inject scrollback. Claude Code runs in the alternate screen buffer (which
  // has no scrollback by design — like vim/less), so we exit alt-screen mode
  // first via DECRST 1049, then write 200 lines into the normal buffer.
  await page.evaluate(() => {
    const terms = (window as any).__cc_terminals || {};
    const term = Object.values(terms)[0] as any;
    if (!term) return;
    term.write('\x1b[?1049l');
    let payload = '';
    for (let i = 0; i < 200; i++) payload += `scrollback line ${i}\r\n`;
    term.write(payload);
  });
  await page.waitForTimeout(500);

  // Target the visible terminal's viewport only
  const vp = page.locator('#terminal-container > div[style*="visibility: visible"] .xterm-viewport');
  const box = await vp.boundingBox();
  if (!box) throw new Error('viewport not found');

  // xterm auto-scrolls to bottom on write — scroll to top so the drag has somewhere to go.
  await vp.evaluate((el: HTMLElement) => { el.scrollTop = 0; });
  await page.waitForTimeout(50);
  const before = await vp.evaluate((el: HTMLElement) => el.scrollTop);
  expect(before).toBe(0);

  // Drag from near the top of the scrollbar to 40% down
  const sbX = box.x + box.width - 8;
  const sbY1 = box.y + 20;
  const sbY2 = box.y + box.height * 0.4;
  await page.mouse.move(sbX, sbY1);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(sbX, sbY1 + (sbY2 - sbY1) * i / 8);
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
  await page.waitForTimeout(200);

  const after = await vp.evaluate((el: HTMLElement) => el.scrollTop);
  expect(after).toBeGreaterThan(before);
});

// IME 锚定回归：cc 的 thinking 动画把 PTY 光标当作绘图原语反复移动，xterm 的
// CompositionHelper.updateCompositionElements 会把 `.xterm-helper-textarea`
// 和 `.composition-view` 一起同步到当前光标格，于是用户打中文时 OS 的 inline
// 合成窗口（钉在 ta）和候选框都会跟着 thinking 漂。
//
// 用真实 IME 没法在 Playwright 里复现（OS 拦截），但 xterm 监听的是 textarea
// 上的 composition 事件，合成 dispatchEvent 走的就是同一条 CompositionHelper
// 路径——经真实 IME log 比对（同样的 ta.style mutation 频率/模式）确认 faithful。
//
// 当前实现:扫 xterm buffer 找 cc prompt 的 `❯` 行,用 CSS !important + CSS
// 变量把 cv 和 ta 渲染位置钉在那一行;xterm 仍然往 inline style.left/top 写
// 漫游值,但渲染层永远盖不住 !important。所以断言看 getBoundingClientRect
// 而不是 style.left,期望位置 = `❯` 那行的 viewport y。
test('IME 锚定: 组字期间 cv 与 ta 渲染位置都钉在 cc prompt 行', async ({ page }) => {
  test.skip(!hasClaude, 'TEST_HAS_CLAUDE not set');
  const preset = process.env.TEST_LOCAL_PRESET ?? 'cchub';
  await createSessionByPreset(page, preset);
  await expect(page.locator('.tab')).toBeVisible({ timeout: 10000 });
  // Wait for claude to be up and the prompt to render so the buffer is stable
  // before we start poking the cursor — otherwise startup output can interleave
  // with our synthetic cursor moves and the snapshot races become flaky.
  await expect(page.locator('#terminal-container')).toContainText('❯', { timeout: 20000 });
  await page.waitForTimeout(500);

  const result = await page.evaluate(async () => {
    const terms = (window as any).__cc_terminals || {};
    const id = Object.keys(terms)[0];
    if (!id) throw new Error('no terminal exposed (need ?e2e=1)');
    const term = terms[id];
    const xtermEl = (document.querySelector('.terminal-pane.is-active .xterm')
      || document.querySelector('.xterm')) as HTMLElement | null;
    if (!xtermEl) throw new Error('no xterm DOM');
    const ta = xtermEl.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
    if (!ta) throw new Error('no xterm-helper-textarea');
    const screen = xtermEl.querySelector('.xterm-screen') as HTMLElement | null;
    if (!screen) throw new Error('no xterm-screen');

    const writeAndWait = (s: string) => new Promise<null>((res) =>
      term.write(s, () => requestAnimationFrame(() => res(null))));
    // updateCompositionElements schedules a setTimeout(0) recursive call,
    // and 0-ms timers don't fire inside the same microtask tick — give them
    // a real macrotask + raf to land before snapshotting.
    const settle = () => new Promise<null>((r) =>
      setTimeout(() => requestAnimationFrame(() => r(null)), 8));

    // The pin is a rendered-position contract: xterm's inline style.left
    // continues to wander (it writes the cursor cell on every update), but
    // the !important CSS rule fixes the actual painted rect. So we read
    // getBoundingClientRect, not style.left.
    const snap = () => {
      const cv = xtermEl.querySelector('.composition-view') as HTMLElement | null;
      const taR = ta.getBoundingClientRect();
      const cvR = cv ? cv.getBoundingClientRect() : null;
      return {
        ta_left: taR.left,
        ta_top: taR.top,
        cv_left: cvR ? cvR.left : null,
        cv_top: cvR ? cvR.top : null,
        cv_visible: cv ? (cv.offsetWidth > 0 && getComputedStyle(cv).display !== 'none') : false,
      };
    };

    // Compute the expected pin y by scanning the buffer (mirrors production
    // logic in terminalIme.ts findPromptRow). This lets the test verify "the
    // pin landed on the `❯` row" regardless of where cc happens to render
    // its prompt — bottom row today, somewhere else tomorrow.
    const findPromptRow = (): number | null => {
      const buf = term.buffer.active;
      for (let r = term.rows - 1; r >= 0; r--) {
        const line = buf.getLine(buf.viewportY + r);
        if (!line) continue;
        if (line.translateToString(true).includes('❯')) return r;
      }
      return null;
    };
    const xtermRows = xtermEl.querySelector('.xterm-rows');
    const firstRow = xtermRows ? (xtermRows.firstElementChild as HTMLElement | null) : null;
    const rowHeight = firstRow && firstRow.offsetHeight > 0 ? firstRow.offsetHeight : 18;
    const promptRow = findPromptRow();

    // Pin PTY cursor to a known cell well above the prompt so the cursor
    // wander has somewhere to start from (not on the prompt row, so we can
    // tell the pin actually fired vs. xterm coincidentally landing there).
    await writeAndWait('\x1b[3;5H');
    await settle();

    // Start IME composition. xterm's compositionstart shows cv; our handler
    // adds the cc-ime-pinned class on capture phase before xterm reaches
    // for the cursor cell.
    ta.focus();
    ta.value = '';
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    ta.value = 'n';
    ta.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 'n' }));
    ta.dispatchEvent(new InputEvent('input', {
      bubbles: true, data: 'n', inputType: 'insertCompositionText', isComposing: true,
    }));
    await settle();
    const anchor = snap();
    const screenRect = screen.getBoundingClientRect();

    // For each simulated thinking-step: move cursor far away, then fire
    // another compositionupdate (same as a user continuing to type pinyin).
    // xterm's updateCompositionElements writes inline style.left/top to the
    // new cursor cell, but the rendered rect must stay at the pin.
    const samples: Array<{ label: string } & ReturnType<typeof snap>> = [];
    const cursorPlan: Array<[number, number]> = [[20, 70], [5, 40], [15, 30]];
    let buf = 'n';
    for (const [row, col] of cursorPlan) {
      await writeAndWait(`\x1b[${row};${col}H`);
      await settle();
      samples.push({ label: `wander(${row},${col})`, ...snap() });
      buf += 'i';
      ta.value = buf;
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: buf }));
      ta.dispatchEvent(new InputEvent('input', {
        bubbles: true, data: buf, inputType: 'insertCompositionText', isComposing: true,
      }));
      await settle();
      samples.push({ label: `update(${buf})@(${row},${col})`, ...snap() });
    }

    // Horizontal follow: when the prompt row gains characters (cc echoes a
    // committed character, or just more content), the inline preview's left
    // must advance so it sits at the input column, not stuck at the row's
    // start. Simulate by writing extra glyphs into the prompt row through
    // xterm (xterm-only — cc doesn't see this, we're testing client anchor
    // math), then fire another update. cv left should be strictly greater.
    let afterAppend: ReturnType<typeof snap> | null = null;
    if (promptRow !== null) {
      await writeAndWait(`\x1b[${promptRow + 1};1H❯ ABCDEFGH`);
      await settle();
      ta.value = buf + 'a';
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: ta.value }));
      ta.dispatchEvent(new InputEvent('input', {
        bubbles: true, data: ta.value, inputType: 'insertCompositionText', isComposing: true,
      }));
      await settle();
      afterAppend = snap();
    }

    // Long-content shift: a very long composing string forces the anchor
    // to slide back toward 0 so the trailing end of the inline preview
    // doesn't overflow `.xterm-screen` and visually squeeze the layout.
    // 200 chars far exceeds any reasonable screen width.
    ta.value = 'a'.repeat(200);
    ta.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: ta.value }));
    ta.dispatchEvent(new InputEvent('input', {
      bubbles: true, data: ta.value, inputType: 'insertCompositionText', isComposing: true,
    }));
    await settle();
    const afterLong = snap();

    // Clean up so we don't leave xterm in a half-composing state for later tests.
    ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: buf }));
    ta.value = '';
    await settle();

    return {
      anchor,
      samples,
      afterAppend,
      afterLong,
      screenTop: screenRect.top,
      screenBottom: screenRect.bottom,
      screenLeft: screenRect.left,
      promptRow,
      rowHeight,
    };
  });

  // cv is visible and rendered at the same place as ta (the OS IME anchors
  // its candidate window to ta, so they must coincide).
  expect(result.anchor.cv_visible).toBe(true);
  expect(result.anchor.cv_left).not.toBeNull();
  expect(Math.abs(result.anchor.ta_left - result.anchor.cv_left!)).toBeLessThan(2);
  expect(Math.abs(result.anchor.ta_top - result.anchor.cv_top!)).toBeLessThan(2);

  // The pin lands on the row containing `❯` (cc's prompt marker). If the
  // scan didn't find it, the production code falls back to the bottom row
  // of `.xterm-screen` — handle both cases. (cc's prompt is normally there
  // once startup finishes, so promptRow should be non-null in practice.)
  expect(result.promptRow).not.toBeNull();
  const expectedTop = result.screenTop + result.promptRow! * result.rowHeight;
  expect(Math.abs(result.anchor.cv_top! - expectedTop)).toBeLessThan(result.rowHeight);
  // cv sits past the left edge of the screen (at or after the prompt marker).
  expect(result.anchor.cv_left!).toBeGreaterThanOrEqual(result.screenLeft - 1);

  // Across cursor wanders the rendered position stays at the pin (sub-pixel
  // tolerance allowed since getBoundingClientRect returns floats). The wander
  // loop doesn't change prompt-row content, so horizontal also stays put.
  for (const s of result.samples) {
    expect(s.cv_visible, `cv invisible at ${s.label}`).toBe(true);
    expect(Math.abs(s.cv_left! - result.anchor.cv_left!), `cv.left drift at ${s.label}`).toBeLessThan(2);
    expect(Math.abs(s.cv_top! - result.anchor.cv_top!), `cv.top drift at ${s.label}`).toBeLessThan(2);
    expect(Math.abs(s.ta_left - result.anchor.ta_left), `ta.left drift at ${s.label}`).toBeLessThan(2);
    expect(Math.abs(s.ta_top - result.anchor.ta_top), `ta.top drift at ${s.label}`).toBeLessThan(2);
  }

  // Horizontal follow: after appending `❯ ABCDEFGH` (8 chars beyond `❯ `),
  // cv left should have advanced by ~8 cell-widths from the initial anchor.
  // Tolerance is loose — we just need to confirm the column-tracking logic
  // fires on compositionupdate, not pixel-perfect alignment.
  expect(result.afterAppend).not.toBeNull();
  expect(result.afterAppend!.cv_left!).toBeGreaterThan(result.anchor.cv_left! + 40);
  // And it didn't slip off the prompt row vertically.
  expect(Math.abs(result.afterAppend!.cv_top! - result.anchor.cv_top!)).toBeLessThan(2);

  // Long-content shift: with a 200-char composing string, the anchor must
  // have moved back to (or near) the left edge of `.xterm-screen` so the
  // inline preview's trailing end stays in-frame. Without this, an overlong
  // composing string would push the inline preview into surrounding layout
  // and visually squeeze it.
  expect(result.afterLong.cv_left!).toBeLessThan(result.afterAppend!.cv_left!);
  expect(result.afterLong.cv_left!).toBeLessThan(result.screenLeft + 4);
  // Still on the prompt row.
  expect(Math.abs(result.afterLong.cv_top! - result.anchor.cv_top!)).toBeLessThan(2);
});

test('local session: 刷新后 wheel 仍被 xterm forward 给 cc（DEC mode 恢复）', async ({ page }) => {
  test.skip(!hasClaude, 'TEST_HAS_CLAUDE not set');
  const preset = process.env.TEST_LOCAL_PRESET ?? 'cchub';
  await createSessionByPreset(page, preset);
  await expect(page.locator('.tab')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#terminal-container')).toContainText('❯', { timeout: 20000 });
  await page.waitForTimeout(1500);

  const probeTerm = async () => await page.evaluate(async () => {
    const terms = (window as any).__cc_terminals || {};
    const ids = Object.keys(terms);
    if (ids.length === 0) return { bufferType: '', wheelBytes: '' };
    const term = terms[ids[0]];
    const bufferType = term.buffer.active.type as string; // 'normal' | 'alternate'
    const bytes: string[] = [];
    const sub = term.onData((d: string) => bytes.push(d));
    try {
      const vp = document.querySelector('.xterm-viewport') as HTMLElement | null;
      if (vp) {
        const rect = vp.getBoundingClientRect();
        vp.dispatchEvent(new WheelEvent('wheel', {
          deltaY: -300, deltaMode: 0,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          bubbles: true, cancelable: true,
        }));
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      sub.dispose();
    }
    return { bufferType, wheelBytes: bytes.join('') };
  });

  const pre = await probeTerm();
  expect(pre.bufferType, '刷新前 cc 应处于 alt-screen（?1049h）').toBe('alternate');
  expect(pre.wheelBytes, '刷新前 xterm 应把 wheel 转成 mouse escape 送给 cc').toMatch(/\x1b\[[<M]/);

  await page.goto('/?e2e=1');
  await expect(page.locator('.tab')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#terminal-container')).toContainText('❯', { timeout: 20000 });
  await page.waitForTimeout(1500);

  const post = await probeTerm();
  expect(post.bufferType, '刷新后 modeSetup 应把 xterm 切回 alt-screen').toBe('alternate');
  expect(post.wheelBytes, '刷新后 mouse tracking 应通过 snapshot.modeSetup 恢复')
    .toMatch(/\x1b\[[<M]/);

  await page.locator('.tab .tab-close').first().click();
});

test('remote session: 创建 → tab 出现 → 终端有输出', async ({ page }) => {
  test.skip(!hasClaude, 'TEST_HAS_CLAUDE not set');
  test.skip(!process.env.TEST_REMOTE_PRESET, 'TEST_REMOTE_PRESET not set');
  // The remote path (SSH → login bash → conda activate → claude) is the slowest
  // startup in the suite, and this is the last test to run across three engines.
  // The multi-session grid tests added real claude spawns, lengthening the run
  // (~5.4 min) and the tail-of-suite load this test starts under, so first output
  // can take well over 40s on the slowest engine. Budget sized to that real cost
  // (it passes in seconds in isolation — this is load latency, not a hang; the
  // terminal is attached and rendering, just awaiting remote stdout).
  test.setTimeout(90000);
  await createSessionByPreset(page, process.env.TEST_REMOTE_PRESET!);
  await expect(page.locator('.tab')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#terminal-container .xterm-rows')).not.toBeEmpty({ timeout: 60000 });
});

test('recent launches: chip 单击直接再启动，Shift+click 预填 dialog', async ({ page }) => {
  test.skip(!hasClaude, 'TEST_HAS_CLAUDE not set');
  const preset = process.env.TEST_LOCAL_PRESET ?? 'cchub';

  // Arrange: create a session so recentLaunches gets a chip, then close it so
  // the dropdown-driven flow can create a fresh one without a tab already up.
  await createSessionByPreset(page, preset);
  await expect(page.locator('.tab')).toBeVisible({ timeout: 10000 });
  await page.locator('.tab .tab-close').first().click();
  await expect(page.locator('.tab')).toHaveCount(0, { timeout: 5000 });

  // The launch dialog auto-opens when there are no live sessions — close it
  // so the topbar caret is the *only* path we're exercising.
  if (await page.locator('#launch-dialog').isVisible()) {
    await page.locator('.launch-dialog .dialog-close').click();
    await expect(page.locator('#launch-dialog')).not.toBeVisible();
  }

  // Hover → dropdown opens → recent chip for the preset we just launched is there.
  await page.hover('#new-menu-toggle');
  const menu = page.locator('#new-menu');
  await expect(menu).toBeVisible();
  const chip = menu.locator('.recent-item').first();
  await expect(chip).toContainText(preset);

  // Case 1: plain click → session spawns immediately, no dialog.
  await chip.click();
  await expect(page.locator('.tab')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#launch-dialog')).not.toBeVisible();
  await page.locator('.tab .tab-close').first().click();
  await expect(page.locator('.tab')).toHaveCount(0, { timeout: 5000 });

  // Case 2: Shift+click → dialog opens pre-filled with the chip's preset.
  if (await page.locator('#launch-dialog').isVisible()) {
    await page.locator('.launch-dialog .dialog-close').click();
    await expect(page.locator('#launch-dialog')).not.toBeVisible();
  }
  await page.hover('#new-menu-toggle');
  await expect(menu).toBeVisible();
  await chip.click({ modifiers: ['Shift'] });
  await expect(page.locator('#launch-dialog')).toBeVisible();
  const presetSelect = page.locator('#launch-preset');
  const selectedLabel = await presetSelect.locator('option:checked').first().textContent();
  expect(selectedLabel?.trim()).toBe(preset);
});

