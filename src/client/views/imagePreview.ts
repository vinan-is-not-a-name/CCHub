/**
 * A single, app-wide image preview modal. Lazily created on first open, then
 * reused — there is no concept of stacking previews. Closing modes:
 *  - click the backdrop
 *  - press Escape
 *  - click the close button
 * The image is fetched as a blob (so we can revoke the object URL on close)
 * with the WS auth token, which the server's /image route also accepts as a
 * `?token=` query param for the same reason browsers can't set Authorization
 * on plain `<img src>`.
 */

let modal: HTMLDivElement | null = null;
let currentObjectUrl: string | null = null;

function build(): HTMLDivElement {
  const root = document.createElement('div');
  root.className = 'image-preview';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Image preview');
  root.hidden = true;
  root.innerHTML = `
    <div class="image-preview-backdrop"></div>
    <div class="image-preview-frame">
      <button type="button" class="image-preview-close" aria-label="Close preview">×</button>
      <div class="image-preview-status" aria-live="polite">Loading…</div>
      <img alt="" class="image-preview-img" hidden />
    </div>
  `;
  const backdrop = root.querySelector('.image-preview-backdrop') as HTMLDivElement;
  const close = root.querySelector('.image-preview-close') as HTMLButtonElement;
  backdrop.addEventListener('click', dismiss);
  close.addEventListener('click', dismiss);
  document.body.appendChild(root);
  document.addEventListener('keydown', (e) => {
    if (!root.hidden && e.key === 'Escape') {
      e.stopPropagation();
      dismiss();
    }
  });
  return root;
}

function dismiss(): void {
  if (!modal) return;
  modal.hidden = true;
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
  const img = modal.querySelector('.image-preview-img') as HTMLImageElement;
  img.hidden = true;
  img.removeAttribute('src');
  const status = modal.querySelector('.image-preview-status') as HTMLDivElement;
  status.hidden = false;
  status.textContent = 'Loading…';
}

/** Fetch the image bytes from /image/:sessionId/:index and show them in the
 * shared modal. The session id is the per-session capability token; the
 * `token` query param is the cchub auth token from sessionStorage (empty
 * string when auth is disabled). Any fetch failure surfaces inline so the user
 * sees *why* nothing rendered. */
export async function openImagePreview(sessionId: string, occurrenceIndex: number): Promise<void> {
  if (!modal) modal = build();
  const status = modal.querySelector('.image-preview-status') as HTMLDivElement;
  const img = modal.querySelector('.image-preview-img') as HTMLImageElement;
  img.hidden = true;
  img.removeAttribute('src');
  status.hidden = false;
  status.textContent = 'Loading…';
  modal.hidden = false;

  const token = sessionStorage.getItem('cchub-token') ?? '';
  const url = `/image/${encodeURIComponent(sessionId)}/${occurrenceIndex}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) {
      status.textContent = await describeFailure(res);
      return;
    }
    const blob = await res.blob();
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = URL.createObjectURL(blob);
    img.src = currentObjectUrl;
    img.hidden = false;
    status.hidden = true;
  } catch (error) {
    status.textContent = `Failed to load image: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Show the modal directly in "unsupported" state without hitting the server.
 * Used by imageLinks when a clicked chip has no client-side binding — the
 * chip predates this process (resumed session snapshot) or was re-emitted by
 * cc's ↑ history replay, so there is no reliable path to fetch. Bypassing
 * the fetch also prevents a stray 404 from being interpreted as a match. */
export function showImageUnsupported(): void {
  if (!modal) modal = build();
  const status = modal.querySelector('.image-preview-status') as HTMLDivElement;
  const img = modal.querySelector('.image-preview-img') as HTMLImageElement;
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
  img.hidden = true;
  img.removeAttribute('src');
  status.hidden = false;
  status.textContent = '从会话中恢复的记录图片不支持显示';
  modal.hidden = false;
}

async function describeFailure(res: Response): Promise<string> {
  // 404 on this route, in practice, means the clicked chip has no recorded
  // path: either it predates this process (chip restored from a resumed cc
  // session whose feeds never went through *this* server) or the session in
  // the URL is gone. By far the common case is the resume one, and there's
  // nothing the user can do about it — surface a friendly explanation.
  if (res.status === 404) return '从会话中恢复的记录图片不支持显示';
  // 410 / 415 / 401 carry distinct, actionable reasons — pass them through.
  try {
    const body = await res.json() as { error?: string };
    if (body?.error) return `Couldn't load image: ${body.error}`;
  } catch {}
  return `Couldn't load image (HTTP ${res.status})`;
}
