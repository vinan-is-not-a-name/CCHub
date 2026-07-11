import { platform } from 'os';
import {
  AnthropicEnv,
  AnthropicEnvProfile,
  ANTHROPIC_ENV_KEYS,
  AppSettings,
  LaunchPreset,
  ProxyConfig,
  RecentLaunch,
  ServerOs,
  ServerProfile,
} from '../../../shared/protocol.js';

export interface StoredConfig {
  version: 1;
  profiles: AnthropicEnvProfile[];
  servers: ServerProfile[];
  presets: LaunchPreset[];
  proxies: ProxyConfig[];
  defaults: {
    profileId?: string;
    serverId?: string;
    presetId?: string;
  };
  recentLaunches: RecentLaunch[];
  /** User-scoped app preferences (XShell / XFTP exe paths, etc.). Optional
   * fields inside; the object itself is always present after migration.
   * Belongs to the server-host machine's config because that's where these
   * executables live and where reveal-time spawns happen (single-user
   * local-first model). */
  appSettings: AppSettings;
}

/** How many past launches to keep in the topbar dropdown. Cap chosen small
 * enough that the whole list fits under an eye-scan without scrolling, and
 * large enough that a real user's mix of ~6 daily presets survives idle
 * days. Not user-configurable — increasing costs one line of code. */
export const RECENT_LAUNCH_MAX = 20;

export function assertName(value: string): string {
  return assertText(value, 'name').slice(0, 80);
}

export function assertText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

export function assertPort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('invalid port');
  return value;
}

export function assertCondaEnv(value: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error('invalid conda env');
}

export function cleanOptional(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function sanitizeAnthropicEnv(input: AnthropicEnv): AnthropicEnv {
  const env: AnthropicEnv = {};
  for (const key of ANTHROPIC_ENV_KEYS) {
    const value = cleanOptional(input[key]);
    if (value) env[key] = value;
  }
  return env;
}

/**
 * Default OS for server-side operations (bootstrap, migration). Uses Node's
 * platform() which reflects the server process host. Client-side new-server
 * form uses a parallel defaultOsForBrowser() based on navigator.userAgent.
 */
export function defaultOsFor(kind: 'local' | 'ssh'): ServerOs {
  if (kind === 'ssh') return 'linux';
  if (platform() === 'win32') return 'windows';
  if (platform() === 'darwin') return 'macos';
  return 'linux';
}
