import {
  LaunchPreset,
  ServerProfile,
} from '../../../shared/protocol.js';
import { StoredConfig, defaultOsFor } from './schema.js';

/**
 * Schema migration: backfill missing fields, drop legacy ones.
 * Pure given `defaultCwd` — the caller injects it rather than this module
 * reading `process.cwd()`, keeping the domain layer free of process state.
 */
export function normalizeConfig(data: StoredConfig, defaultCwd: string): StoredConfig {
  // Backfill servers: drop legacy `defaultCwd`, default `os`.
  const rawServers = data.servers?.length ? data.servers : createEmptyConfig(defaultCwd).servers;
  const servers: ServerProfile[] = rawServers.map((s: any) => {
    const { defaultCwd: _legacyCwd, ...rest } = s;
    return { ...rest, os: rest.os ?? defaultOsFor(rest.kind) } as ServerProfile;
  });
  const defaultServerId = data.defaults?.serverId ?? servers[0]?.id;
  // Backfill presets: drop ones still missing required fields.
  const rawPresets = data.presets?.length ? data.presets : createEmptyConfig(defaultCwd).presets;
  const presets: LaunchPreset[] = rawPresets
    .map((p: any) => {
      const serverId = p.serverId ?? defaultServerId;
      const cwd = p.cwd ?? '';
      if (!serverId || !cwd) return null;
      return { ...p, serverId, cwd } as LaunchPreset;
    })
    .filter((p: LaunchPreset | null): p is LaunchPreset => p !== null);
  return {
    version: 1,
    profiles: data.profiles ?? [],
    servers,
    presets,
    proxies: data.proxies ?? [],
    defaults: data.defaults ?? {},
    recentLaunches: data.recentLaunches ?? [],
    // Older configs predate appSettings; backfill as an empty object so
    // ConfigService can always read .appSettings.foo without a null check.
    appSettings: data.appSettings ?? {},
  };
}

/**
 * Brand-new install: a single `local-default` server and a `Default` preset.
 * `defaultCwd` is injected by the entry layer (e.g. `process.cwd()`) so this
 * stays pure. Env-driven SSH seeding lives in bootstrap.ts.
 */
export function createEmptyConfig(defaultCwd: string): StoredConfig {
  const now = Date.now();
  const localServer: ServerProfile = {
    id: 'local-default',
    name: 'Local',
    kind: 'local',
    os: defaultOsFor('local'),
    createdAt: now,
    updatedAt: now,
  };
  const preset: LaunchPreset = {
    id: 'default',
    name: 'Default',
    serverId: localServer.id,
    cwd: defaultCwd,
    resume: 'continue',
    createdAt: now,
    updatedAt: now,
  };
  return {
    version: 1,
    profiles: [],
    servers: [localServer],
    presets: [preset],
    proxies: [],
    defaults: { serverId: localServer.id, presetId: preset.id },
    recentLaunches: [],
    appSettings: {},
  };
}
