import {
  AnthropicEnvProfile,
  LaunchPreset,
  ProxyConfig,
  SafeConfigSnapshot,
  ServerProfile,
  SessionTarget,
} from '../../../shared/protocol.js';
import { ConfigRepository } from './ConfigRepository.js';
import { ConfigSeeder, ConfigStore, RecordLaunchInput } from './ConfigStore.js';
import { buildProfile, ProfileRulesInput } from './profileRules.js';
import { buildServer, ServerRulesInput } from './serverRules.js';
import { buildPreset, PresetRulesInput } from './presetRules.js';
import { buildProxy, ProxyRulesInput } from './proxyRules.js';

export interface ServerResolution {
  /** First defined id wins (e.g. [launchOverride, preset, defaults]). */
  preferredIds?: Array<string | undefined>;
  /** Used only when none of `preferredIds` is defined. Falls back to the first server of this kind, then the first server overall. */
  fallbackTarget?: SessionTarget;
}

export interface CopiedConfig {
  config: SafeConfigSnapshot;
  selectedId: string;
}

/**
 * Coordinates rule modules with the storage layer. Stays thin so that adding a
 * new entity type means: add `xRules.ts` + 2 facade methods.
 */
export class ConfigService {
  private readonly store: ConfigStore;

  constructor(repo: ConfigRepository, defaultCwd: string, seeder?: ConfigSeeder) {
    this.store = new ConfigStore(repo, defaultCwd, seeder);
  }

  getSnapshot(): SafeConfigSnapshot { return this.store.getSnapshot(); }
  getDefaults() { return this.store.getDefaults(); }

  getProfile(id?: string): AnthropicEnvProfile | undefined { return this.store.getProfile(id); }
  listProfiles() { return this.store.listProfiles(); }
  getServer(id?: string): ServerProfile | undefined { return this.store.getServer(id); }
  listServers() { return this.store.listServers(); }
  getPreset(id?: string): LaunchPreset | undefined { return this.store.getPreset(id); }
  listPresets() { return this.store.listPresets(); }
  getProxy(id?: string): ProxyConfig | undefined { return this.store.getProxy(id); }
  listProxies() { return this.store.listProxies(); }

  /**
   * Single source of truth for "which server should run this session?".
   * Walks `preferredIds` in order; the first one that resolves wins.
   * If none resolves, falls back to the first server matching `fallbackTarget`,
   * then the first server overall. Throws when zero servers are configured or
   * when an explicit id is unknown.
   */
  resolveServer(opts: ServerResolution = {}): ServerProfile {
    for (const id of opts.preferredIds ?? []) {
      if (!id) continue;
      const server = this.store.getServer(id);
      if (!server) throw new Error('server not found');
      return server;
    }
    const all = this.store.listServers();
    const byTarget = opts.fallbackTarget ? all.find(s => s.kind === opts.fallbackTarget) : undefined;
    const server = byTarget ?? all[0];
    if (!server) throw new Error('no server configured');
    return server;
  }

  saveProfile(input: ProfileRulesInput): SafeConfigSnapshot {
    const existing = this.store.getProfile(input.id);
    const profile = buildProfile(input, existing, Date.now());
    assertUniqueName(this.store.listProfiles(), profile.name, profile.id);
    this.store.mutate(() => this.store.upsert('profiles', profile));
    return this.store.getSnapshot();
  }

  copyProfile(id: string): CopiedConfig {
    const source = this.store.getProfile(id);
    if (!source) throw new Error('profile not found');
    const name = copyName(source.name, this.store.listProfiles());
    const config = this.saveProfile({ name, env: source.env });
    return { config, selectedId: copiedId(config.profiles, name) };
  }

  deleteProfile(id: string): SafeConfigSnapshot {
    if (this.store.listPresets().some(p => p.anthropicProfileId === id)) throw new Error('profile is used by a preset');
    this.store.mutate((data) => {
      data.profiles = data.profiles.filter(p => p.id !== id);
      if (data.defaults.profileId === id) delete data.defaults.profileId;
    });
    return this.store.getSnapshot();
  }

  saveServer(input: ServerRulesInput): SafeConfigSnapshot {
    const existing = this.store.getServer(input.id);
    const server = buildServer(input, existing, Date.now());
    assertUniqueName(this.store.listServers(), server.name, server.id);
    this.store.mutate(() => this.store.upsert('servers', server));
    return this.store.getSnapshot();
  }

  copyServer(id: string): CopiedConfig {
    const source = this.store.getServer(id);
    if (!source) throw new Error('server not found');
    const name = copyName(source.name, this.store.listServers());
    const config = source.kind === 'local'
      ? this.saveServer({ name, kind: 'local', os: source.os })
      : this.saveServer({
        name,
        kind: 'ssh',
        os: source.os,
        host: source.host,
        port: source.port,
        username: source.username,
        auth: source.auth,
      });
    return { config, selectedId: copiedId(config.servers, name) };
  }

  deleteServer(id: string): SafeConfigSnapshot {
    if (this.store.listPresets().some(p => p.serverId === id)) throw new Error('server is used by a preset');
    this.store.mutate((data) => {
      data.servers = data.servers.filter(s => s.id !== id);
      if (data.defaults.serverId === id) delete data.defaults.serverId;
    });
    return this.store.getSnapshot();
  }

  savePreset(input: PresetRulesInput): SafeConfigSnapshot {
    const existing = this.store.getPreset(input.id);
    const preset = buildPreset(input, existing, {
      serverExists: (id) => Boolean(this.store.getServer(id)),
      profileExists: (id) => Boolean(this.store.getProfile(id)),
      proxyExists: (id) => Boolean(this.store.getProxy(id)),
    }, Date.now());
    assertUniqueName(this.store.listPresets(), preset.name, preset.id);
    this.store.mutate((data) => {
      this.store.upsert('presets', preset);
      if (!data.defaults.presetId) data.defaults.presetId = preset.id;
    });
    return this.store.getSnapshot();
  }

  copyPreset(id: string): CopiedConfig {
    const source = this.store.getPreset(id);
    if (!source) throw new Error('preset not found');
    const name = copyName(source.name, this.store.listPresets());
    const config = this.savePreset({
      name,
      serverId: source.serverId,
      cwd: source.cwd,
      anthropicProfileId: source.anthropicProfileId,
      condaEnv: source.condaEnv,
      resume: source.resume,
      skipPermissions: source.skipPermissions,
      proxyId: source.proxyId,
      effort: source.effort,
    });
    return { config, selectedId: copiedId(config.presets, name) };
  }

  deletePreset(id: string): SafeConfigSnapshot {
    this.store.mutate((data) => {
      data.presets = data.presets.filter(p => p.id !== id);
      if (data.defaults.presetId === id) delete data.defaults.presetId;
    });
    return this.store.getSnapshot();
  }

  saveProxy(input: ProxyRulesInput): SafeConfigSnapshot {
    const existing = this.store.getProxy(input.id);
    const proxy = buildProxy(input, existing, Date.now());
    assertUniqueName(this.store.listProxies(), proxy.name, proxy.id);
    this.store.mutate(() => this.store.upsert('proxies', proxy));
    return this.store.getSnapshot();
  }

  copyProxy(id: string): CopiedConfig {
    const source = this.store.getProxy(id);
    if (!source) throw new Error('proxy not found');
    const name = copyName(source.name, this.store.listProxies());
    const config = this.saveProxy({
      name,
      bindPort: source.bindPort,
      host: source.host,
      port: source.port,
    });
    return { config, selectedId: copiedId(config.proxies, name) };
  }

  deleteProxy(id: string): SafeConfigSnapshot {
    if (this.store.listPresets().some(p => p.proxyId === id)) throw new Error('proxy is used by a preset');
    this.store.mutate((data) => {
      data.proxies = data.proxies.filter(p => p.id !== id);
    });
    return this.store.getSnapshot();
  }

  recordRecentLaunch(input: RecordLaunchInput): SafeConfigSnapshot {
    this.store.recordRecentLaunch(input);
    return this.store.getSnapshot();
  }

  forgetRecentLaunch(key: string): SafeConfigSnapshot {
    this.store.forgetRecentLaunch(key);
    return this.store.getSnapshot();
  }

  clearRecentLaunches(): SafeConfigSnapshot {
    this.store.clearRecentLaunches();
    return this.store.getSnapshot();
  }

  /** Persist app-level preferences (XShell / XFTP paths). Undefined fields
   * are ignored (keep the stored value); an explicit empty string clears
   * that field so revealSsh falls back to bare-exe / PATH lookup. Returning
   * the fresh snapshot lets the WS handler push it verbatim to the client. */
  saveAppSettings(input: Partial<{ xshellPath: string; xftpPath: string; vscodePath: string }>): SafeConfigSnapshot {
    this.store.mutateAppSettings(input);
    return this.store.getSnapshot();
  }

  /** Read raw appSettings for server-side consumers (revealSsh spawn path).
   * Returns the object directly — safe because AppSettings holds no secrets. */
  getAppSettings() { return this.store.getAppSettings(); }
}

function assertUniqueName(items: Array<{ id: string; name: string }>, name: string, selfId: string): void {
  if (items.some(item => item.id !== selfId && item.name === name)) throw new Error('name already exists');
}

function copiedId(items: Array<{ id: string; name: string }>, name: string): string {
  const item = items.find(item => item.name === name);
  if (!item) throw new Error('copied config not found');
  return item.id;
}

function copyName(name: string, siblings: Array<{ name: string }>): string {
  const base = `${name}副本`;
  if (!siblings.some(item => item.name === base)) return base;
  let index = 2;
  while (siblings.some(item => item.name === `${base}${index}`)) index += 1;
  return `${base}${index}`;
}
