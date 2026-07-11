import type { RecentLaunch, SessionState } from '../shared/protocol.js';
import type { LayoutMode } from './views/layout.js';

type Handler<T> = (payload: T) => void;

export interface BusEventMap {
  'session:activate': string;
  /** Fired on every keystroke into a session terminal. */
  'session:interacted': string;
  /** Fired when the client receives a `session.attached` (initial mount or
   * WS reconnect). Carries the state reported by the server AT that moment.
   * messageRouter emits this before patchSessionInfo so consumers can align
   * their baseline to the freshly attested state before the store fires. */
  'session:resync': { id: string; state: SessionState };
  'launch:open': void;
  /** Open the launch dialog with a RecentLaunch's fields pre-filled so the
   * user can tweak (e.g. change cwd) before submitting. Kept separate from
   * 'launch:open' so the void-payload signature stays intact. */
  'launch:prefill': { recent: RecentLaunch };
  /** Re-launch a RecentLaunch verbatim, no dialog. Skips form validation
   * entirely — the recorded identity already resolved successfully once. */
  'launch:relaunch': { recent: RecentLaunch };
  'launch:create': { presetId?: string; serverId: string; profileId: string; cwd: string; condaEnv: string; resume: string };
  /** Open the directory/file picker against a server, seeded with whatever
   * the target input currently holds. `mode` defaults to 'directory' (the
   * launch-dialog cwd flow); pass 'file' to include regular files in the
   * listing and short-circuit selection on a single click (used by the
   * Settings dialog to pick XShell/XFTP exe paths). */
  'launch:select-cwd': { targetInput: string; serverId: string; mode?: 'directory' | 'file' };
  'config:open': void;
  'settings:open': void;
  'layout:change': LayoutMode;
}

export class Bus {
  private listeners = new Map<keyof BusEventMap, Set<Handler<any>>>();

  on<K extends keyof BusEventMap>(event: K, handler: Handler<BusEventMap[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set); }
    set.add(handler);
    return () => set!.delete(handler);
  }

  emit<K extends keyof BusEventMap>(event: K, ...args: BusEventMap[K] extends void ? [] : [BusEventMap[K]]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    const payload = args[0] as BusEventMap[K];
    for (const fn of set) fn(payload);
  }
}
