import type { AppDeps } from '../deps.js';

/** Minimal toast host — listens for `shell.reveal.error` server messages and
 * renders a fading notification in the bottom-right of the viewport. Toasts
 * auto-dismiss after 6s (long enough to read a path + error, short enough not
 * to pile up) and clicking one dismisses it immediately.
 *
 * The container is declared in index.html so the CSS positions it consistently
 * before this module loads; we only manage its children. When a modal <dialog>
 * is open we mount into it instead — see resolveToastHost. */
export function mountToastHost(deps: AppDeps): void {
  if (!document.getElementById('toast-host')) return;

  deps.conn.onMessage((msg) => {
    if (msg.type !== 'shell.reveal.error') return;
    showToast(`${revealAppHeading(msg.app)}: ${msg.message}`, 'error');
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
 * no DOM at all (unit tests run in bare Node). The `typeof document` check has
 * to come first — reading a bare `document` in Node throws ReferenceError. */
export function showAppToast(text: string, variant: 'error' | 'info' = 'info'): void {
  if (typeof document === 'undefined') return;
  showToast(text, variant);
}

/** Pick where a toast should mount. A modal <dialog> renders in the browser
 * top layer, which sits above the global #toast-host — no z-index can beat the
 * top layer, so a toast in the global host is hidden behind whatever dialog is
 * open (the exact bug: "folder name invalid" fired but was invisible inside the
 * directory picker). A dialog's own children render inside its top-layer
 * context, so a fixed host appended there paints above the dialog. Prefer the
 * dialog that owns focus so nested dialogs (launch → directory browser) target
 * the topmost one; fall back to any open dialog, then the global host. */
function resolveToastHost(): HTMLElement | null {
  // Prefer the dialog that owns focus: a modal <dialog> traps focus inside the
  // top-most one, so this reliably targets whatever is actually on top for
  // nested dialogs (launch → directory browser). Fall back to the LAST open
  // dialog, not the first — some actions hide the focused control just before
  // toasting (mkdir success closes the new-folder row), which drops focus to
  // <body>; the top-most modal is last in DOM order, so the first match would
  // be the dialog sitting *behind* the one the user is looking at.
  const openDialogs = Array.from(document.querySelectorAll<HTMLElement>('dialog[open]'));
  const dialog =
    document.activeElement?.closest<HTMLElement>('dialog[open]')
    ?? openDialogs[openDialogs.length - 1];
  if (!dialog) return document.getElementById('toast-host');
  let host = dialog.querySelector<HTMLElement>(':scope > .toast-host');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toast-host';
    host.setAttribute('aria-live', 'polite');
    host.setAttribute('aria-atomic', 'false');
    dialog.appendChild(host);
  }
  return host;
}

function showToast(text: string, variant: 'error' | 'info' = 'info'): void {
  const host = resolveToastHost();
  if (!host) return;
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
