import { test, expect } from '@playwright/test';
import { attachClipboard } from '../src/client/terminalClipboard.js';
import type { Terminal } from '@xterm/xterm';

// terminalClipboard has two collaborators (a container element for mouseup
// and xterm's parser for OSC 52) that we fake here so the whole module can
// run without a DOM or a real xterm instance.

interface FakeContainer {
  addEventListener: HTMLElement['addEventListener'];
  removeEventListener: HTMLElement['removeEventListener'];
  fireMouseUp(): void;
}

function makeContainer(): FakeContainer {
  let handler: EventListener | null = null;
  return {
    addEventListener: ((event, h) => {
      if (event === 'mouseup') handler = h as EventListener;
    }) as HTMLElement['addEventListener'],
    removeEventListener: ((event, h) => {
      if (event === 'mouseup' && handler === (h as EventListener)) handler = null;
    }) as HTMLElement['removeEventListener'],
    fireMouseUp() { handler?.(new Event('mouseup')); },
  };
}

interface FakeTerm {
  term: Terminal;
  setSelection(text: string): void;
  writeOsc52(payload: string): boolean;
  hasHandler(): boolean;
}

function makeTerm(): FakeTerm {
  let selection = '';
  let oscHandler: ((data: string) => boolean | Promise<boolean>) | null = null;
  const term = {
    getSelection: () => selection,
    parser: {
      registerOscHandler: (id: number, h: (d: string) => boolean | Promise<boolean>) => {
        if (id !== 52) throw new Error(`unexpected OSC id ${id}`);
        oscHandler = h;
        return { dispose: () => { if (oscHandler === h) oscHandler = null; } };
      },
    },
  } as unknown as Terminal;
  return {
    term,
    setSelection(text: string) { selection = text; },
    writeOsc52(payload: string) {
      if (!oscHandler) throw new Error('no OSC handler');
      const r = oscHandler(payload);
      return typeof r === 'boolean' ? r : true;
    },
    hasHandler: () => oscHandler !== null,
  };
}

/** Grab whatever text was written to `navigator.clipboard.writeText` during
 * the callback and restore the original stub. Playwright's node test runner
 * doesn't set up `navigator`, so we install a minimal one on the global. */
async function captureWrites(fn: () => void | Promise<void>): Promise<string[]> {
  const captured: string[] = [];
  // Node's `navigator` is read-only, so we can't just reassign it. Patch its
  // `clipboard` property via defineProperty instead — restored in `finally`
  // so tests don't leak state.
  const nav = (globalThis as any).navigator as Navigator | undefined;
  const previous = nav ? Object.getOwnPropertyDescriptor(nav, 'clipboard') : undefined;
  const fakeClipboard = {
    writeText: (text: string) => { captured.push(text); return Promise.resolve(); },
  };
  if (nav) {
    Object.defineProperty(nav, 'clipboard', { value: fakeClipboard, configurable: true, writable: true });
  } else {
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: fakeClipboard }, configurable: true, writable: true,
    });
  }
  try {
    await fn();
  } finally {
    if (nav) {
      if (previous) Object.defineProperty(nav, 'clipboard', previous);
      else delete (nav as any).clipboard;
    } else {
      delete (globalThis as any).navigator;
    }
  }
  return captured;
}

test.describe('attachClipboard — mouseup local selection', () => {
  test('writes xterm.getSelection() to clipboard on mouseup', async () => {
    const c = makeContainer(); const t = makeTerm();
    t.setSelection('picked text');
    attachClipboard(c as unknown as HTMLElement, t.term);
    const writes = await captureWrites(() => c.fireMouseUp());
    expect(writes).toEqual(['picked text']);
  });

  test('empty selection does not write', async () => {
    const c = makeContainer(); const t = makeTerm();
    t.setSelection('');
    attachClipboard(c as unknown as HTMLElement, t.term);
    const writes = await captureWrites(() => c.fireMouseUp());
    expect(writes).toEqual([]);
  });
});

test.describe('attachClipboard — OSC 52', () => {
  test('registers an OSC 52 handler on attach', () => {
    const c = makeContainer(); const t = makeTerm();
    expect(t.hasHandler()).toBe(false);
    attachClipboard(c as unknown as HTMLElement, t.term);
    expect(t.hasHandler()).toBe(true);
  });

  test('decodes base64 payload and writes to clipboard', async () => {
    const c = makeContainer(); const t = makeTerm();
    attachClipboard(c as unknown as HTMLElement, t.term);
    // Node has global atob/btoa in modern runtimes; assume it here as the
    // browser bundle does the same.
    const writes = await captureWrites(() => {
      const ok = t.writeOsc52('c;' + btoa('hello osc52'));
      expect(ok).toBe(true);
    });
    expect(writes).toEqual(['hello osc52']);
  });

  test('decodes UTF-8 payload correctly (no latin-1 mojibake)', async () => {
    // cc emits base64 of the UTF-8 bytes. A naive `atob(...)` -> writeText
    // pipes each byte as a latin-1 char and turns "所有产物" into
    // "ææäº§ç©". Encode/decode via TextDecoder to reassemble the
    // code points properly. This is the regression that made the initial
    // OSC 52 shipped fix look "broken" on Chinese-language sessions.
    const c = makeContainer(); const t = makeTerm();
    attachClipboard(c as unknown as HTMLElement, t.term);
    const bytes = new TextEncoder().encode('所有产物');
    let b64 = '';
    for (const b of bytes) b64 += String.fromCharCode(b);
    const writes = await captureWrites(() => {
      t.writeOsc52('c;' + btoa(b64));
    });
    expect(writes).toEqual(['所有产物']);
  });

  test('ignores read queries (Pd = "?")', async () => {
    // The browser can't hand back clipboard content from a PTY escape without
    // an explicit user gesture, and cc doesn't need it — silently succeed.
    const c = makeContainer(); const t = makeTerm();
    attachClipboard(c as unknown as HTMLElement, t.term);
    const writes = await captureWrites(() => {
      expect(t.writeOsc52('c;?')).toBe(true);
    });
    expect(writes).toEqual([]);
  });

  test('accepts multi-target selectors ("c,p;...")', async () => {
    // Pc can be a set of targets. We only care about Pd, so anything at all
    // before the first ; is fine.
    const c = makeContainer(); const t = makeTerm();
    attachClipboard(c as unknown as HTMLElement, t.term);
    const writes = await captureWrites(() => {
      t.writeOsc52('c,p;' + btoa('multi'));
    });
    expect(writes).toEqual(['multi']);
  });

  test('malformed payload without a semicolon is unhandled (returns false)', async () => {
    const c = makeContainer(); const t = makeTerm();
    attachClipboard(c as unknown as HTMLElement, t.term);
    const writes = await captureWrites(() => {
      expect(t.writeOsc52('garbage')).toBe(false);
    });
    expect(writes).toEqual([]);
  });

  test('invalid base64 does not throw and does not write', async () => {
    const c = makeContainer(); const t = makeTerm();
    attachClipboard(c as unknown as HTMLElement, t.term);
    const writes = await captureWrites(() => {
      expect(() => t.writeOsc52('c;!!not-base64!!')).not.toThrow();
    });
    expect(writes).toEqual([]);
  });
});

test.describe('attachClipboard — dispose', () => {
  test('detaches both mouseup and OSC handlers', async () => {
    const c = makeContainer(); const t = makeTerm();
    t.setSelection('leaked');
    const d = attachClipboard(c as unknown as HTMLElement, t.term);
    d.dispose();
    const writes = await captureWrites(() => {
      c.fireMouseUp();
      // Handler is null after dispose — writeOsc52 would throw.
      expect(t.hasHandler()).toBe(false);
    });
    expect(writes).toEqual([]);
  });
});
