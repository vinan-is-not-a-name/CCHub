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

export interface TerminalSnapshot {
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
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
