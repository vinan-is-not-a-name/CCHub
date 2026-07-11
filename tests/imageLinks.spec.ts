import { test, expect } from '@playwright/test';
import { attachImageLinks, notifyImageFed } from '../src/client/views/imageLinks.js';
import type { Terminal, IBufferRange, IDisposable, ILinkProvider, ILink } from '@xterm/xterm';

/**
 * imageLinks binds cc's `[Image #M]` chips to server-side imageIndexes based
 * on the temporal ordering of `image.fed` events vs. new M values appearing
 * in the terminal buffer. This spec is the executable form of the binding
 * contract — the 10-step describe below is the acceptance test.
 *
 * The module only touches four bits of xterm surface — buffer.active
 * (.length + .getLine), onWriteParsed, registerLinkProvider, and the
 * IBufferRange type — so a fake terminal captures its inputs perfectly
 * without needing a DOM or a real @xterm/xterm instance.
 */

interface WriteListener { (): void; }

/** Minimal xterm.Terminal fake sufficient for attachImageLinks. Test-only
 * helpers on `_` let each spec drive buffer changes. */
function makeFakeTerm(initial: string[] = []) {
  let lines = [...initial];
  const writeListeners: WriteListener[] = [];
  let provider: ILinkProvider | null = null;

  const term = {
    buffer: {
      active: {
        get length() { return lines.length; },
        getLine: (y: number) => y >= 0 && y < lines.length ? {
          translateToString: () => lines[y],
        } : undefined,
      },
    },
    onWriteParsed: (cb: WriteListener): IDisposable => {
      writeListeners.push(cb);
      return { dispose: () => {
        const i = writeListeners.indexOf(cb);
        if (i >= 0) writeListeners.splice(i, 1);
      } };
    },
    registerLinkProvider: (p: ILinkProvider): IDisposable => {
      provider = p;
      return { dispose: () => { if (provider === p) provider = null; } };
    },
  } as unknown as Terminal;

  return {
    term,
    /** Replace the entire buffer contents and fire a synthetic parse event
     * — mirrors what happens when xterm parses a batch of writes. */
    setLines(next: string[]) {
      lines = [...next];
      for (const cb of [...writeListeners]) cb();
    },
    /** Query links at buffer row `bufferLineNumber` (1-indexed, xterm's
     * convention). Returns the array of ILink objects the provider builds
     * — the caller then invokes `activate` on the one it wants. */
    async linksOn(bufferLineNumber: number): Promise<ILink[]> {
      if (!provider) throw new Error('no link provider registered');
      return new Promise((resolve) => {
        provider!.provideLinks(bufferLineNumber, (links) => resolve(links ?? []));
      });
    },
    hasProvider: () => provider !== null,
  };
}

/** A stub MouseEvent — imageLinks only calls preventDefault/stopPropagation. */
function fakeEvent(): MouseEvent {
  return { preventDefault() {}, stopPropagation() {} } as unknown as MouseEvent;
}

interface Spy {
  open: string[];              // ["sid|imageIndex", ...]
  unsupported: number;
}
function makeSpy(): { handlers: { open: (sid: string, idx: number) => void; unsupported: () => void }; spy: Spy } {
  const spy: Spy = { open: [], unsupported: 0 };
  return {
    spy,
    handlers: {
      open: (sid, idx) => spy.open.push(`${sid}|${idx}`),
      unsupported: () => { spy.unsupported++; },
    },
  };
}

test.describe('imageLinks — attach + snapshot seeding', () => {
  test('chips present at attach time never bind', async () => {
    const t = makeFakeTerm([
      '❯ [Image #1]',
      '  ⎿ [Image #1]',
    ]);
    const { handlers, spy } = makeSpy();
    attachImageLinks(t.term, 'sid', handlers);

    const links = await t.linksOn(1);
    expect(links).toHaveLength(1);
    links[0].activate(fakeEvent(), links[0].text);
    expect(spy.unsupported).toBe(1);
    expect(spy.open).toEqual([]);
  });

  test('registers a link provider on attach', () => {
    const t = makeFakeTerm();
    const { handlers } = makeSpy();
    attachImageLinks(t.term, 'sid', handlers);
    expect(t.hasProvider()).toBe(true);
  });

  test('dispose tears down provider + write listener', async () => {
    const t = makeFakeTerm(['❯ [Image #1]']);
    const { handlers } = makeSpy();
    const disp = attachImageLinks(t.term, 'sid', handlers);
    expect(t.hasProvider()).toBe(true);
    disp.dispose();
    expect(t.hasProvider()).toBe(false);
  });
});

test.describe('imageLinks — image.fed + chip appearance', () => {
  test('fed image binds to the first unseen M that follows', async () => {
    const t = makeFakeTerm([]);
    const { handlers, spy } = makeSpy();
    attachImageLinks(t.term, 'sid', handlers);

    // Server fires image.fed BEFORE cc's paste echo lands — real-world ordering
    // (recordImage → paste, with WS messages queued in the same order).
    notifyImageFed('sid', 1);
    t.setLines(['❯ [Image #1]', '  ⎿ [Image #1]']);

    for (const y of [1, 2]) {
      const links = await t.linksOn(y);
      links[0].activate(fakeEvent(), links[0].text);
    }
    expect(spy.open).toEqual(['sid|1', 'sid|1']);
    expect(spy.unsupported).toBe(0);
  });

  test('chip that appears without a matching fed stays unbound', async () => {
    const t = makeFakeTerm([]);
    const { handlers, spy } = makeSpy();
    attachImageLinks(t.term, 'sid', handlers);

    t.setLines(['❯ [Image #1]']);
    const links = await t.linksOn(1);
    links[0].activate(fakeEvent(), links[0].text);
    expect(spy.unsupported).toBe(1);
    expect(spy.open).toEqual([]);
  });

  test('scan runs on notifyImageFed too — covers chip-before-notify races', async () => {
    // Rare in practice (server always emits image.fed strictly before the
    // paste bytes reach the PTY) but the module supports it defensively so a
    // reordered WS delivery doesn't drop the binding.
    const t = makeFakeTerm([]);
    const { handlers, spy } = makeSpy();
    attachImageLinks(t.term, 'sid', handlers);

    t.setLines(['❯ [Image #1]']);
    // First scan happened via onWriteParsed — M=1 was seeded as unbound.
    // notifyImageFed's re-scan can NOT retroactively bind it (that would let
    // an unrelated fed steal a historic chip).
    notifyImageFed('sid', 1);
    const links = await t.linksOn(1);
    links[0].activate(fakeEvent(), links[0].text);
    expect(spy.unsupported).toBe(1);
    expect(spy.open).toEqual([]);
  });

  test('same M appearing again (↑-replay of a fed image) resolves to the same imageIndex', async () => {
    // Deliberate relaxation of the "strict fed-only" contract: cc reuses M
    // when a prompt is recalled via ↑, and the on-disk file is unchanged, so
    // showing that file is better UX than a blanket refusal.
    const t = makeFakeTerm([]);
    const { handlers, spy } = makeSpy();
    attachImageLinks(t.term, 'sid', handlers);

    notifyImageFed('sid', 2);
    t.setLines(['❯ [Image #1]', '  ⎿ [Image #1]']);

    // ↑ replay adds a new chip pair with the SAME M elsewhere in buffer.
    t.setLines([
      '❯ [Image #1]',                    // original prompt
      '  ⎿ [Image #1]',                  // original ref
      '❯ [Image #1]',                    // replayed prompt (same M)
      '  ⎿ [Image #1]',                  // replayed ref
    ]);

    const links = await t.linksOn(3);
    links[0].activate(fakeEvent(), links[0].text);
    expect(spy.open).toEqual(['sid|2']);
  });
});

test.describe('imageLinks — multiple feds', () => {
  test('two feds queued FIFO bind to two new Ms in order', async () => {
    const t = makeFakeTerm([]);
    const { handlers, spy } = makeSpy();
    attachImageLinks(t.term, 'sid', handlers);

    notifyImageFed('sid', 1);
    notifyImageFed('sid', 2);
    t.setLines(['❯ [Image #5]', '❯ [Image #6]']);

    const l5 = await t.linksOn(1);
    const l6 = await t.linksOn(2);
    l5[0].activate(fakeEvent(), l5[0].text);
    l6[0].activate(fakeEvent(), l6[0].text);
    expect(spy.open).toEqual(['sid|1', 'sid|2']);
  });

  test('fed queued but never claimed stays in pendingFeeds', async () => {
    const t = makeFakeTerm([]);
    const { handlers, spy } = makeSpy();
    attachImageLinks(t.term, 'sid', handlers);

    notifyImageFed('sid', 1);
    // No chip ever appears — pending sits. Next chip that DOES appear will
    // still bind to it (no TTL expiry is intentional).
    t.setLines(['some other output line', 'more output']);
    t.setLines(['some other output line', 'more output', '❯ [Image #9]']);

    const links = await t.linksOn(3);
    links[0].activate(fakeEvent(), links[0].text);
    expect(spy.open).toEqual(['sid|1']);
  });
});

test.describe('imageLinks — session isolation', () => {
  test('notifyImageFed for an unattached session is a silent no-op', () => {
    // No throw, no side effect.
    expect(() => notifyImageFed('nonexistent-session', 42)).not.toThrow();
  });

  test('feds are per-session; two attached sessions maintain independent state', async () => {
    const tA = makeFakeTerm([]);
    const tB = makeFakeTerm([]);
    const a = makeSpy(); const b = makeSpy();
    attachImageLinks(tA.term, 'A', a.handlers);
    attachImageLinks(tB.term, 'B', b.handlers);

    notifyImageFed('A', 1);
    tA.setLines(['❯ [Image #1]']);
    tB.setLines(['❯ [Image #1]']);           // B has same M value, but no fed

    const laLink = await tA.linksOn(1);
    laLink[0].activate(fakeEvent(), laLink[0].text);
    const lbLink = await tB.linksOn(1);
    lbLink[0].activate(fakeEvent(), lbLink[0].text);

    expect(a.spy.open).toEqual(['A|1']);
    expect(a.spy.unsupported).toBe(0);
    expect(b.spy.open).toEqual([]);
    expect(b.spy.unsupported).toBe(1);
  });
});

// The full 10-step scenario, mechanically translated from the original
// manual test. This is the acceptance test for the M-binding contract; if
// any assertion here changes, the contract itself is changing.
test.describe('imageLinks — 10-step scenario', () => {
  test('reproduces the documented sequence end-to-end', async () => {
    const t = makeFakeTerm([]);
    const { handlers, spy } = makeSpy();
    attachImageLinks(t.term, 'sid', handlers);

    // Step 1: cc --continue restores 4 historic chips (M=4..7).
    t.setLines([
      '❯ [Image #4]', '  ⎿ [Image #4]',
      '❯ [Image #5]', '  ⎿ [Image #5]',
      '❯ [Image #6]', '  ⎿ [Image #6]',
      '❯ [Image #7]', '  ⎿ [Image #7]',
    ]);

    // Step 2: click historic [Image #4] → unsupported
    let links = await t.linksOn(1);
    links[0].activate(fakeEvent(), links[0].text);
    expect(spy.unsupported).toBe(1);

    // Step 3: server feds digit1, cc renders chip pair with M=8
    notifyImageFed('sid', 1);
    t.setLines([
      '❯ [Image #4]', '  ⎿ [Image #4]',
      '❯ [Image #5]', '  ⎿ [Image #5]',
      '❯ [Image #6]', '  ⎿ [Image #6]',
      '❯ [Image #7]', '  ⎿ [Image #7]',
      '❯ [Image #8]', '  ⎿ [Image #8]',
    ]);

    // Step 4: click new [Image #8] → digit1 (imageIndex=1)
    links = await t.linksOn(9);
    links[0].activate(fakeEvent(), links[0].text);
    expect(spy.open).toEqual(['sid|1']);

    // Step 5: ↑ replay of [Image #8] renders another pair (same M).
    t.setLines([
      '❯ [Image #4]', '  ⎿ [Image #4]',
      '❯ [Image #5]', '  ⎿ [Image #5]',
      '❯ [Image #6]', '  ⎿ [Image #6]',
      '❯ [Image #7]', '  ⎿ [Image #7]',
      '❯ [Image #8]', '  ⎿ [Image #8]',
      '❯ [Image #8]', '  ⎿ [Image #8]',
    ]);

    // Step 6: click the replayed chip → digit1 (relaxed contract).
    links = await t.linksOn(11);
    links[0].activate(fakeEvent(), links[0].text);
    expect(spy.open).toEqual(['sid|1', 'sid|1']);

    // Step 7: ↑ replay of the historic [Image #6] prompt renders a new pair
    // with M=6 (the pre-continue shell history path that couldn't be tested
    // in Playwright but IS covered here).
    t.setLines([
      '❯ [Image #4]', '  ⎿ [Image #4]',
      '❯ [Image #5]', '  ⎿ [Image #5]',
      '❯ [Image #6]', '  ⎿ [Image #6]',
      '❯ [Image #7]', '  ⎿ [Image #7]',
      '❯ [Image #8]', '  ⎿ [Image #8]',
      '❯ [Image #8]', '  ⎿ [Image #8]',
      '❯ [Image #6]', '  ⎿ [Image #6]',       // replay of historic M=6
    ]);

    // Step 8: click the replayed historic chip → unsupported
    // (M=6 was seeded at snapshot time, no fed can claim it retroactively).
    links = await t.linksOn(13);
    links[0].activate(fakeEvent(), links[0].text);
    expect(spy.unsupported).toBe(2);

    // Step 9: server feds digit2, cc renders chip pair with M=9
    notifyImageFed('sid', 2);
    t.setLines([
      '❯ [Image #4]', '  ⎿ [Image #4]',
      '❯ [Image #5]', '  ⎿ [Image #5]',
      '❯ [Image #6]', '  ⎿ [Image #6]',
      '❯ [Image #7]', '  ⎿ [Image #7]',
      '❯ [Image #8]', '  ⎿ [Image #8]',
      '❯ [Image #8]', '  ⎿ [Image #8]',
      '❯ [Image #6]', '  ⎿ [Image #6]',
      '❯ [Image #9]', '  ⎿ [Image #9]',
    ]);

    // Step 10: click every chip in buffer, assert the full resolution map.
    // Reset spy so the counts reflect step 10 only.
    spy.open.length = 0; spy.unsupported = 0;
    const rows: Array<{ y: number; M: number }> = [
      { y: 1, M: 4 }, { y: 2, M: 4 },       // historic
      { y: 3, M: 5 }, { y: 4, M: 5 },       // historic
      { y: 5, M: 6 }, { y: 6, M: 6 },       // historic
      { y: 7, M: 7 }, { y: 8, M: 7 },       // historic
      { y: 9, M: 8 }, { y: 10, M: 8 },      // fed digit1
      { y: 11, M: 8 }, { y: 12, M: 8 },     // ↑ replay of fed → still digit1
      { y: 13, M: 6 }, { y: 14, M: 6 },     // ↑ replay of historic → unsupported
      { y: 15, M: 9 }, { y: 16, M: 9 },     // fed digit2
    ];
    for (const { y } of rows) {
      const l = await t.linksOn(y);
      l[0].activate(fakeEvent(), l[0].text);
    }
    // 8 historic (M=4/5/6/7 x 2) + 2 replayed-historic (M=6 x 2) = 10 unsupported
    expect(spy.unsupported).toBe(10);
    // 4 fed-digit1 chips (M=8 x 4) + 2 fed-digit2 chips (M=9 x 2) = 6 opens
    expect(spy.open).toEqual([
      'sid|1', 'sid|1', 'sid|1', 'sid|1',
      'sid|2', 'sid|2',
    ]);
  });
});

test.describe('imageLinks — link range geometry', () => {
  test('range spans exactly the [Image #N] text', async () => {
    const t = makeFakeTerm(['some prefix [Image #42] tail text']);
    const { handlers } = makeSpy();
    attachImageLinks(t.term, 'sid', handlers);

    const links = await t.linksOn(1);
    expect(links).toHaveLength(1);
    // "some prefix " is 12 chars → chip starts at col 12 (0-indexed); xterm
    // ranges are 1-indexed inclusive, so start.x = 13, end.x = 13 + 11 - 1 = 23.
    const range: IBufferRange = links[0].range;
    expect(range.start).toEqual({ x: 13, y: 1 });
    expect(range.end).toEqual({ x: 23, y: 1 });
    expect(links[0].text).toBe('[Image #42]');
  });

  test('multiple chips on the same row each get their own link', async () => {
    // Start empty so the feds arrive BEFORE the chips (mirrors the real
    // recordImage-then-paste ordering). If the chips were seeded at attach
    // time they'd land in seenMs unbound and no later fed could claim them.
    const t = makeFakeTerm([]);
    const { handlers, spy } = makeSpy();
    attachImageLinks(t.term, 'sid', handlers);
    notifyImageFed('sid', 7);
    notifyImageFed('sid', 8);
    t.setLines(['[Image #1]  [Image #2]']);

    const links = await t.linksOn(1);
    expect(links).toHaveLength(2);
    links[0].activate(fakeEvent(), links[0].text);
    links[1].activate(fakeEvent(), links[1].text);
    expect(spy.open).toEqual(['sid|7', 'sid|8']);
  });
});
