import {
  AnthropicEnvProfile,
  SafeAnthropicEnvProfile,
  SafeConfigSnapshot,
  SafeServerProfile,
  ServerProfile,
} from '../../../shared/protocol.js';
import { StoredConfig } from './schema.js';

/** Alphabetical by name (numeric-aware), stable so equal names keep config
 * order. One sort here covers every consumer: the launch-dialog dropdowns,
 * the config dialog lists, everywhere a snapshot is rendered. RecentLaunches
 * is deliberately NOT sorted — it is a recency-ordered list by contract. */
const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { numeric: true });

export function toSnapshot(data: StoredConfig): SafeConfigSnapshot {
  return {
    profiles: data.profiles.map(maskProfile).sort(byName),
    servers: data.servers.map(maskServer).sort(byName),
    presets: data.presets.sort(byName),
    proxies: data.proxies.sort(byName),
    defaults: data.defaults,
    recentLaunches: data.recentLaunches,
    appSettings: data.appSettings,
  };
}

export function maskProfile(profile: AnthropicEnvProfile): SafeAnthropicEnvProfile {
  const { ANTHROPIC_AUTH_TOKEN, ...env } = profile.env;
  return {
    id: profile.id,
    name: profile.name,
    env,
    hasAuthToken: Boolean(ANTHROPIC_AUTH_TOKEN),
    authTokenPreview: previewSecret(ANTHROPIC_AUTH_TOKEN),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

export function maskServer(server: ServerProfile): SafeServerProfile {
  if (server.kind === 'local') return server;
  return {
    ...server,
    auth: {
      method: server.auth.method,
      hasPassword: Boolean(server.auth.password),
      passwordPreview: previewSecret(server.auth.password),
      privateKeyPath: server.auth.privateKeyPath,
    },
  };
}

function previewSecret(value?: string): string | undefined {
  if (!value) return undefined;
  if (value.length <= 8) return '********';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
