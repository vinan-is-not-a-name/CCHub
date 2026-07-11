import type { AppDeps } from '../deps.js';

/** Minimal toast host — listens for `shell.reveal.error` server messages and
 * renders a fading notification in the bottom-right of the viewport. Toasts
 * auto-dismiss after 6s (long enough to read a path + error, short enough not
 * to pile up) and clicking one dismisses it immediately.
 *
 * The container is declared in index.html so the CSS positions it consistently
 * before this module loads; we only manage its children. */
export function mountToastHost(deps: AppDeps): void {
  const host = document.getElementById('toast-host');
  if (!host) return;

  deps.conn.onMessage((msg) => {
    if (msg.type !== 'shell.reveal.error') return;
    const heading = revealAppHeading(msg.app);
    showToast(host, `${heading}: ${msg.message}`, 'error');
  });
}

/** Human-readable app name for the reveal-error toast heading. Kept as a
 * plain switch (rather than a lookup dict + fallback) so an unhandled app
 * would surface as a TS type error at compile-time — since `shell.reveal`
 * grew to 8 apps, silently defaulting to "File browser" for a new one is
 * more confusing than helpful. */
function revealAppHeading(app: 'files' | 'xshell' | 'xftp' | 'vscode' | 'cmd' | 'cmd-admin' | 'powershell' | 'powershell-admin'): string {
  switch (app) {
    case 'files': return 'File browser';
    case 'xshell': return 'XShell';
    case 'xftp': return 'XFTP';
    case 'vscode': return 'VS Code';
    case 'cmd': return 'CMD';
    case 'cmd-admin': return 'CMD (admin)';
    case 'powershell': return 'PowerShell';
    case 'powershell-admin': return 'PowerShell (admin)';
  }
}

/** Show a toast from anywhere in the client. Silently no-ops when there is
 * no DOM at all (unit tests run in bare Node) or when the toast host isn't
 * mounted yet. The `typeof document` check has to come first — reading a
 * bare `document` in Node throws ReferenceError before the null-check runs. */
export function showAppToast(text: string, variant: 'error' | 'info' = 'info'): void {
  if (typeof document === 'undefined') return;
  const host = document.getElementById('toast-host');
  if (host) showToast(host, text, variant);
}

function showToast(host: HTMLElement, text: string, variant: 'error' | 'info' = 'info'): void {
  const toast = document.createElement('div');
  toast.className = `toast ${variant}`;
  toast.textContent = text;
  toast.setAttribute('role', 'status');
  toast.addEventListener('click', () => toast.remove());
  host.appendChild(toast);
  window.setTimeout(() => {
    if (toast.parentNode) toast.remove();
  }, 6000);
}
