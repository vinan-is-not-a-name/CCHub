import type { Terminal, IDisposable } from '@xterm/xterm';

/**
 * Wire clipboard writes from two sources:
 *
 * 1. **Local xterm selection** (mouseup): fires whenever the user drags to
 *    select in xterm's OWN selection engine — only works when cc has SGR
 *    mouse tracking OFF (rare in an active cc session; cc turns it on for
 *    hover/click features).
 *
 * 2. **OSC 52** from cc: when cc's own auto-copy fires and cc decides the
 *    terminal owns the clipboard (i.e. cc is running under a TTY with no
 *    native clipboard tool, or over SSH), it emits `ESC ] 52 ; c ; <b64> BEL`.
 *    Without a handler xterm just drops the sequence and the user sees cc
 *    say "sent 31 chars via OSC 52" while nothing lands in the OS clipboard.
 *    Registering a handler lets that path succeed too — the user still sees
 *    the OSC 52 message from cc, but their clipboard now actually has the
 *    bytes. This is the sole fix for the "some sessions can't copy" report;
 *    the message wording is cc's, not ours to change.
 */
export function attachClipboard(container: HTMLElement, term: Terminal): IDisposable {
  const onMouseUp = () => {
    const selection = term.getSelection();
    if (selection) void navigator.clipboard.writeText(selection);
  };
  container.addEventListener('mouseup', onMouseUp);

  const osc52 = term.parser.registerOscHandler(52, (data: string) => {
    // Payload is `Pc;Pd` — Pc is target(s) (c/p/s/0-7), Pd is base64 or `?`.
    // We ignore reads (`?`) since browsers gate clipboard.readText behind an
    // explicit user gesture we can't originate from a PTY escape sequence.
    const semi = data.indexOf(';');
    if (semi < 0) return false;
    const payload = data.slice(semi + 1);
    if (!payload || payload === '?') return true;
    try {
      // atob returns a binary string (one char per byte). Feeding that to
      // clipboard.writeText mangles multi-byte UTF-8 — a Chinese "所" (three
      // bytes E6 89 80) surfaces as three latin-1 chars "æ" "‰" "€". Round
      // through Uint8Array + TextDecoder so the bytes are re-assembled into
      // proper code points first.
      const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
      const text = new TextDecoder('utf-8').decode(bytes);
      void navigator.clipboard.writeText(text);
    } catch {
      // Malformed base64 — cc should never emit this, but a bad string
      // shouldn't wedge the parser. Silent drop is fine.
    }
    return true;
  });

  return {
    dispose() {
      container.removeEventListener('mouseup', onMouseUp);
      osc52.dispose();
    },
  };
}
