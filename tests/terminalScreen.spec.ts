import { test, expect } from '@playwright/test';
import { TerminalScreen } from '../src/server/infrastructure/terminal/terminalScreen.js';

function writeAll(screen: TerminalScreen, chunks: string[]): Promise<void> {
  return new Promise(resolve => {
    let pending = chunks.length;
    if (pending === 0) return resolve();
    for (const chunk of chunks) {
      screen.write(chunk, () => {
        pending -= 1;
        if (pending === 0) resolve();
      });
    }
  });
}

test.describe('TerminalScreen.snapshot', () => {
  test('回送 scrollback 行（lines.length > rows）', async () => {
    const screen = new TerminalScreen(80, 5);
    const chunks: string[] = [];
    for (let i = 1; i <= 12; i += 1) chunks.push(`line-${i}\r\n`);
    await writeAll(screen, chunks);
    const snap = screen.snapshot();
    expect(snap.lines.length).toBeGreaterThanOrEqual(12);
    expect(snap.lines[0]).toBe('line-1');
    expect(snap.lines).toContain('line-12');
  });

  test('cursorY 为 buffer 全局行号', async () => {
    const screen = new TerminalScreen(80, 5);
    const chunks: string[] = [];
    for (let i = 1; i <= 12; i += 1) chunks.push(`line-${i}\r\n`);
    await writeAll(screen, chunks);
    const snap = screen.snapshot();
    // 写完 12 行后游标在第 13 行（0-based: 12）的列 0
    expect(snap.cursorY).toBe(12);
    expect(snap.cursorX).toBe(0);
  });

  test('剥离 C0/C1 控制字符残骸', async () => {
    const screen = new TerminalScreen(80, 10);
    // 这些是 cmd.exe 启动时常见的非标准 ANSI 残骸（去掉 ESC 让 xterm 不消费它们）
    await writeAll(screen, ['\x01\x02hello\x07world\x7f\r\n']);
    const snap = screen.snapshot();
    expect(snap.lines.some(line => /[\x00-\x08\x0B-\x1F\x7F-\x9F]/.test(line))).toBe(false);
    expect(snap.lines.some(line => line.includes('helloworld'))).toBe(true);
  });

  test('snapshot.rows 跟随 viewport 大小，与 lines.length 解耦', async () => {
    const screen = new TerminalScreen(80, 8);
    const chunks: string[] = [];
    for (let i = 1; i <= 30; i += 1) chunks.push(`row-${i}\r\n`);
    await writeAll(screen, chunks);
    const snap = screen.snapshot();
    // viewport 是 8 行；lines.length 应远大于 rows，证明 scrollback 也被序列化了
    expect(snap.rows).toBe(8);
    expect(snap.lines.length).toBeGreaterThan(snap.rows);
  });

  // Refresh-scroll bug: cc runs in alt-screen (`\x1b[?1049h`) and forwards
  // wheel events to itself via mouse tracking (`\x1b[?1000h;1006h`). On
  // reattach the client re-inits xterm from scratch and replays only the
  // rendered text — the DEC private modes cc set at startup are gone, so
  // xterm stays in main-screen with mouse tracking off, wheel goes to the
  // empty local scrollback, and the whole terminal looks "frozen: won't
  // scroll". Fix: track private modes as data is written, and put a
  // ready-to-write restore sequence in the snapshot so the client can
  // re-enter cc's mode state before replaying the buffer text.

  test('捕获 DEC private mode set,snapshot.modeSetup 里带出恢复序列', async () => {
    const screen = new TerminalScreen(80, 24);
    // cc 启动的典型序列:alt-screen + SGR mouse tracking + bracketed paste
    await writeAll(screen, ['\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?2004h']);
    const snap = screen.snapshot();
    expect(snap.modeSetup).toBeTruthy();
    // Every mode cc turned on must show up — the client will just
    // term.write(modeSetup) so it needs to be a self-contained CSI sequence.
    for (const n of [1049, 1000, 1006, 2004]) {
      expect(snap.modeSetup).toContain(String(n));
    }
    expect(snap.modeSetup).toMatch(/\x1b\[\?[\d;]+h/);
  });

  test('mode 被 reset(?..l)后不再出现在 modeSetup 中', async () => {
    const screen = new TerminalScreen(80, 24);
    await writeAll(screen, ['\x1b[?1000h']);
    await writeAll(screen, ['\x1b[?1000l']);
    const snap = screen.snapshot();
    // A restore sequence for mode 1000 would be `?1000h` — but since it's
    // currently disabled, it must not appear in the setup blob. (A `?1000l`
    // is redundant because the client's fresh xterm defaults to off, so
    // reset sequences are also skipped.)
    expect(snap.modeSetup).not.toMatch(/1000h/);
  });

  test('多 mode 一起 set(?N;M;...h)全部纳入 modeSetup', async () => {
    const screen = new TerminalScreen(80, 24);
    await writeAll(screen, ['\x1b[?1000;1002;1006h']);
    const snap = screen.snapshot();
    for (const n of [1000, 1002, 1006]) {
      expect(snap.modeSetup).toContain(String(n));
    }
  });

  test('未设过任何 private mode 时 modeSetup 为空串', async () => {
    const screen = new TerminalScreen(80, 24);
    await writeAll(screen, ['plain text\r\n']);
    const snap = screen.snapshot();
    expect(snap.modeSetup).toBe('');
  });

  test('超大 scrollback 被截到客户端上限（取尾部 5000 行），游标行号随之 rebase', async () => {
    const screen = new TerminalScreen(80, 24, 64 * 1024);
    const chunks: string[] = [];
    const totalLines = 6000; // 超过 5000 上限
    for (let i = 1; i <= totalLines; i += 1) chunks.push(`L${i}\r\n`);
    await writeAll(screen, chunks);
    const snap = screen.snapshot();
    // 截到上限：不会回送全部 6000 行
    expect(snap.lines.length).toBeLessThanOrEqual(5000);
    // 保留的是尾部，最早的行已被丢弃
    expect(snap.lines).toContain(`L${totalLines}`);
    expect(snap.lines).not.toContain('L1');
    // 游标行号 rebase 到窗口内（不再是 6000 这种全局绝对行号）
    expect(snap.cursorY).toBeGreaterThanOrEqual(0);
    expect(snap.cursorY).toBeLessThanOrEqual(snap.lines.length);
  });
});
