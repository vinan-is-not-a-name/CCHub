import type {
  LaunchOverrides,
  SessionInfo,
  SessionState,
  SessionTarget,
} from './domain.js';
import type {
  CondaEnvEntry,
  DirectoryEntry,
  PresetWriteRequest,
  ProfileWriteRequest,
  ProxyWriteRequest,
  SafeConfigSnapshot,
  ServerWriteRequest,
  TerminalSnapshot,
} from './dto.js';

export type ClientMessage =
  // session lifecycle
  | { type: 'auth'; token?: string }
  | { type: 'input'; id?: string; data: string }
  | { type: 'resize'; id?: string; cols: number; rows: number }
  | { type: 'session.create'; cwd?: string; resume?: string; cols?: number; rows?: number; target?: SessionTarget; presetId?: string; launch?: LaunchOverrides }
  | { type: 'session.attach'; id: string; history?: boolean; focus?: boolean }
  | { type: 'session.destroy'; id: string }
  // Persist the user's drag-to-reorder (pane heads in grid modes; rail tabs
  // in tabs mode) to the server so it survives a page refresh. `toIndex` is
  // the position AFTER removing `id` from the current order, matching
  // Store.reorderSession on the client so both sides stay in lock-step.
  // Fire-and-forget — the client already applied it optimistically; a
  // subsequent session.list on reconnect echoes the new order.
  | { type: 'session.reorder'; id: string; toIndex: number }
  | { type: 'session.list' }
  // Fire-and-forget: open a session's cwd. `app` picks the target application:
  //   - 'files' (or omitted): local file browser — the historical behavior;
  //     only valid for local sessions
  //   - 'xshell': generate a one-shot .xsh and hand it to XShell; SSH sessions
  //     only
  //   - 'xftp':   spawn XFTP with an sftp:// URL that lands in the remote cwd;
  //     SSH sessions only
  //   - 'vscode': launch VS Code at the cwd; local opens directly, SSH uses
  //     the Remote-SSH extension via `--remote ssh-remote+user@host`
  //   - 'cmd' / 'cmd-admin' / 'powershell' / 'powershell-admin': pop a new
  //     Windows console at the cwd. Local sessions only; the admin variants
  //     go through PowerShell's `Start-Process -Verb RunAs` so the user sees
  //     a UAC prompt.
  // Silent by design — the click is a convenience, so mismatched (id/target/app)
  // requests drop rather than paging the user with an error toast.
  | { type: 'shell.reveal'; id: string; app?: 'files' | 'xshell' | 'xftp' | 'vscode' | 'cmd' | 'cmd-admin' | 'powershell' | 'powershell-admin' }
  // config CRUD
  | { type: 'config.get' }
  // App-level preferences (XShell / XFTP paths). Explicit empty string clears
  // a field; omitted fields keep the stored value. Server responds with a
  // fresh config.snapshot.
  | { type: 'config.settings.save'; xshellPath?: string; xftpPath?: string; vscodePath?: string }
  // Ask the server to auto-detect exe paths (PATH + Program Files scan).
  // Response is config.settings.detected — the client fills the dialog inputs
  // from it and may then choose to Save. requestId lets the client match a
  // response to the click that triggered it in case of racy re-clicks.
  | { type: 'config.settings.detect'; requestId: string }
  | { type: 'config.profile.save'; profile: ProfileWriteRequest }
  | { type: 'config.profile.delete'; id: string }
  | { type: 'config.profile.copy'; id: string }
  | { type: 'config.profile.test'; profile: Pick<ProfileWriteRequest, 'id' | 'name' | 'baseUrl' | 'authToken' | 'model'>; requestId: string }
  | { type: 'config.server.save'; server: ServerWriteRequest }
  | { type: 'config.server.delete'; id: string }
  | { type: 'config.server.copy'; id: string }
  | { type: 'config.preset.save'; preset: PresetWriteRequest }
  | { type: 'config.preset.delete'; id: string }
  | { type: 'config.preset.copy'; id: string }
  | { type: 'config.proxy.save'; proxy: ProxyWriteRequest }
  | { type: 'config.proxy.delete'; id: string }
  | { type: 'config.proxy.copy'; id: string }
  // recent launches (quick-access dropdown in the topbar)
  | { type: 'launch.recent.forget'; key: string }
  | { type: 'launch.recent.clear' }
  // discovery
  | { type: 'launch.cwd.list'; serverId?: string; path: string; requestId: string; exact?: boolean; includeFiles?: boolean }
  // Create a single new sub-directory `name` under `parent` on the target
  // server, then (client-side) reload the listing. `name` is validated on both
  // ends via isValidFolderName so it stays one traversal-safe segment.
  | { type: 'launch.cwd.mkdir'; serverId?: string; parent: string; name: string; requestId: string }
  | { type: 'launch.conda.list'; serverId?: string; requestId: string };

/** Periodic host-resource snapshot pushed to every authenticated client for
 * the topbar CPU/memory pill. Not opt-in: at cchub's scale (single-user,
 * one open tab is the norm) subscription bookkeeping isn't worth the
 * complexity. Emit cadence is 2s — see MetricsCollector.INTERVAL_MS. See
 * MetricsSnapshot for units. */
export interface MetricsSnapshotMsg {
  type: 'metrics.snapshot';
  ts: number;
  cpuCount: number;
  memTotalBytes: number;
  total: { cpuPct: number; memBytes: number };
  main: { cpuPct: number; memBytes: number };
  sessions: {
    id: string;
    /** Human-readable session name — preset name when the launch had one,
     * else the raw `${server}:${cwd}` path so a preset-less session still
     * shows something identifying. */
    label: string;
    /** Optional subordinate detail (typically `${server}:${cwd}`) surfaced
     * as a tooltip on the row name when `label` is a preset name. */
    sub?: string;
    /** `null` for SSH sessions (no local pid to sample) or when the pid
     * died mid-tick. Client renders "N/A" for null. */
    pid: number | null;
    cpuPct: number | null;
    memBytes: number | null;
  }[];
}

export type ServerMessage =
  // session events
  | { type: 'output'; id: string; data: string }
  | { type: 'state'; id: string; state: SessionState }
  // Sent immediately after the server's imagePaths[] grows, i.e. right before
  // the corresponding bracketed-paste is written to the PTY. The client uses
  // this to bind buffer occurrences of `[Image #N]` back to the 1-based server
  // index — see `client/views/imageLinks.ts` for the contract.
  | { type: 'image.fed'; id: string; imageIndex: number }
  | { type: 'notify.hook'; id: string; kind: string }
  | { type: 'session.created'; session: SessionInfo }
  | { type: 'session.attached'; session: SessionInfo; snapshot?: TerminalSnapshot }
  | { type: 'session.destroyed'; id: string }
  | { type: 'session.list'; sessions: SessionInfo[] }
  | { type: 'session.exit'; id: string; code: number | null }
  // auth
  | { type: 'auth.ok' }
  // config
  | { type: 'config.snapshot'; config: SafeConfigSnapshot }
  | { type: 'config.profile.saved'; config: SafeConfigSnapshot; selectedId?: string }
  | { type: 'config.server.saved'; config: SafeConfigSnapshot; selectedId?: string }
  | { type: 'config.preset.saved'; config: SafeConfigSnapshot; selectedId?: string }
  | { type: 'config.proxy.saved'; config: SafeConfigSnapshot; selectedId?: string }
  | { type: 'config.profile.test.result'; requestId: string; ok: boolean; message: string }
  // Response to config.settings.detect. null fields mean "not found — user
  // needs to type a path manually in the Settings dialog".
  | { type: 'config.settings.detected'; requestId: string; xshellPath: string | null; xftpPath: string | null; vscodePath: string | null }
  // Fired when a shell.reveal side-effect can't be carried out (helper exe
  // missing on disk, spawn ENOENT, etc.). Client renders a toast; the app
  // name lets it phrase the message ("Couldn't open XShell — …").
  | { type: 'shell.reveal.error'; app: 'files' | 'xshell' | 'xftp' | 'vscode' | 'cmd' | 'cmd-admin' | 'powershell' | 'powershell-admin'; message: string }
  // discovery results
  | { type: 'launch.cwd.list.result'; requestId: string; path: string; entries: DirectoryEntry[] }
  // Result of launch.cwd.mkdir. `ok:false` carries a human-readable `error`
  // (already-exists, permission denied, invalid name) for a toast; `ok:true`
  // returns the created directory's full `path` so the client can navigate in.
  | { type: 'launch.cwd.mkdir.result'; requestId: string; ok: boolean; path?: string; error?: string }
  | { type: 'launch.conda.list.result'; requestId: string; envs: CondaEnvEntry[]; error?: string }
  // Host-resource pill for the topbar. See MetricsSnapshotMsg.
  | MetricsSnapshotMsg
  // catch-all
  | { type: 'error'; message: string; code?: string; sourceType?: string };
