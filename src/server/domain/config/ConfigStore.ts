import { createHash } from 'crypto';
import {
  AnthropicEnvProfile,
  LaunchPreset,
  ProxyConfig,
  RecentLaunch,
  SafeConfigSnapshot,
  ServerProfile,
} from '../../../shared/protocol.js';
import { RECENT_LAUNCH_MAX, StoredConfig } from './schema.js';
import { ConfigRepository } from './ConfigRepository.js';
import { createEmptyConfig, normalizeConfig } from './migrate.js';
import { toSnapshot } from './Snapshot.js';

export interface RecordLaunchInput {
  presetId?: string;
  serverId?: string;
  profileId?: string;
  proxyId?: string;
  cwd?: string;
  condaEnv?: string;
  resume?: 'continue';
  skipPermissions?: boolean;
  effort?: string;
  /** Name to fall back on when the preset is later deleted / renamed. Live
   * chip rendering prefers the live preset name via id lookup. */
  presetNameSnapshot: string;
}

export interface ConfigSeeder {
  /** Hook invoked exactly once when the repository creates a fresh config. */
  onFirstCreate(initial: StoredConfig): StoredConfig;
}

const NOOP_SEEDER: ConfigSeeder = { onFirstCreate: (data) => data };

/**
 * Owns the in-memory `StoredConfig`, persistence, snapshot building, and the
 * single `upsert` primitive. Callers (rules + facade) read via `getX/listX` and
 * write via `mutate(fn)`. Pure of process env — env-driven seeding stays in
 * `ConfigSeeder` (see bootstrap.ts).
 */
export class ConfigStore {
  private data: StoredConfig;

  constructor(private readonly repo: ConfigRepository, defaultCwd: string, seeder: ConfigSeeder = NOOP_SEEDER) {
    const { data, created } = repo.loadOrCreate(() => createEmptyConfig(defaultCwd));
    let next = normalizeConfig(data, defaultCwd);
    if (created) {
      next = seeder.onFirstCreate(next);
      repo.save(next);
    }
    this.data = next;
  }

  getSnapshot(): SafeConfigSnapshot { return toSnapshot(this.data); }
  getDefaults() { return this.data.defaults; }

  getProfile(id?: string): AnthropicEnvProfile | undefined {
    return id ? this.data.profiles.find(p => p.id === id) : undefined;
  }
  listProfiles() { return this.data.profiles; }

  getServer(id?: string): ServerProfile | undefined {
    return id ? this.data.servers.find(s => s.id === id) : undefined;
  }
  listServers() { return this.data.servers; }

  getPreset(id?: string): LaunchPreset | undefined {
    return id ? this.data.presets.find(p => p.id === id) : undefined;
  }
  listPresets() { return this.data.presets; }

  getProxy(id?: string): ProxyConfig | undefined {
    return id ? this.data.proxies.find(p => p.id === id) : undefined;
  }
  listProxies() { return this.data.proxies; }

  /** Run a mutation against the in-memory store, then persist atomically. */
  mutate(fn: (data: StoredConfig) => void): void {
    fn(this.data);
    this.repo.save(this.data);
  }

  /** Insert-or-replace by id. Used by every save* path. */
  upsert<K extends 'profiles' | 'servers' | 'presets' | 'proxies'>(key: K, item: StoredConfig[K][number]): void {
    const list = this.data[key] as Array<{ id: string }>;
    const index = list.findIndex(x => x.id === item.id);
    if (index >= 0) list[index] = item;
    else list.push(item);
  }

  /** Record a successful launch. Same-identity re-launch collapses to a single
   * entry with bumped `lastUsedAt`; new identity is prepended, and the list is
   * capped so the oldest entry is evicted when it overflows. Sort is DESC by
   * `lastUsedAt`, so the list is always ready to render as-is. */
  recordRecentLaunch(input: RecordLaunchInput, now = Date.now()): void {
    const key = computeRecentKey(input);
    const entry: RecentLaunch = {
      key,
      presetId: input.presetId,
      serverId: input.serverId,
      profileId: input.profileId,
      proxyId: input.proxyId,
      cwd: input.cwd,
      condaEnv: input.condaEnv,
      resume: input.resume,
      skipPermissions: input.skipPermissions,
      effort: input.effort,
      presetNameSnapshot: input.presetNameSnapshot,
      lastUsedAt: now,
    };
    const kept = this.data.recentLaunches.filter(r => r.key !== key);
    kept.unshift(entry);
    this.data.recentLaunches = kept.slice(0, RECENT_LAUNCH_MAX);
    this.repo.save(this.data);
  }

  forgetRecentLaunch(key: string): void {
    const before = this.data.recentLaunches.length;
    this.data.recentLaunches = this.data.recentLaunches.filter(r => r.key !== key);
    if (this.data.recentLaunches.length !== before) this.repo.save(this.data);
  }

  clearRecentLaunches(): void {
    if (this.data.recentLaunches.length === 0) return;
    this.data.recentLaunches = [];
    this.repo.save(this.data);
  }

  getAppSettings() { return this.data.appSettings; }

  /** Merge `input` into stored appSettings. Undefined fields in `input` leave
   * the stored value alone; explicit empty string clears the field (falls
   * back to a bare exe name at spawn time). Persists on every call — the
   * Settings dialog only writes on Save, so this is not hot. */
  mutateAppSettings(input: Partial<{ xshellPath: string; xftpPath: string; vscodePath: string }>): void {
    if ('xshellPath' in input) {
      const value = (input.xshellPath ?? '').trim();
      if (value) this.data.appSettings.xshellPath = value;
      else delete this.data.appSettings.xshellPath;
    }
    if ('xftpPath' in input) {
      const value = (input.xftpPath ?? '').trim();
      if (value) this.data.appSettings.xftpPath = value;
      else delete this.data.appSettings.xftpPath;
    }
    if ('vscodePath' in input) {
      const value = (input.vscodePath ?? '').trim();
      if (value) this.data.appSettings.vscodePath = value;
      else delete this.data.appSettings.vscodePath;
    }
    this.repo.save(this.data);
  }
}

/** Stable identity hash: the same combination of preset/server/profile/cwd/
 * conda/resume/proxy collapses to one recent entry. Uses `\x00` as a field
 * separator so `'foo'+''` and `''+'foo'` never alias, and sha1 truncated to
 * 16 hex chars (64 bits) — plenty of collision headroom for ≤20 entries. */
function computeRecentKey(input: RecordLaunchInput): string {
  const parts = [
    input.presetId ?? '',
    input.serverId ?? '',
    input.profileId ?? '',
    input.proxyId ?? '',
    input.cwd ?? '',
    input.condaEnv ?? '',
    input.resume ?? '',
    input.skipPermissions ? '1' : '',
    input.effort ?? '',
  ].join('\x00');
  return createHash('sha1').update(parts).digest('hex').slice(0, 16);
}
