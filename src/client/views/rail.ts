import { el } from '../dom.js';
import type { AppDeps } from '../deps.js';
import type { ClientSession } from '../state.js';
import type { SessionInfo } from '../../shared/protocol.js';
import { sessionLabel, sessionTooltip, sessionShortName } from './sessionLabel.js';
import { attachDragReorder } from './paneReorder.js';
import { revealForSession } from './revealFor.js';
import { t, subscribeLocale } from '../i18n.js';

export function mountRail(deps: AppDeps) {
  const tabsEl = el('tabs');

  /** Same reveal dispatch as the grid pane heads — pops a menu anchored to
   * the clicked chip. Local sessions get 6 items (files / vscode / 4 shells),
   * SSH sessions get 3 (xshell / xftp / vscode remote). See revealFor.ts. */
  function revealFor(info: SessionInfo, anchor: HTMLElement): void {
    revealForSession(deps, info, anchor);
  }

  // Incremental render: reuse existing tab elements keyed by data-session-id
  // so drag-in-flight elements don't disappear under pointer capture. New ids
  // build a fresh tab; removed ids are pulled from the DOM; every render pass
  // ends by aligning DOM order with Map insertion order via insertBefore.
  function renderTabs() {
    const { sessions, activeId } = deps.store.get();
    const existing = new Map<string, HTMLElement>();
    for (const node of tabsEl.querySelectorAll<HTMLElement>('.tab')) {
      const id = node.dataset.sessionId;
      if (id) existing.set(id, node);
    }
    let prev: HTMLElement | null = null;
    const seen = new Set<string>();
    for (const [id, s] of sessions) {
      seen.add(id);
      let tab = existing.get(id);
      if (!tab) {
        tab = buildTab(id, s);
        existing.set(id, tab);
      }
      updateTab(tab, s, activeId === id);
      const expectedPrev = prev;
      if (tab.parentNode !== tabsEl || tab.previousElementSibling !== expectedPrev) {
        const anchor = expectedPrev ? expectedPrev.nextSibling : tabsEl.firstChild;
        tabsEl.insertBefore(tab, anchor);
      }
      prev = tab;
    }
    for (const [id, node] of existing) {
      if (!seen.has(id)) node.remove();
    }
  }

  function buildTab(id: string, s: ClientSession): HTMLElement {
    const tab = document.createElement('div');
    tab.dataset.sessionId = id;
    tab.role = 'button';
    tab.tabIndex = 0;

    const dot = document.createElement('span');
    dot.className = 'tab-state-dot';
    dot.setAttribute('aria-hidden', 'true');

    // Two-row label: primary "name" line + subordinate "meta" line
    // (target · cwd). Matches the mockup-I rail-item layout so the rail reads
    // as an editorial column of sessions rather than a strip of chips.
    const labelWrap = document.createElement('div');
    labelWrap.className = 'tab-label';

    const nameLine = document.createElement('div');
    nameLine.className = 'tab-name';

    const metaLine = document.createElement('div');
    metaLine.className = 'tab-meta';

    labelWrap.append(nameLine, metaLine);

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.type = 'button';
    close.textContent = '×';
    close.onclick = (event) => {
      event.stopPropagation();
      deps.conn.send({ type: 'session.destroy', id });
    };

    tab.append(dot, labelWrap, close);
    tab.onclick = () => deps.bus.emit('session:activate', id);
    tab.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        deps.bus.emit('session:activate', id);
      }
    };
    updateTab(tab, s, false);
    return tab;
  }

  function updateTab(tab: HTMLElement, s: ClientSession, active: boolean): void {
    const label = sessionLabel(s.info);
    tab.className = `tab ${active ? 'active' : ''} ${s.info.state} state-${s.info.state}`;
    tab.title = sessionTooltip(s.info, label);

    const nameLine = tab.querySelector<HTMLElement>('.tab-name');
    const metaLine = tab.querySelector<HTMLElement>('.tab-meta');
    if (nameLine) nameLine.textContent = sessionShortName(s.info);
    if (metaLine) renderMeta(metaLine, s.info, (anchor) => revealFor(s.info, anchor));

    const close = tab.querySelector<HTMLButtonElement>('.tab-close');
    if (close) {
      close.title = t('rail.close').replace('{name}', label);
      close.setAttribute('aria-label', t('rail.close').replace('{name}', label));
    }
  }

  /** The subordinate rail line: "target · cwd". target reads as the server
   * name for SSH sessions, "Local" for local ones. The cwd chunk is a
   * reveal-cwd anchor so clicking still opens the folder — same UX as the
   * inline reveal we used to render on the single-row label. */
  function renderMeta(el: HTMLElement, info: SessionInfo, onReveal: (anchor: HTMLElement) => void): void {
    el.textContent = '';
    const where = info.target === 'local'
      ? t('rail.local')
      : (info.serverName || info.target);
    el.appendChild(document.createTextNode(`${where} · `));

    const link = document.createElement('a');
    link.className = 'reveal-cwd';
    link.href = '#';
    link.textContent = info.cwd;
    link.title = info.target === 'local'
      ? t('rail.reveal.local').replace('{cwd}', info.cwd)
      : t('rail.reveal.remote').replace('{cwd}', info.cwd);
    // Kill the browser's native HTML5 link-drag so the pane-head drag-reorder
    // handler keeps seeing pointermove events after pointerdown. Same rule as
    // the inline reveal-cwd rendering in sessionLabel.ts.
    link.draggable = false;
    link.addEventListener('dragstart', (event) => event.preventDefault());
    link.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onReveal(link);
    });
    el.appendChild(link);
  }

  // Drag-to-reorder for the rail. Always enabled — works in tabs mode (where
  // the rail is the only session-order UI) and grid modes (where the rail is
  // collapsed but the chips are still there). Both routes commit through the
  // same Store.reorderSession, so pane order and tab order stay locked.
  attachDragReorder(tabsEl, {
    itemSelector: '.tab',
    handleSelector: '.tab',
    // `.reveal-cwd` is a nested link inside `.tab-meta`. Without ignoring it,
    // pointerdown on the link starts drag tracking on `.tab` and setPointerCapture
    // reroutes the subsequent click to `.tab` instead of the link — so the reveal
    // never fires. Same rationale as `.tab-close`.
    ignoreSelector: '.tab-close, .reveal-cwd',
    axis: 'y',
    bodyClass: 'dragging-tab',
    reorder: (fromId, toIndex) => {
      deps.store.reorderSession(fromId, toIndex);
      // Persist to the server, same as the grid pane-heads path — so the rail
      // drag also survives a page refresh.
      deps.conn.send({ type: 'session.reorder', id: fromId, toIndex });
    },
  });

  deps.store.subscribe(renderTabs);
  subscribeLocale(renderTabs);
  renderTabs();
}
