import type { SafeConfigSnapshot, SessionInfo, SessionState } from '../shared/protocol.js';
import type { TerminalHandle } from './views/terminal.js';
import type { LayoutMode } from './views/layout.js';
import { DEFAULT_LAYOUT } from './views/layout.js';

export interface ClientSession {
  info: SessionInfo;
  pane: HTMLDivElement;
  body: HTMLDivElement;
  terminal: TerminalHandle;
  attached: boolean;
}

export interface UiState {
  selectedProfileId: string;
  selectedServerId: string;
  selectedPresetId: string;
  selectedProxyId: string;
  profileMode: 'create' | 'edit';
  serverMode: 'create' | 'edit';
  presetMode: 'create' | 'edit';
  proxyMode: 'create' | 'edit';
  preserveLaunchValues: boolean;
  layoutMode: LayoutMode;
}

export interface AppState {
  config: SafeConfigSnapshot | null;
  sessions: Map<string, ClientSession>;
  activeId: string | null;
  ui: UiState;
  creatingSession: boolean;
}

type Listener = (state: AppState) => void;

export class Store {
  private state: AppState;
  private listeners = new Set<Listener>();

  constructor(initial: AppState) { this.state = initial; }

  get(): AppState { return this.state; }

  set<K extends keyof AppState>(key: K, value: AppState[K]) {
    this.state = { ...this.state, [key]: value };
    this.notify();
  }

  patchUi(patch: Partial<UiState>) {
    this.state = { ...this.state, ui: { ...this.state.ui, ...patch } };
    this.notify();
  }

  /** Insert a new session. No-op if `id` is already present (the messageRouter
   * deduplicates `session.list` against `addSession` in attach). */
  addSession(id: string, session: ClientSession) {
    if (this.state.sessions.has(id)) return;
    this.state.sessions.set(id, session);
    this.notify();
  }

  /** Move a session to a new position in the Map's insertion order. `toIndex`
   * is the index _after_ removing the source, so `[a,b,c] reorder(a,1)` yields
   * `[b,a,c]`. No-op (no notify) if the id is unknown, the target equals the
   * current index, or the index is out of range. `activeId` is preserved. */
  reorderSession(fromId: string, toIndex: number): void {
    const entries = [...this.state.sessions.entries()];
    const fromIndex = entries.findIndex(([id]) => id === fromId);
    if (fromIndex < 0) return;
    const clamped = Math.max(0, Math.min(entries.length - 1, toIndex));
    if (clamped === fromIndex) return;
    const [entry] = entries.splice(fromIndex, 1);
    entries.splice(clamped, 0, entry!);
    this.state = { ...this.state, sessions: new Map(entries) };
    this.notify();
  }

  /** Remove a session and clear `activeId` if it was the active one. Returns
   * the removed session so callers can dispose terminal resources. */
  removeSession(id: string): ClientSession | undefined {
    const removed = this.state.sessions.get(id);
    if (!removed) return undefined;
    this.state.sessions.delete(id);
    if (this.state.activeId === id) this.state = { ...this.state, activeId: null };
    this.notify();
    return removed;
  }

  updateSession(id: string, patch: Partial<ClientSession>) {
    const s = this.state.sessions.get(id);
    if (!s) return;
    this.state.sessions.set(id, { ...s, ...patch });
    this.notify();
  }

  patchSessionInfo(id: string, info: Partial<SessionInfo>) {
    const s = this.state.sessions.get(id);
    if (!s) return;
    this.state.sessions.set(id, { ...s, info: { ...s.info, ...info } });
    this.notify();
  }

  setSessionState(id: string, state: SessionState) {
    const s = this.state.sessions.get(id);
    if (!s) return;
    this.state.sessions.set(id, { ...s, info: { ...s.info, state } });
    this.notify();
  }

  /** Selectors: encapsulate the optional-config + find pattern that callers
   * would otherwise repeat 20+ times. Return undefined when config has not
   * loaded yet or the id is unknown. */
  getServer(id: string | undefined) {
    if (!id) return undefined;
    return this.state.config?.servers.find(s => s.id === id);
  }
  getProfile(id: string | undefined) {
    if (!id) return undefined;
    return this.state.config?.profiles.find(p => p.id === id);
  }
  getPreset(id: string | undefined) {
    if (!id) return undefined;
    return this.state.config?.presets.find(p => p.id === id);
  }
  getProxy(id: string | undefined) {
    if (!id) return undefined;
    return this.state.config?.proxies.find(p => p.id === id);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const fn of this.listeners) fn(this.state);
  }
}

export function createStore(): Store {
  return new Store({
    config: null,
    sessions: new Map(),
    activeId: null,
    ui: {
      selectedProfileId: '',
      selectedServerId: '',
      selectedPresetId: '',
      selectedProxyId: '',
      profileMode: 'create',
      serverMode: 'create',
      presetMode: 'create',
      proxyMode: 'create',
      preserveLaunchValues: false,
      layoutMode: DEFAULT_LAYOUT,
    },
    creatingSession: false,
  });
}
