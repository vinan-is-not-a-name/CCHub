import { test, expect, type Page } from '@playwright/test';
import type { LayoutMode } from '../src/client/views/layout.js';

/**
 * cc 渲染容器回归套件 —— 专测「字符越界 / 光标位置错误 / 排版错乱 / 无法滚动」。
 *
 * 为什么是真实浏览器而非纯 Node:这四类问题全是真实 DOM + 真实 CSS + 真实 xterm
 * 在特定尺寸下的渲染结果(getBoundingClientRect、字体度量、CSS grid 实际分配),
 * mock DOM 一个都抓不到。套件经 /harness.html(?e2e=1) 驱动 REAL 渲染链路
 * (makeAttachController → attachTerminal → relayout → placeTerminal),喂合成数据,
 * 不需要 claude、不发 WebSocket —— 与生产渲染像素级一致,只是确定性、快。
 *
 * 重点覆盖 grid 模式下被压小的单 pane(cols-3 下单 pane ≈ 容器宽/3,再减 gap/border/
 * pane-head),这是 fit 取整误差与字符越界的高发区,光测整容器会漏掉。
 */

interface PaneMetrics {
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  // pane-body(终端实际挂载区)内容盒
  bodyW: number;
  bodyH: number;
  // .xterm-screen(字符渲染区)相对 body 的溢出量(>容差即越界)
  overflowRight: number;
  overflowBottom: number;
  // 可滚动性
  scrollHeight: number;
  clientHeight: number;
  canScroll: boolean;
  scrolledTo: number;
  // 容器可容纳的 cell 数(用 body 尺寸 / cell 尺寸推算),与 cols/rows 比对查排版
  fitCols: number;
  fitRows: number;
}

const SETTLE_MS = 120;

async function boot(
  page: Page,
  opts: { width: number; height: number; layout: LayoutMode; sessions: number; fontScale?: number },
): Promise<string[]> {
  // 字号在 createTerminal 构造时读 localStorage,必须在建 session 前注入。
  if (opts.fontScale) {
    await page.addInitScript((scale) => {
      localStorage.setItem('cchub-font-scale', String(scale));
    }, opts.fontScale);
  }
  await page.setViewportSize({ width: opts.width, height: opts.height });
  await page.goto('/harness.html?e2e=1');
  await page.waitForFunction(() => '__ccHarness' in window);

  const ids = await page.evaluate(
    ({ layout, sessions }) => {
      const h = (window as any).__ccHarness;
      h.setLayout(layout);
      const made: string[] = [];
      for (let i = 0; i < sessions; i++) made.push(h.addSession());
      h.setLayout(layout); // re-assert after adds so every pane lands in the mode
      return made as string[];
    },
    { layout: opts.layout, sessions: opts.sessions },
  );
  // 同步 fit 每个终端到当前 pane 尺寸,绕开 relayout 的 rAF 时序,让测量确定性。
  await page.evaluate((all) => {
    const h = (window as any).__ccHarness;
    for (const id of all) h.fit(id);
  }, ids);
  await page.waitForTimeout(SETTLE_MS);
  return ids;
}

/** 写满整屏的满宽字符 + 一行中文宽字符:逼 .xterm-screen 占满 cols,若 fit 把 cols
 * 算大,screen 会比 body 宽 → overflowRight 暴增,这正是「字符越界」。 */
async function fillScreen(page: Page, id: string): Promise<void> {
  await page.evaluate((sid) => {
    const h = (window as any).__ccHarness;
    const term = (window as any).__cc_terminals?.[sid];
    const cols = term?.cols ?? 80;
    const rows = term?.rows ?? 24;
    let out = '\x1b[2J\x1b[H';
    for (let r = 0; r < rows; r++) {
      out += 'W'.repeat(cols) + (r < rows - 1 ? '\r\n' : '');
    }
    h.write(sid, out);
    // 再压一行中文宽字符(每个占 2 cell),确认宽字符不破坏行宽。
    h.write(sid, '\x1b[H' + '中文宽字符测试'.repeat(40));
  }, id);
  await page.waitForTimeout(SETTLE_MS);
}

/** 测量一个 pane 的渲染几何。selector 限定到具体 pane,多 pane(grid)时逐个测。 */
async function measurePane(page: Page, paneIndex: number): Promise<PaneMetrics> {
  return page.evaluate((idx) => {
    const panes = [...document.querySelectorAll('#terminal-container .term-pane')]
      .filter((p) => (p as HTMLElement).style.visibility !== 'hidden');
    const pane = panes[idx] as HTMLElement;
    const body = pane.querySelector('.pane-body') as HTMLElement;
    const screen = pane.querySelector('.xterm-screen') as HTMLElement;
    const viewport = pane.querySelector('.xterm-viewport') as HTMLElement;

    const bodyRect = body.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();

    // __cc_terminals 暴露的是 term 实例(harness/e2eHooks 注入)。
    const allTerms = (window as any).__cc_terminals ?? {};
    const term = Object.values(allTerms).find((t: any) => {
      // 匹配到本 pane 的 term:用 element 包含关系。
      return pane.contains((t as any)?.element ?? null);
    }) as any;
    const cols = term?.cols ?? 0;
    const rows = term?.rows ?? 0;

    // cell 尺寸取自权威来源:.xterm-screen 被 xterm 精确撑成 cols×cellW / rows×cellH,
    // 故 cellW = screenWidth/cols。比读 .xterm-char-measure-element 内部元素更可靠
    // (后者宽度含内部测量伪影,实测约 2× 偏差)。getBoundingClientRect 返回未被父级
    // overflow 裁剪的真实边框,所以 screen 越界时该值仍如实反映,正是越界检测所需。
    const cellW = cols > 0 ? screenRect.width / cols : 8;
    const cellH = rows > 0 ? screenRect.height / rows : 17;

    return {
      cols,
      rows,
      cellW,
      cellH,
      bodyW: bodyRect.width,
      bodyH: bodyRect.height,
      overflowRight: screenRect.right - bodyRect.right,
      overflowBottom: screenRect.bottom - bodyRect.bottom,
      scrollHeight: viewport.scrollHeight,
      clientHeight: viewport.clientHeight,
      canScroll: viewport.scrollHeight > viewport.clientHeight + 1,
      scrolledTo: 0,
      fitCols: Math.floor(bodyRect.width / cellW),
      fitRows: Math.floor(bodyRect.height / cellH),
    };
  }, paneIndex);
}

/** 四类断言合一,供每个矩阵 case 复用。`tag` 用于失败定位。 */
function assertHealthy(m: PaneMetrics, tag: string): void {
  // 排版错乱:终端必须有正的行列,且容器够容下至少最小可用网格。
  expect(m.cols, `${tag} cols>0`).toBeGreaterThan(0);
  expect(m.rows, `${tag} rows>0`).toBeGreaterThan(0);

  // 字符越界:.xterm-screen 不得溢出 pane-body(留 2px subpixel 容差)。
  expect(m.overflowRight, `${tag} 右越界`).toBeLessThanOrEqual(2);
  expect(m.overflowBottom, `${tag} 下越界`).toBeLessThanOrEqual(2);

  // 排版一致:PTY cols/rows 应与 body 实际可容纳 cell 数吻合(±2 取整容差)。
  // 偏差大说明 fit 与渲染脱节 —— 即「排版错乱」的根因。
  expect(Math.abs(m.cols - m.fitCols), `${tag} cols 与容器不符 (${m.cols} vs ${m.fitCols})`).toBeLessThanOrEqual(2);
  expect(Math.abs(m.rows - m.fitRows), `${tag} rows 与容器不符 (${m.rows} vs ${m.fitRows})`).toBeLessThanOrEqual(2);
}

// --- 矩阵 1:整容器(tabs)在各典型尺寸下不越界、排版一致 ----------------------
const TABS_SIZES = [
  { w: 1920, h: 1080 },
  { w: 1366, h: 768 },
  { w: 1280, h: 800 },
  { w: 1024, h: 768 },
  { w: 800, h: 600 },
];

for (const s of TABS_SIZES) {
  test(`tabs ${s.w}x${s.h}: 单终端填满屏不越界、排版一致`, async ({ page }) => {
    const [id] = await boot(page, { width: s.w, height: s.h, layout: 'tabs', sessions: 1 });
    await fillScreen(page, id);
    const m = await measurePane(page, 0);
    assertHealthy(m, `tabs ${s.w}x${s.h}`);
  });
}

// --- 矩阵 2:grid 模式被压小的单 pane(高发区)------------------------------
// cols-3 下单 pane ≈ (容器宽 - padding - 2*gap)/3,再减 border/pane-head。
const GRID_CASES = [
  { w: 1280, h: 800, layout: 'cols-3' as LayoutMode, sessions: 3 }, // 单 pane ~416w
  { w: 980, h: 720, layout: 'cols-3' as LayoutMode, sessions: 3 },  // 单 pane ~316w
  { w: 720, h: 600, layout: 'cols-3' as LayoutMode, sessions: 3 },  // 窄屏 media,单 pane ~230w
  { w: 1280, h: 800, layout: 'cols-2' as LayoutMode, sessions: 2 }, // 单 pane ~628w
  { w: 1024, h: 768, layout: 'cols-2' as LayoutMode, sessions: 4 }, // 2 列 2 行
];

for (const c of GRID_CASES) {
  test(`${c.layout} ${c.w}x${c.h} (${c.sessions}会话): 每个小 pane 都不越界、排版一致`, async ({ page }) => {
    const ids = await boot(page, { width: c.w, height: c.h, layout: c.layout, sessions: c.sessions });
    for (const id of ids) await fillScreen(page, id);
    // grid 下每个 pane 都可见,逐个测 —— 被压小的 pane 才是 bug 高发处。
    for (let i = 0; i < ids.length; i++) {
      const m = await measurePane(page, i);
      assertHealthy(m, `${c.layout} ${c.w}x${c.h} pane#${i}`);
    }
  });
}

// --- 矩阵 3:超小视口极限,把单 pane 逼到临界 -------------------------------
const EXTREME_CASES = [
  { w: 800, h: 600, layout: 'cols-3' as LayoutMode, sessions: 3 },
  { w: 640, h: 480, layout: 'cols-3' as LayoutMode, sessions: 3 },
  { w: 640, h: 480, layout: 'cols-2' as LayoutMode, sessions: 2 },
];

for (const c of EXTREME_CASES) {
  test(`极限 ${c.layout} ${c.w}x${c.h}: 极小 pane 仍不越界`, async ({ page }) => {
    const ids = await boot(page, { width: c.w, height: c.h, layout: c.layout, sessions: c.sessions });
    for (const id of ids) await fillScreen(page, id);
    for (let i = 0; i < ids.length; i++) {
      const m = await measurePane(page, i);
      // 极限尺寸只硬保「不越界 + 行列为正」,容器可容 cell 数极少时 ±2 容差仍适用。
      expect(m.cols, `极限 pane#${i} cols>0`).toBeGreaterThan(0);
      expect(m.rows, `极限 pane#${i} rows>0`).toBeGreaterThan(0);
      expect(m.overflowRight, `极限 pane#${i} 右越界`).toBeLessThanOrEqual(2);
      expect(m.overflowBottom, `极限 pane#${i} 下越界`).toBeLessThanOrEqual(2);
    }
  });
}

// --- 矩阵 4:字号放大(125%)在大小布局下都不越界 ---------------------------
const FONT_CASES = [
  { w: 1280, h: 800, layout: 'tabs' as LayoutMode, sessions: 1, scale: 125 },
  { w: 1280, h: 800, layout: 'cols-3' as LayoutMode, sessions: 3, scale: 125 },
];

for (const c of FONT_CASES) {
  test(`字号${c.scale}% ${c.layout} ${c.w}x${c.h}: 放大后不越界、排版一致`, async ({ page }) => {
    const ids = await boot(page, { width: c.w, height: c.h, layout: c.layout, sessions: c.sessions, fontScale: c.scale });
    for (const id of ids) await fillScreen(page, id);
    for (let i = 0; i < ids.length; i++) {
      const m = await measurePane(page, i);
      assertHealthy(m, `字号${c.scale}% ${c.layout} pane#${i}`);
    }
  });
}

// --- 矩阵 5:可滚动性 —— normal buffer 灌多屏后视口必须能滚 ------------------
test('滚动:normal buffer 灌 200 行后视口可滚且 scrollTop 可变', async ({ page }) => {
  const [id] = await boot(page, { width: 1280, height: 800, layout: 'tabs', sessions: 1 });
  await page.evaluate((sid) => (window as any).__ccHarness.fillScrollback(sid, 200), id);
  await page.waitForTimeout(SETTLE_MS);

  const before = await measurePane(page, 0);
  expect(before.canScroll, '灌满后应可滚动').toBe(true);

  // scrollTop 可被改变(滚到顶再读),证明视口真的能滚而非被钉死。
  const moved = await page.evaluate(() => {
    const vp = document.querySelector('#terminal-container .term-pane .xterm-viewport') as HTMLElement;
    vp.scrollTop = 0;
    const top = vp.scrollTop;
    vp.scrollTop = vp.scrollHeight;
    return { top, bottom: vp.scrollTop };
  });
  expect(moved.bottom, 'scrollTop 应能向下移动').toBeGreaterThan(moved.top);
});

// --- 矩阵 6:measureSize 探测盒 与 真实 pane 同盒 -----------------------------
// bug 复现:probe 若用 `absolute; inset:0`,撑到 #terminal-container 的 padding-box
// (含 8px padding),而真实 .term-pane 是 grid item,只占 content-box —— probe 宽出
// 16px ≈ 2 cols。结果 session.create 用 132 起 PTY,fit.fit 落回 130,cc 第一屏按
// 132 列 wrap 后塞进 130 列视图,视觉上"cc 内容 wrap 在比可见终端更窄的列"。
// 零容差,直接锁死"probe 与 pane 占同一盒"这个不变量;assertHealthy 的 ±2 容差
// 恰好会掩盖此 bug,所以必须独立断言。
test('measureSize:probe 与真实 pane 同盒,cols/rows 严格一致', async ({ page }) => {
  const [id] = await boot(page, { width: 1440, height: 800, layout: 'tabs', sessions: 1 });
  const real = await page.evaluate((sid) => {
    const term = (window as any).__cc_terminals?.[sid];
    return { cols: term?.cols ?? 0, rows: term?.rows ?? 0 };
  }, id);
  const predicted = await page.evaluate(() => (window as any).__ccHarness.measure());
  expect(real.cols, 'sanity: 真实 pane 有可用 cols').toBeGreaterThan(0);
  expect(real.rows, 'sanity: 真实 pane 有可用 rows').toBeGreaterThan(0);
  expect(predicted.cols, 'probe cols 必须等于真实 pane cols,否则 session.create 会用错列数,首屏 wrap 错位').toBe(real.cols);
  expect(predicted.rows, 'probe rows 必须等于真实 pane rows,否则 session.create 会用错行数,首屏截断').toBe(real.rows);
});

// --- 矩阵 6.5:cols-* grid 下 measureSize 也必须等于真实 pane ------------------
// bug 复现:grid 模式下 `.pane-head` (dot + name + close) 显示,占约 33px + 1px
// border,但历史 bare-div probe 没这个 head/body 结构,只测到整个 grid cell 的高度,
// 因此 rows 过估 ~2。session.create 用 rows=36 起 claude,PTY 也 36。claude 用绝对
// 光标位置 (\x1b[Y;XH) 画底部输入区 (border/❯/border/bypass),xterm 只有 34 行,
// cursor >= 34 全被 clamp 到 row 33,几行 UI 挤在同一行,视觉上底部出现
// `──⏵⏵ bypass permissions ... · …─` 这样的 compound row。tabs 下 head display:none
// 撞不到,所以矩阵 6 抓不出;必须独立断言 grid 模式。
test('measureSize:cols-2 grid 下 probe 必须减去 pane-head 的高度', async ({ page }) => {
  const [id] = await boot(page, { width: 1440, height: 800, layout: 'cols-2', sessions: 1 });
  const real = await page.evaluate((sid) => {
    const term = (window as any).__cc_terminals?.[sid];
    return { cols: term?.cols ?? 0, rows: term?.rows ?? 0 };
  }, id);
  const predicted = await page.evaluate(() => (window as any).__ccHarness.measure());
  expect(real.rows, 'sanity: 真实 pane 有可用 rows').toBeGreaterThan(0);
  expect(predicted.cols, 'grid probe cols 必须等于真实 pane cols').toBe(real.cols);
  expect(predicted.rows, 'grid probe rows 必须等于真实 pane rows,否则 claude 会画到 xterm 边界外 → 底部行 compound').toBe(real.rows);
});

// --- 矩阵 7a:sticky fit —— spurious ±1 抖动不触发 term.resize ---------------
// 回归 debug-screenshot/layout.png 的"字符右边缘 + 下一行掐头"排版 bug。根因:
// cell.width 是浮点(Consolas 14px ≈ 8.408),parent pane 的 sub-pixel 抖动(字体
// fallback 加载完、grid track rounding、滚动条宽度重算)让 fit.propose 结果时不时
// 抖 ±1 列。每次 term.resize 都发一条 resize WS msg;cc 的 conpty 只有等消息到达
// 才应用新 cols,间隔里 cc 按旧 cols 出的字节到达客户端已经 reflow 到新 cols,
// 视觉上就是 1 字符掐尾。fit sticky 只在 ≤1 差且 rows 不变时压掉抖动。
test('sticky fit:body 缩窄 4px(仅 -1 列)时 term.cols 不变;≥2 列差正常 resize', async ({ page }) => {
  const [id] = await boot(page, { width: 1280, height: 800, layout: 'tabs', sessions: 1 });
  const beforeCols = await page.evaluate((sid) => (window as any).__cc_terminals?.[sid]?.cols, id);
  expect(beforeCols).toBeGreaterThan(20);

  // 缩窄 body 4px:cell 宽 ~8.4,~4px 差恰好让 propose 返回 beforeCols-1,不到 -2。
  // sticky 应压住,term.cols 保持不变。
  const spurious = await page.evaluate(({ sid, delta }) => {
    const term = (window as any).__cc_terminals?.[sid];
    const pane = document.querySelector('.pane-body') as HTMLElement;
    const savedWidth = pane.style.width;
    const savedMinWidth = pane.style.minWidth;
    pane.style.width = pane.getBoundingClientRect().width - delta + 'px';
    pane.style.minWidth = pane.getBoundingClientRect().width - delta + 'px';
    (window as any).__ccHarness.fit(sid);
    const after = term.cols;
    pane.style.width = savedWidth;
    pane.style.minWidth = savedMinWidth;
    (window as any).__ccHarness.fit(sid);
    return after;
  }, { sid: id, delta: 4 });
  expect(spurious, 'body 缩窄 4px(propose -1 col)应被 sticky 压掉').toBe(beforeCols);

  // 缩窄 80px:propose 会掉 ~9 列,超阈值,必须真 resize。
  const real = await page.evaluate(({ sid, delta }) => {
    const term = (window as any).__cc_terminals?.[sid];
    const pane = document.querySelector('.pane-body') as HTMLElement;
    pane.style.width = pane.getBoundingClientRect().width - delta + 'px';
    pane.style.minWidth = pane.getBoundingClientRect().width - delta + 'px';
    (window as any).__ccHarness.fit(sid);
    return term.cols;
  }, { sid: id, delta: 80 });
  expect(real, 'body 缩窄 80px(propose -9 col)应真 resize').toBeLessThan(beforeCols - 5);
});

// --- 矩阵 7:resize 后重排不越界 —— 模拟窗口缩放/布局切换的真实路径 -----------
test('resize:tabs 大→小再切 cols-3,每次重排后都不越界', async ({ page }) => {
  const ids = await boot(page, { width: 1600, height: 900, layout: 'tabs', sessions: 3 });
  for (const id of ids) await fillScreen(page, id);

  // 缩小视口 + 同步重排
  await page.setViewportSize({ width: 900, height: 600 });
  await page.evaluate((all) => { for (const id of all) (window as any).__ccHarness.fit(id); }, ids);
  await page.waitForTimeout(SETTLE_MS);
  let m = await measurePane(page, 0);
  assertHealthy(m, 'resize tabs 缩小后');

  // 切到 cols-3:三个 pane 同框,逐个查
  await page.evaluate((all) => {
    const h = (window as any).__ccHarness;
    h.setLayout('cols-3');
    for (const id of all) h.fit(id);
  }, ids);
  await page.waitForTimeout(SETTLE_MS);
  for (let i = 0; i < ids.length; i++) {
    m = await measurePane(page, i);
    assertHealthy(m, `resize→cols-3 pane#${i}`);
  }
});
