import type { Terminal } from '@xterm/xterm';

/**
 * Intercept the textarea's `paste` event so a clipboard *image* (Ctrl+V or
 * right-click paste of a screenshot, copy-from-image-app, drag-drop, etc.)
 * gets uploaded to the server's `/paste-image/:sessionId` route instead of
 * being silently dropped. Text pastes fall through untouched — xterm's own
 * paste handler reads them from `clipboardData.getData('text/plain')` and
 * emits a bracketed paste to the PTY.
 *
 * Returns a dispose function the caller invokes when the session pane is
 * being torn down. Capture-phase listener so we run before xterm's own
 * default-action handler.
 */
export function attachImagePaste(term: Terminal, sessionId: string): () => void {
  const ta = term.textarea;
  if (!ta) return () => {};
  const onPaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;
    // Find the first image item. A paste can carry both text/html and a PNG
    // (Windows screenshot), in which case we still want the image.
    let imageItem: DataTransferItem | undefined;
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      if (it.kind === 'file' && it.type.startsWith('image/')) { imageItem = it; break; }
    }
    if (!imageItem) return;
    e.preventDefault();
    e.stopPropagation();
    const blob = imageItem.getAsFile();
    if (!blob) return;
    void upload(sessionId, blob);
  };
  ta.addEventListener('paste', onPaste, true);
  return () => ta.removeEventListener('paste', onPaste, true);
}

async function upload(sessionId: string, blob: Blob): Promise<void> {
  const token = sessionStorage.getItem('cchub-token') ?? '';
  const headers: Record<string, string> = { 'Content-Type': blob.type || 'application/octet-stream' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  try {
    const res = await fetch(`/paste-image/${encodeURIComponent(sessionId)}`, {
      method: 'POST',
      headers,
      body: blob,
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const body = await safeJson(res);
      console.error('[cchub] paste-image failed:', res.status, body?.error ?? res.statusText);
    }
  } catch (err) {
    console.error('[cchub] paste-image network error:', err);
  }
}

async function safeJson(res: Response): Promise<{ error?: string } | null> {
  try { return await res.json(); } catch { return null; }
}
