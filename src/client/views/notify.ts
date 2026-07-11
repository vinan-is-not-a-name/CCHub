import type { AppDeps } from '../deps.js';
import { sessionLabel } from './sessionLabel.js';

export const NOTIFY_ENABLED_KEY = 'cchub-notify-enabled';
export type NotifyKind = 'ready' | 'approval';

export function isNotifyEnabled(): boolean {
  return localStorage.getItem(NOTIFY_ENABLED_KEY) !== '0';
}

export function setNotifyEnabled(on: boolean): void {
  localStorage.setItem(NOTIFY_ENABLED_KEY, on ? '1' : '0');
}

/**
 * Wire notification delivery into the running app. Returns a `fire` handle
 * that the hook-signal pipeline calls when CC reports turn completion or a
 * permission prompt (see src/server/ws/hookEndpoint.ts).
 *
 * Handles: Notification API permission request (on first pointer gesture),
 * title flashing as a fallback when permission is absent, and clearing the
 * flash when the tab regains focus.
 *
 * Detection of *when* to fire is no longer done here — the CC hook mechanism
 * (`Notification` hook + `Stop`/`StopFailure`) delivers authoritative signals
 * via the server's hook HTTP endpoint → WS push → messageRouter → fire().
 */
export function mountNotifications(deps: AppDeps): { fire(id: string, kind: NotifyKind): void } {
  const { store, bus } = deps;
  const originalTitle = document.title;
  let titleFlashing = false;

  const clearTitleFlash = (): void => {
    if (!titleFlashing) return;
    document.title = originalTitle;
    titleFlashing = false;
  };

  window.addEventListener('focus', clearTitleFlash);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') clearTitleFlash();
  });

  // Browsers require a user gesture for requestPermission. The first
  // pointerdown anywhere on the page satisfies that; remove on first fire.
  const askOnce = (): void => {
    document.removeEventListener('pointerdown', askOnce, true);
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'default') return;
    Notification.requestPermission().catch(() => {});
  };
  document.addEventListener('pointerdown', askOnce, true);

  function fire(id: string, kind: NotifyKind): void {
    if (!isNotifyEnabled()) return;
    const session = store.get().sessions.get(id);
    if (!session) return;
    const label = sessionLabel(session.info);
    const title = kind === 'approval' ? 'CC needs approval' : 'CC ready';

    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        const n = new Notification(title, { body: label, tag: `cc-${id}` });
        n.onclick = () => {
          window.focus();
          bus.emit('session:activate', id);
          n.close();
        };
        return;
      } catch {
        // fall through to title flash
      }
    }
    document.title = `* ${title}: ${label}`;
    titleFlashing = true;
  }

  return { fire };
}
