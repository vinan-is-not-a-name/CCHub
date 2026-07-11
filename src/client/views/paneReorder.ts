// Drag-to-reorder for a list of items in a container. Two callers:
//   - grid pane reorder (horizontal auto-flow across the terminal container)
//   - rail tab reorder (vertical stack in the sessions rail)
//
// Purely reorders items in Map / DOM order — no size or layout math. See
// [[layout]] for the sibling mode enum.

/** Minimal rect shape used by computeDropIndex — matches DOMRect for the
 * fields we consume, so callers can pass el.getBoundingClientRect() directly. */
export interface PaneRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PaneRectEntry {
  id: string;
  rect: PaneRect;
}

/**
 * Where the dragged item should land, given all item rects at drag-end and the
 * mouse position. Returns the target index in the _post-remove_ array so the
 * caller can pass it directly to `Store.reorderSession`.
 *
 * Rules:
 *  1. Find the item whose rect contains (mouseX, mouseY). If none contains,
 *     use the item whose center is closest (Euclidean).
 *  2. If the target is the source itself, return the source index (no-op).
 *  3. If the mouse is on the "leading" side of the target center (x < centerX
 *     for horizontal, y < centerY for vertical) → insert before the target
 *     (insertAt = targetIndex). Else → insert after (insertAt = targetIndex + 1).
 *  4. Normalize: after removing the source, indices > fromIndex shift left by
 *     one, so if insertAt > fromIndex, subtract 1.
 *  5. Clamp to [0, panes.length - 1].
 *
 * `axis` picks which coordinate governs the "leading side" test — `x` for a
 * row-oriented layout (grid panes), `y` for a column-oriented layout (rail
 * tabs). Hit-testing in step 1 always uses both X and Y so multi-row grids
 * still resolve to the correct row.
 */
export function computeDropIndex(
  panes: PaneRectEntry[],
  fromIndex: number,
  mouseX: number,
  mouseY: number,
  axis: 'x' | 'y' = 'x',
): number {
  if (panes.length <= 1) return fromIndex;

  let targetIndex = -1;
  for (let i = 0; i < panes.length; i++) {
    const r = panes[i]!.rect;
    if (mouseX >= r.left && mouseX < r.right && mouseY >= r.top && mouseY < r.bottom) {
      targetIndex = i;
      break;
    }
  }

  if (targetIndex < 0) {
    let bestDist = Infinity;
    for (let i = 0; i < panes.length; i++) {
      const r = panes[i]!.rect;
      const cx = (r.left + r.right) / 2;
      const cy = (r.top + r.bottom) / 2;
      const dx = mouseX - cx;
      const dy = mouseY - cy;
      const d = dx * dx + dy * dy;
      if (d < bestDist) { bestDist = d; targetIndex = i; }
    }
  }

  if (targetIndex === fromIndex) return fromIndex;

  const targetRect = panes[targetIndex]!.rect;
  const centerAlong = axis === 'x'
    ? (targetRect.left + targetRect.right) / 2
    : (targetRect.top + targetRect.bottom) / 2;
  const cursor = axis === 'x' ? mouseX : mouseY;
  const insertBefore = cursor < centerAlong;
  let insertAt = insertBefore ? targetIndex : targetIndex + 1;
  if (insertAt > fromIndex) insertAt -= 1;
  return Math.max(0, Math.min(panes.length - 1, insertAt));
}

export interface DragReorderOptions {
  /** CSS selector for a reorderable item (i.e. .term-pane, .tab). Must expose
   * `data-session-id` on the element unless `getIdFromItem` is overridden. */
  itemSelector: string;
  /** CSS selector for the grab region inside an item. Can be the item itself
   * (`.tab`) or a child bar (`.pane-head`). */
  handleSelector: string;
  /** Optional selector for descendants of `handleSelector` that should NOT
   * initiate a drag (typical: a close button embedded in the handle). */
  ignoreSelector?: string;
  /** 'x' = row layout (pane grid); 'y' = column layout (rail tabs). Defaults
   * to 'x'. Also decides which edge (left/right vs top/bottom) the
   * drop-before/after CSS pseudo-elements paint on. */
  axis?: 'x' | 'y';
  /** Runtime gate. Called on every pointerdown; the handler bails when it
   * returns false. Use to disable pane drag in tabs mode, etc. */
  isEnabled?: () => boolean;
  /** Commit the reorder into whatever the caller uses as source-of-truth
   * (typically `Store.reorderSession`). */
  reorder: (fromId: string, toIndex: number) => void;
  /** Extract the id from an item element. Defaults to `el.dataset.sessionId`. */
  getIdFromItem?: (el: HTMLElement) => string | null;
  /** Class name added to `<body>` while a drag is in flight — the caller's CSS
   * hooks off it. Defaults to 'dragging-reorder'. */
  bodyClass?: string;
}

/**
 * Attach a pointer-based drag-to-reorder handler to a container.
 *
 * - `pointerdown` on any `handleSelector` (except `ignoreSelector`) captures
 *   the item; body gets `opts.bodyClass`, source item gets `.is-dragging`.
 * - `pointermove` past a 4px threshold: compute the current drop target from
 *   item rects + mouse position, and paint `.drop-before` / `.drop-after`
 *   on the target item's leading/trailing edge (axis-aware).
 * - `pointerup`: commit via `opts.reorder(fromId, dropIndex)` if the drop
 *   index differs from the source index.
 * - `Escape` or `pointercancel`: abandon without commit.
 *
 * Delegated pointerdown → one listener per container regardless of how many
 * items exist. State (source, capture id, drop target) is closure-local.
 */
export function attachDragReorder(
  container: HTMLElement,
  opts: DragReorderOptions,
): { dispose(): void } {
  const DRAG_THRESHOLD_PX = 4;
  const axis: 'x' | 'y' = opts.axis ?? 'x';
  const bodyClass = opts.bodyClass ?? 'dragging-reorder';
  const getIdFromItem = opts.getIdFromItem ?? ((el: HTMLElement) => el.dataset.sessionId ?? null);

  let fromItem: HTMLElement | null = null;
  let fromId: string | null = null;
  let fromIndex = -1;
  let pointerId: number | null = null;
  let handleEl: HTMLElement | null = null;
  let startX = 0;
  let startY = 0;
  let dragging = false;
  let lastDropIndex = -1;
  let lastTargetEl: HTMLElement | null = null;

  function clearDropIndicators(): void {
    if (lastTargetEl) {
      lastTargetEl.classList.remove('drop-before', 'drop-after');
      lastTargetEl = null;
    }
  }

  function endDrag(commit: boolean): void {
    if (dragging && commit && fromId != null && lastDropIndex >= 0 && lastDropIndex !== fromIndex) {
      opts.reorder(fromId, lastDropIndex);
    }
    document.body.classList.remove(bodyClass);
    fromItem?.classList.remove('is-dragging');
    clearDropIndicators();
    if (handleEl && pointerId != null && handleEl.hasPointerCapture(pointerId)) {
      try { handleEl.releasePointerCapture(pointerId); } catch { /* no-op */ }
    }
    handleEl?.removeEventListener('pointermove', onPointerMove);
    handleEl?.removeEventListener('pointerup', onPointerUp);
    handleEl?.removeEventListener('pointercancel', onPointerCancel);
    document.removeEventListener('keydown', onKeyDown, true);
    fromItem = null;
    fromId = null;
    fromIndex = -1;
    pointerId = null;
    handleEl = null;
    dragging = false;
    lastDropIndex = -1;
  }

  function collectItems(): { id: string; el: HTMLElement; rect: PaneRect }[] {
    const nodes = container.querySelectorAll<HTMLElement>(opts.itemSelector);
    const out: { id: string; el: HTMLElement; rect: PaneRect }[] = [];
    nodes.forEach(el => {
      const id = getIdFromItem(el);
      if (!id) return;
      out.push({ id, el, rect: el.getBoundingClientRect() });
    });
    return out;
  }

  function onPointerDown(e: PointerEvent): void {
    if (opts.isEnabled && !opts.isEnabled()) return;
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const handle = target.closest<HTMLElement>(opts.handleSelector);
    if (!handle || !container.contains(handle)) return;
    if (opts.ignoreSelector && target.closest(opts.ignoreSelector)) return;

    const item = handle.closest<HTMLElement>(opts.itemSelector);
    if (!item) return;
    const id = getIdFromItem(item);
    if (!id) return;

    const items = collectItems();
    const idx = items.findIndex(r => r.id === id);
    if (idx < 0) return;

    fromItem = item;
    fromId = id;
    fromIndex = idx;
    pointerId = e.pointerId;
    handleEl = handle;
    startX = e.clientX;
    startY = e.clientY;
    dragging = false;
    lastDropIndex = -1;

    try { handle.setPointerCapture(e.pointerId); } catch { /* no-op */ }
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', onPointerUp);
    handle.addEventListener('pointercancel', onPointerCancel);
    document.addEventListener('keydown', onKeyDown, true);
  }

  function onPointerMove(e: PointerEvent): void {
    if (pointerId == null || e.pointerId !== pointerId) return;
    if (!dragging) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
      dragging = true;
      document.body.classList.add(bodyClass);
      fromItem?.classList.add('is-dragging');
    }

    const items = collectItems();
    const rects: PaneRectEntry[] = items.map(({ id, rect }) => ({ id, rect }));
    lastDropIndex = computeDropIndex(rects, fromIndex, e.clientX, e.clientY, axis);

    clearDropIndicators();
    if (lastDropIndex !== fromIndex) {
      const anchorIndexInDom = lastDropIndex >= fromIndex ? lastDropIndex + 1 : lastDropIndex;
      const anchor = items[anchorIndexInDom]?.el;
      if (anchor && anchor !== fromItem) {
        anchor.classList.add('drop-before');
        lastTargetEl = anchor;
      } else {
        // Falling past the end: paint on the last item's trailing edge.
        const last = items[items.length - 1]?.el;
        if (last && last !== fromItem) {
          last.classList.add('drop-after');
          lastTargetEl = last;
        }
      }
    }
  }

  function onPointerUp(e: PointerEvent): void {
    if (pointerId == null || e.pointerId !== pointerId) return;
    // Browsers dispatch a click after pointerup on the same element the drag
    // ended over. Because we pointer-captured on `handleEl`, that click lands
    // on the handle — which for tabs is a session-activate trigger. Swallow
    // the very next click on the handle so a drag doesn't double as a select.
    // Only when the drag actually crossed the movement threshold; a pure click
    // (dragging === false) must still activate.
    if (dragging && handleEl) {
      const handle = handleEl;
      const suppressor = (ev: Event): void => {
        ev.stopPropagation();
        ev.preventDefault();
        handle.removeEventListener('click', suppressor, true);
      };
      handle.addEventListener('click', suppressor, true);
      // Belt-and-braces: if no click actually fires (drag ended off-handle),
      // detach the suppressor a tick later so it doesn't linger.
      setTimeout(() => handle.removeEventListener('click', suppressor, true), 0);
    }
    endDrag(true);
  }

  function onPointerCancel(e: PointerEvent): void {
    if (pointerId == null || e.pointerId !== pointerId) return;
    endDrag(false);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      endDrag(false);
    }
  }

  container.addEventListener('pointerdown', onPointerDown);

  return {
    dispose(): void {
      container.removeEventListener('pointerdown', onPointerDown);
      endDrag(false);
    },
  };
}
