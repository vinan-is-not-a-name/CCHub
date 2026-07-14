import '@xterm/xterm/css/xterm.css';
import { Bus } from './bus.js';
import { createStore } from './state.js';
import { makeAttachController } from './views/session/attach.js';
import { mountRail } from './views/rail.js';
import { measureSize } from './views/terminal.js';
import { mountNotifications, type NotifyKind } from './views/notify.js';
import type { AppDeps } from './deps.js';
import type { SessionInfo, SessionState, SessionTarget } from '../shared/protocol.js';
import type { LayoutMode } from './views/layout.js';

/**
 * Test-only rendering harness. It mounts the REAL terminal container against
 * the REAL attach controller (makeAttachController → attachTerminal → relayout
 * → placeTerminal) backed by a no-op transport, so the rendering test suite
 * drives the exact production render path with synthetic data — no server, no
 * WebSocket, no live claude. Gated on `?e2e=1` exactly like e2eHooks, so the
 * page is inert (and __ccHarness absent) for anyone who stumbles onto it.
 *
 * This adds NO new rendering logic: every pixel is produced by the same code
 * the app ships. The harness only supplies stub deps and a thin driver API.
 */
const E2E = new URLSearchParams(location.search).get('e2e') === '1';

if (E2E) {
  const container = document.getElementById('terminal-container')!;
  const store = createStore();
  const bus = new Bus();

  // No-op transport with a capture buffer so tests can assert what the
  // controller would have sent over WS (e.g. session.reorder after a drag).
  const sent: unknown[] = [];
  const conn = {
    send(msg: unknown) { sent.push(msg); },
    onMessage() {},
    onClose() {},
    connect() {},
  } as unknown as AppDeps['conn'];

  const deps: AppDeps = {
    conn,
    rpc: {} as AppDeps['rpc'],
    store,
    bus,
    container,
  };

  const attach = makeAttachController(deps);
  // The rail (session tabs on the left) is real production DOM in harness too,
  // so drag-to-reorder on tabs is testable end-to-end.
  mountRail(deps);
  // Mount the production notification delivery path so browser tests can drive
  // the same title-flash / Notification API behavior as hook WS messages.
  // Focus defaults to "not focused" so the delivery specs fire regardless of
  // the real browser focus state; setPageFocus() flips it to test suppression.
  let harnessHasFocus = false;
  const notify = mountNotifications(deps, { hasFocus: () => harnessHasFocus });
  // Rail's session:activate bus event needs a listener — real app wires this
  // in setupSessionActivation(), which we can't import from here without also
  // pulling WebSocket. Provide the minimal wire: forward to attach.activate.
  bus.on('session:activate', (id) => attach.activate(id, false));

  let seq = 0;
  function makeInfo(over: Partial<SessionInfo> = {}): SessionInfo {
    seq += 1;
    return {
      id: `harness-${seq}`,
      state: 'idle',
      cwd: 'D:/temp/harness',
      createdAt: Date.now(),
      target: 'local' as SessionTarget,
      label: `Session ${seq}`,
      ...over,
    };
  }

  const harness = {
    /** Create + activate a session through the real controller. Returns its id. */
    addSession(over?: Partial<SessionInfo>): string {
      const info = makeInfo(over);
      attach.addSession(info);
      attach.activate(info.id, false);
      return info.id;
    },
    setLayout(mode: LayoutMode): void {
      attach.setLayout(mode);
    },
    activate(id: string): void {
      attach.activate(id, false);
    },
    remove(id: string): void {
      attach.removeSession(id);
    },
    /** Write synthetic terminal data into a session's xterm. */
    write(id: string, data: string): void {
      store.get().sessions.get(id)?.terminal.write(data);
    },
    /** Write + wait for xterm's parser to flush. xterm's `term.write` queues
     * bytes and returns immediately — the parser runs on a microtask so a
     * spec that reads state right after write() sees the pre-parse snapshot.
     * The DECTCEM cursor-mode spec needs the post-parse view (theme.cursor
     * flipped), so it goes through this async form. */
    writeSync(id: string, data: string): Promise<void> {
      const term = store.get().sessions.get(id)?.terminal.term;
      if (!term) return Promise.resolve();
      return new Promise<void>((resolve) => term.write(data, resolve));
    },
    /** Introspect a session's live xterm theme + cursor-style options. The
     * DECTCEM detector in terminal.ts upgrades a session from Hidden to
     * Visible cursor mode when cc emits CSI ?25l/?25h; the paneReorder /
     * remoteCursor specs read this to assert the switch happened (or didn't). */
    cursorState(id: string): { cursor?: string; cursorAccent?: string; cursorInactiveStyle?: string } | null {
      const term = store.get().sessions.get(id)?.terminal.term;
      if (!term) return null;
      const theme = term.options.theme as { cursor?: string; cursorAccent?: string } | undefined;
      return {
        cursor: theme?.cursor,
        cursorAccent: theme?.cursorAccent,
        cursorInactiveStyle: term.options.cursorInactiveStyle as string | undefined,
      };
    },
    /** Route through the session terminal's setBaseTheme so we exercise the
     * exact production path topbar.ts uses when the user picks a new theme. */
    setBaseTheme(id: string, theme: unknown): void {
      store.get().sessions.get(id)?.terminal.setBaseTheme(theme);
    },
    /** Re-fit a session's terminal to its current container size (sync request). */
    fit(id: string): void {
      store.get().sessions.get(id)?.terminal.fit.fit();
    },
    /** Trigger the real loadSnapshot path (raw fit → reset → write) that the
     * message router runs on session.attached. Tests use this to reproduce the
     * initial-mount right-edge render defect where the raw fit inside
     * loadSnapshot bypasses the H_PAD-7 sticky logic and resizes cols wider
     * than the visible pane. Pass `null` to only run the fit+reset (no lines). */
    loadSnapshot(id: string, snapshot?: { cols?: number; rows?: number; cursorX?: number; cursorY?: number; lines?: string[]; modeSetup?: string } | null): void {
      const s = store.get().sessions.get(id);
      if (!s) return;
      const snap = {
        cols: snapshot?.cols ?? s.terminal.term.cols,
        rows: snapshot?.rows ?? s.terminal.term.rows,
        cursorX: snapshot?.cursorX ?? 0,
        cursorY: snapshot?.cursorY ?? 0,
        lines: snapshot?.lines ?? [''],
        modeSetup: snapshot?.modeSetup ?? '',
      };
      s.terminal.loadSnapshot(snap as never);
    },
    /** Run the exact probe measureSize() uses at session.create time. Returns
     * the cols/rows the server would be told to launch the PTY at. Test suite
     * uses this to catch drift between the probe's box and the real pane's box
     * (padding-box vs content-box) — a 2-col over-estimate that made cc wrap
     * its first paint narrower than the visible terminal. */
    measure(): { cols: number; rows: number } {
      return measureSize(container as HTMLElement);
    },
    /** Leave alt-screen, then push N lines into the normal buffer so the
     * viewport has real scrollback (claude itself runs in alt-screen, which has
     * none — this mirrors the e2e scroll test's setup). */
    fillScrollback(id: string, lines: number): void {
      const s = store.get().sessions.get(id);
      if (!s) return;
      s.terminal.write('\x1b[?1049l');
      let payload = '';
      for (let i = 0; i < lines; i++) payload += `scrollback line ${i}\r\n`;
      s.terminal.write(payload);
    },
    ids(): string[] {
      return [...store.get().sessions.keys()];
    },
    /** All messages the app has "sent" through the fake conn. Tests use this
     * to verify wiring (e.g. drag-reorder must send `session.reorder` so the
     * order survives a page refresh). */
    sent(): unknown[] {
      return sent.slice();
    },
    clearSent(): void {
      sent.length = 0;
    },
    /** Simulate the server pushing a state message. */
    setSessionState(id: string, state: SessionState): void {
      store.setSessionState(id, state);
    },
    /** Drive the production hook-notification delivery path. */
    fireNotify(id: string, kind: NotifyKind): void {
      notify.fire(id, kind);
    },
    /** Drive the focus predicate that gates notifications. Production reads
     * document.hasFocus(); the harness sets it explicitly so suppress-when-
     * focused is deterministic (Playwright page focus is unreliable). */
    setPageFocus(focused: boolean): void {
      harnessHasFocus = focused;
    },
  };

  (window as unknown as { __ccHarness?: typeof harness }).__ccHarness = harness;
}
