import type { AnthropicEnvKey } from './envKeys.js';

/** Where a session runs. */
export type SessionTarget = 'local' | 'ssh';

/** OS of the target machine — used to pick a shell adapter. */
export type ServerOs = 'windows' | 'linux' | 'macos';

export type AnthropicEnv = Partial<Record<AnthropicEnvKey, string>>;

export interface AnthropicEnvProfile {
  id: string;
  name: string;
  env: AnthropicEnv;
  createdAt: number;
  updatedAt: number;
}

export type ServerProfile = LocalServerProfile | SshServerProfile;

export interface LocalServerProfile {
  id: string;
  name: string;
  kind: 'local';
  os: ServerOs;
  createdAt: number;
  updatedAt: number;
}

export interface SshServerProfile {
  id: string;
  name: string;
  kind: 'ssh';
  os: ServerOs;
  host: string;
  port: number;
  username: string;
  auth: {
    method: 'password' | 'privateKeyPath';
    password?: string;
    privateKeyPath?: string;
  };
  createdAt: number;
  updatedAt: number;
}

/** SSH reverse-tunnel proxy: binds `127.0.0.1:bindPort` on the remote host and
 * forwards back to a `host:port` proxy reachable from the cchub side
 * (equivalent to `ssh -R bindPort:host:port`). Only meaningful for SSH targets.
 * This is the runtime tunnel shape consumed by the connector — `ProxyConfig` is
 * the stored, named entity that resolves down to one of these. */
export interface ProxyTunnel {
  bindPort: number;
  host: string;
  port: number;
}

/** A stored, reusable proxy definition — a first-class config entity (like a
 * profile or server) that presets reference by id. Carries the tunnel shape
 * plus identity/timestamps. No secrets, so it crosses to the client unmasked. */
export interface ProxyConfig extends ProxyTunnel {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface LaunchPreset {
  id: string;
  name: string;
  serverId: string;
  cwd: string;
  anthropicProfileId?: string;
  condaEnv?: string;
  resume?: 'continue';
  /** Append `--dangerously-skip-permissions` to the claude launch. */
  skipPermissions?: boolean;
  /** References a ProxyConfig by id. Resolved to a tunnel only for SSH targets. */
  proxyId?: string;
  /** Optional `/effort` level auto-submitted to Claude Code on session start. */
  effort?: string;
  createdAt: number;
  updatedAt: number;
}

export interface LaunchOverrides {
  serverId?: string;
  anthropicProfileId?: string;
  cwd?: string;
  condaEnv?: string;
  resume?: string;
}

/** A fully resolved launch — pure data, no behavior. The application layer
 * produces it; infrastructure (shell/connector) consumes it. Lives here so both
 * sides depend downward on shared rather than infrastructure→application. */
export interface ResolvedLaunch {
  server: ServerProfile;
  cwd: string;
  env: Record<string, string>;
  resume?: string;
  condaEnv?: string;
  skipPermissions?: boolean;
  /** SSH reverse-tunnel proxy; only set for SSH targets (resolveLaunch drops it
   * for local). The connector establishes the tunnel; the proxy env is already
   * baked into `env` by then. */
  proxy?: ProxyTunnel;
  /** Preset's effort level — written to the PTY as `/effort <value>` after
   * the channel spawns so Claude Code picks it up on first prompt. */
  effort?: string;
  serverName: string;
  profileName?: string;
  presetName?: string;
  label: string;
}

export type SessionState = 'idle' | 'processing' | 'awaiting_approval' | 'exited';

/** A prior successful launch, kept so the topbar can offer one-click re-launch.
 * `key` is a stable hash of the identity slots — same identity collapses to one
 * entry with `lastUsedAt` bumped. Names are snapshots so a chip can still show
 * something after the underlying preset/server/profile was renamed or deleted;
 * live lookup by id wins when the id still resolves. */
export interface RecentLaunch {
  key: string;
  presetId?: string;
  serverId?: string;
  profileId?: string;
  proxyId?: string;
  cwd?: string;
  condaEnv?: string;
  resume?: 'continue';
  presetNameSnapshot: string;
  lastUsedAt: number;
}

export interface SessionInfo {
  id: string;
  state: SessionState;
  cwd: string;
  createdAt: number;
  target: SessionTarget;
  label: string;
  serverName?: string;
  profileName?: string;
  presetName?: string;
}

/** App-level preferences the server holds on behalf of the (single) user.
 * cchub is single-user local-first, so these paths refer to executables on
 * the server-host machine (which is the user's own workstation under the
 * intended deployment). Optional throughout: unset means "auto-detect at
 * reveal time" or "user hasn't configured yet". */
export interface AppSettings {
  /** Absolute path to `Xshell.exe`. When set, revealXshell prefers it over
   * relying on PATH resolution. */
  xshellPath?: string;
  /** Absolute path to `Xftp.exe`. Same story as xshellPath. */
  xftpPath?: string;
  /** Absolute path to VS Code's launcher (`Code.exe`, `code.cmd`, or the
   * Linux/mac `code` script). When set, revealVscode prefers it over PATH.
   * The launcher — not `Code.exe` — is what attaches to a running window and
   * routes `--remote ssh-remote+...` at the right process. */
  vscodePath?: string;
}
