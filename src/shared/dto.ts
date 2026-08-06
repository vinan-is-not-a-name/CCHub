import type {
  AnthropicEnv,
  AppSettings,
  LaunchPreset,
  LocalServerProfile,
  ProxyConfig,
  RecentLaunch,
  ServerOs,
  SshServerProfile,
} from './domain.js';

/** Profile shape sent to the client — secrets stripped. */
export interface SafeAnthropicEnvProfile {
  id: string;
  name: string;
  env: Omit<AnthropicEnv, 'ANTHROPIC_AUTH_TOKEN'>;
  hasAuthToken: boolean;
  authTokenPreview?: string;
  createdAt: number;
  updatedAt: number;
}

export type SafeServerProfile = LocalServerProfile | SafeSshServerProfile;

export interface SafeSshServerProfile extends Omit<SshServerProfile, 'auth'> {
  auth: {
    method: 'password' | 'privateKeyPath';
    hasPassword?: boolean;
    passwordPreview?: string;
    privateKeyPath?: string;
  };
}

export interface SafeConfigSnapshot {
  profiles: SafeAnthropicEnvProfile[];
  servers: SafeServerProfile[];
  presets: LaunchPreset[];
  proxies: ProxyConfig[];
  defaults: {
    profileId?: string;
    serverId?: string;
    presetId?: string;
  };
  recentLaunches: RecentLaunch[];
  /** Same shape as stored — AppSettings has no secrets so it round-trips
   * verbatim to the client for display / editing in the Settings dialog. */
  appSettings: AppSettings;
}

export interface ProfileWriteRequest {
  id?: string;
  name: string;
  baseUrl?: string;
  authToken?: string;
  clearAuthToken?: boolean;
  model?: string;
  subagentModel?: string;
  smallFastModel?: string;
}

export interface ServerWriteRequest {
  id?: string;
  name: string;
  kind: 'local' | 'ssh';
  os?: ServerOs;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  clearPassword?: boolean;
  privateKeyPath?: string;
}

export interface PresetWriteRequest {
  id?: string;
  name: string;
  serverId?: string;
  anthropicProfileId?: string;
  cwd?: string;
  condaEnv?: string;
  resume?: 'continue';
  skipPermissions?: boolean;
  proxyId?: string;
  effort?: string;
}

export interface ProxyWriteRequest {
  id?: string;
  name: string;
  bindPort: number;
  host: string;
  port: number;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  /** Distinguishes files from directories in a listing that includes both.
   * Directory-only callers can safely ignore this and treat everything as a
   * subdirectory. Optional in the wire type so older clients that don't send
   * `includeFiles` still parse a server response without the field, but every
   * new producer stamps it. */
  kind?: 'directory' | 'file';
}

export interface CondaEnvEntry {
  name: string;
  path?: string;
}

/**
 * One deduplicated relay site in a balance.result payload.
 *
 * Balance is a property of (baseUrl, authToken), NOT of a provider preset —
 * several presets may share one site (different model / name fields) and must
 * not be queried N times or shown as N rows. The server groups profiles by
 * that pair; `presetNames` lists every preset that maps onto it.
 *
 * Secrets stay server-side: `keyPreview` is the only token-derived field the
 * client ever sees (same mask style as SafeAnthropicEnvProfile).
 */
export interface BalanceSiteView {
  /** Normalized base URL (trailing slashes stripped) — displayed as-is. */
  baseUrl: string;
  keyPreview: string;
  /** Every provider preset (profile) that maps onto this site, in config order. */
  presetNames: string[];
  /** Remaining balance; null when the query failed. */
  remain: number | null;
  /** Total quota; null when the query failed. */
  limit: number | null;
  /** Used quota; null when the query failed. */
  used: number | null;
  /** ISO-4217 currency of the three numbers above — USD for NewAPI relays,
   * CNY for DeepSeek's official endpoint. */
  currency: string;
  /** Human-readable failure reason. Absent on success. Set to 'unsupported'
   * for official Anthropic endpoints, which have no balance API. */
  error?: string;
  /** Server-side wall-clock of the probe, ms epoch. */
  at: number;
}

export interface TerminalSnapshot {
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
  /** Visible buffer tail, one string per row (most-recent 5000 rows). Each
   * string carries inline SGR sequences (`CSI …m`) that reproduce the row's
   * foreground/background/attributes, so a reattach restores cc's colored UI —
   * diff / line-change highlights included — instead of waiting for cc to
   * repaint (which is unreliable over SSH, where a refresh otherwise loses the
   * highlight backgrounds until a resize forces a redraw). A row with no
   * styling is emitted as plain text, byte-identical to what the terminal
   * shows. The client replays these verbatim in loadSnapshot. */
  lines: string[];
  /** DEC private modes the source terminal had enabled when the snapshot
   * was taken, pre-encoded as a `CSI ?N;M;...h` sequence the client can
   * `term.write()` verbatim before replaying `lines`. Preserves alt-screen
   * (`?1049`), mouse tracking (`?1000`/`?1006`), bracketed paste
   * (`?2004`), etc. — without this the client's fresh xterm falls back to
   * defaults on reattach and cc's wheel-forwarding stops working, so the
   * terminal looks unscrollable after every page refresh. Empty when the
   * source terminal never turned on any private modes. */
  modeSetup: string;
}
