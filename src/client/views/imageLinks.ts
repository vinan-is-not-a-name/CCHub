import type { Terminal, IBufferRange, IDisposable } from '@xterm/xterm';

/** Pattern cc renders for an attached image both while composing AND in the
 * conversation history once a turn is submitted (source: cc's `Cursor.ts`
 * `snapOutOfImageRef`). The capture group holds `#N` (the M value), which
 * cc emits monotonically per conversation — cumulative image count — so a
 * fresh fed image always gets a new M distinct from any historical or
 * ↑-replay chip already in the buffer at attach time. */
const IMAGE_PLACEHOLDER = /\[Image #(\d+)\]/g;

export interface ImageLinkHandlers {
  /** Called when the clicked chip resolves to a fed image on the server. */
  open: (sessionId: string, imageIndex: number) => void;
  /** Called when the clicked chip predates this attach (snapshot / never-fed
   * ↑-replay) — the client shows a "not supported" notice without hitting the
   * server. Injected so tests can spy without a DOM. */
  unsupported: () => void;
}

interface SessionImageState {
  term: Terminal;
  /** cc M value → server 1-based imageIndex. Populated the first time a
   * chip with an unseen M is spotted in the buffer while a fed image is
   * pending. All subsequent chips with the same M — including cc's echo in
   * the input line, the submitted `❯` line, and the assistant `⎿`
   * reference line — resolve through this map. */
  mBindings: Map<number, number>;
  /** Every M value we've ever seen in the buffer this session. Used to
   * detect "M first appears" events; snapshot chips loaded at attach time
   * seed this set as unbound so they can't later steal a fed binding. */
  seenMs: Set<number>;
  /** Fed imageIndexes waiting for a fresh chip to claim them. Populated by
   * `notifyImageFed()`, drained by scan the moment a new M shows up. */
  pendingFeeds: number[];
  writeDispose?: IDisposable;
}

const sessions = new Map<string, SessionImageState>();

function readMsInBuffer(term: Terminal): Set<number> {
  const buf = term.buffer.active;
  const out = new Set<number>();
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    IMAGE_PLACEHOLDER.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMAGE_PLACEHOLDER.exec(text)) !== null) {
      const M = parseInt(m[1], 10);
      if (!Number.isNaN(M)) out.add(M);
    }
  }
  return out;
}

function scan(state: SessionImageState): void {
  const currentMs = readMsInBuffer(state.term);
  for (const M of currentMs) {
    if (state.seenMs.has(M)) continue;
    state.seenMs.add(M);
    if (state.pendingFeeds.length > 0) {
      state.mBindings.set(M, state.pendingFeeds.shift()!);
    }
    // Otherwise: M appeared without a matching fed event (historical chip
    // restored from snapshot, or ↑ history replay of a chip whose original
    // fed happened in a prior process). Leave unbound.
  }
}

/**
 * Wire an xterm instance so `[Image #N]` chips are clickable. A chip is
 * trackable only if a server `image.fed` event arrived while its M value
 * was first appearing in the buffer; historical chips restored from a
 * `cc --continue` snapshot and chips re-emitted by ↑ history replay of a
 * *never-fed* image stay unbound and show a "not supported" notice on
 * click. The full binding contract is captured executably in
 * tests/imageLinks.spec.ts (the 10-step scenario).
 *
 * Note: an ↑ replay of an image that WAS fed in this process reuses the
 * same M value cc originally assigned to it, so those chips resolve to the
 * same server imageIndex as the original — a deliberate relaxation of the
 * strict "chips fed via MCP/POST" contract in favor of useful UX (the
 * chip really does point at that file, even if the round-trip went via
 * shell history).
 */
export function attachImageLinks(
  term: Terminal,
  sessionId: string,
  handlers: ImageLinkHandlers,
): IDisposable {
  const state: SessionImageState = {
    term,
    mBindings: new Map(),
    seenMs: new Set(),
    pendingFeeds: [],
  };
  sessions.set(sessionId, state);

  // Seed seenMs with whatever chips the loaded snapshot brought in — they
  // predate our WS attach, so no fed event can ever claim them and they
  // must stay unbound.
  scan(state);

  state.writeDispose = term.onWriteParsed(() => scan(state));

  const linkDispose = term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const buf = term.buffer.active;
      const line = buf.getLine(bufferLineNumber - 1);
      if (!line) { callback(undefined); return; }
      const rowText = line.translateToString(true);
      IMAGE_PLACEHOLDER.lastIndex = 0;
      const matches: { match: RegExpExecArray; col: number; M: number }[] = [];
      let m: RegExpExecArray | null;
      while ((m = IMAGE_PLACEHOLDER.exec(rowText)) !== null) {
        matches.push({ match: m, col: m.index, M: parseInt(m[1], 10) });
      }
      if (!matches.length) { callback(undefined); return; }
      const links = matches.map(({ match, col, M }) => {
        const range: IBufferRange = {
          start: { x: col + 1, y: bufferLineNumber },
          end: { x: col + match[0].length, y: bufferLineNumber },
        };
        return {
          range,
          text: match[0],
          activate: (event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            const imageIndex = state.mBindings.get(M);
            if (imageIndex === undefined) {
              handlers.unsupported();
              return;
            }
            handlers.open(sessionId, imageIndex);
          },
          hover: () => undefined,
          leave: () => undefined,
        };
      });
      callback(links);
    },
  });

  return {
    dispose() {
      linkDispose.dispose();
      state.writeDispose?.dispose();
      sessions.delete(sessionId);
    },
  };
}

/** Called by the WS message router when the server broadcasts `image.fed`.
 * Queues the imageIndex; the next chip with an unseen M value will bind to
 * it. Silently no-ops if the session's terminal isn't attached yet (rare —
 * server pushes image.fed only after WS subscribe). */
export function notifyImageFed(sessionId: string, imageIndex: number): void {
  const state = sessions.get(sessionId);
  if (!state) return;
  state.pendingFeeds.push(imageIndex);
  // Kick a scan in case the chip's already in the buffer between the
  // server's image.fed emit and its subsequent output writes reaching us.
  scan(state);
}
