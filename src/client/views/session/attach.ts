import type { SessionInfo } from '../../../shared/protocol.js';
import type { AppDeps } from '../../deps.js';
import { attachTerminal, applyLayout, placeTerminal, updatePaneHead, reportedRows } from '../terminal.js';
import { isGridLayout, type LayoutMode } from '../layout.js';
import { sessionLabel, sessionTooltip } from '../sessionLabel.js';
import { exposeTerminal, unexposeTerminal } from './e2eHooks.js';
import { attachImageLinks } from '../imageLinks.js';
import { openImagePreview, showImageUnsupported } from '../imagePreview.js';
import { attachImagePaste } from '../imagePaste.js';
import { attachDragReorder } from '../paneReorder.js';
import { revealForSession } from '../revealFor.js';

export interface AttachController {
  addSession(info: SessionInfo): void;
  removeSession(id: string): void;
  activate(id: string, sendAttach?: boolean): void;
  setLayout(mode: LayoutMode): void;
}

/** Owns terminal DOM lifecycle, the active-id state machine, and the layout
 * (single visible terminal vs. multi-pane grid). */
export function makeAttachController(deps: AppDeps): AttachController {
  // Per-session disposables (link provider, etc.). Keyed by session id so
  // removeSession can dispose them when the pane goes away.
  const sessionDisposers = new Map<string, () => void>();

  function addSession(info: SessionInfo): void {
    if (deps.store.get().sessions.has(info.id)) return;
    const { pane, body, terminal } = attachTerminal(deps.container, {
      onInput: (data) => {
        deps.bus.emit('session:interacted', info.id);
        deps.conn.send({ type: 'input', id: info.id, data });
      },
      onResize: (cols, rows) => deps.conn.send({ type: 'resize', id: info.id, cols, rows: reportedRows(rows) }),
      // A click/focus inside any pane moves the active ring to it. In tabs mode
      // only the active pane takes pointer events so this is a no-op there; in a
      // grid every pane is live, so this is what makes focus follow the cursor.
      onFocus: () => activate(info.id),
      onClose: () => deps.conn.send({ type: 'session.destroy', id: info.id }),
    });
    // Make every `[Image #N]` chip in this pane's xterm buffer clickable. The
    // link provider lives for the lifetime of the session and is disposed in
    // removeSession before the terminal itself is disposed.
    const imageLinks = attachImageLinks(terminal.term, info.id, {
      open: openImagePreview,
      unsupported: showImageUnsupported,
    });
    // Image-on-clipboard pastes — upload bytes to the server, which lands them
    // on disk and feeds them into the PTY via the same path as the MCP tool.
    const imagePaste = attachImagePaste(terminal.term, info.id);
    sessionDisposers.set(info.id, () => { imageLinks.dispose(); imagePaste(); });
    // Stamp the session id on the pane so the reorder-drag handler can identify
    // which session the user grabbed.
    pane.dataset.sessionId = info.id;
    deps.store.addSession(info.id, { info, pane, body, terminal, attached: false });
    exposeTerminal(info.id, terminal);
    relayout();
  }

  function removeSession(id: string): void {
    const wasActive = deps.store.get().activeId === id;
    const removed = deps.store.removeSession(id);
    if (!removed) return;
    sessionDisposers.get(id)?.();
    sessionDisposers.delete(id);
    removed.terminal.dispose();
    removed.pane.remove();
    unexposeTerminal(id);
    if (wasActive) {
      const next = deps.store.get().sessions.keys().next().value;
      if (next) { activate(next); return; }
    }
    relayout();
  }

  /** Fire the reveal menu for a session. Local sessions get 6 targets (files
   * / VS Code / cmd / cmd admin / PowerShell / PowerShell admin); SSH gets 3
   * (XShell / XFTP / VS Code Remote-SSH). See revealFor.ts. Both the pane
   * head and the rail chip wire to this helper so the two entry points render
   * the same menu. */
  function revealFor(info: SessionInfo, anchor: HTMLElement): void {
    revealForSession(deps, info, anchor);
  }

  /** Render every terminal for the current layout, then fit the ones now on
   * screen. In a grid that's all of them; in tabs mode just the active one.
   * `fit` is skipped on a pure focus switch (no cell sizes changed) to avoid a
   * needless reflow of every pane on every click. */
  function relayout(opts: { fit?: boolean } = {}): void {
    const fit = opts.fit ?? true;
    const { sessions, activeId, ui } = deps.store.get();
    const mode = ui.layoutMode;
    applyLayout(deps.container, mode);
    const grid = isGridLayout(mode);
    for (const [sid, s] of sessions) {
      const active = sid === activeId;
      const label = sessionLabel(s.info);
      placeTerminal(s.pane, {
        mode,
        active,
        label,
        state: s.info.state,
        tooltip: sessionTooltip(s.info, label),
        info: s.info,
        onReveal: (anchor) => revealFor(s.info, anchor),
      });
      if (fit && (grid || active)) requestAnimationFrame(() => s.terminal.fit.fit());
    }
  }

  function activate(id: string, sendAttach = true): void {
    const state = deps.store.get();
    if (state.activeId === id) {
      // Already active: only (re)assert focus + server attach if asked, but
      // never re-fit/relayout — prevents the focus listener from looping.
      if (sendAttach) {
        const s = state.sessions.get(id);
        deps.conn.send({ type: 'session.attach', id, focus: true, history: !s?.attached });
      }
      return;
    }
    deps.store.set('activeId', id);
    // Cell sizes don't change when only the active pane changes, so skip the
    // fit; just restyle panes (ring + visibility).
    relayout({ fit: false });
    const session = deps.store.get().sessions.get(id);
    if (session) {
      requestAnimationFrame(() => session.terminal.term.focus());
    }
    if (sendAttach) deps.conn.send({ type: 'session.attach', id, focus: true, history: !session?.attached });
  }

  function setLayout(mode: LayoutMode): void {
    if (deps.store.get().ui.layoutMode === mode) return;
    deps.store.patchUi({ layoutMode: mode });
    relayout();
  }

  // Drag-to-reorder is a container-level listener. Disabled in tabs mode
  // because the pane heads are display:none there; the rail carries the
  // draggable identity in that mode instead (see rail.ts). Commits go through
  // the store, which then ripples out to the DOM through the subscribe below.
  attachDragReorder(deps.container, {
    itemSelector: '.term-pane',
    handleSelector: '.pane-head',
    // `.reveal-cwd` is a nested link inside `.pane-name`. Same reason as
    // `.tab-close`: without ignoring it, setPointerCapture on `.pane-head`
    // reroutes the click to the pane head, so the link's reveal never fires.
    ignoreSelector: '.pane-close, .reveal-cwd',
    axis: 'x',
    bodyClass: 'dragging-pane',
    isEnabled: () => deps.store.get().ui.layoutMode !== 'tabs',
    reorder: (fromId, toIndex) => {
      deps.store.reorderSession(fromId, toIndex);
      // Persist to the server so the drag survives a page refresh — session.list
      // on reconnect echoes the new order back.
      deps.conn.send({ type: 'session.reorder', id: fromId, toIndex });
    },
  });

  // Keep every pane's head (live state dot + name) in sync with the store.
  // Output messages don't touch the store, so this only fires on real state /
  // label changes — not on terminal data — keeping it cheap.
  //
  // Also keep the DOM order matched to the Map iteration order: reorderSession
  // replaces the Map with a new key order, and grid auto-flow then places
  // panes by DOM order. If the current DOM order already matches, insertBefore
  // is a no-op at the browser level.
  deps.store.subscribe((s) => {
    let prevPane: HTMLElement | null = null;
    for (const [id, session] of s.sessions) {
      const label = sessionLabel(session.info);
      updatePaneHead(session.pane, {
        state: session.info.state,
        label,
        tooltip: sessionTooltip(session.info, label),
        info: session.info,
        onReveal: (anchor) => revealFor(session.info, anchor),
      });
      session.pane.classList.toggle('is-active', id === s.activeId);
      const expectedPrevSibling = prevPane;
      if (session.pane.previousElementSibling !== expectedPrevSibling) {
        const anchor = expectedPrevSibling ? expectedPrevSibling.nextSibling : deps.container.firstChild;
        deps.container.insertBefore(session.pane, anchor);
      }
      prevPane = session.pane;
    }
  });

  return { addSession, removeSession, activate, setLayout };
}
