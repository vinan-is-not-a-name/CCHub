import {
  AnthropicEnvProfile,
  SafeAnthropicEnvProfile,
  SafeConfigSnapshot,
  SafeServerProfile,
  ServerProfile,
} from '../../../shared/protocol.js';
import { StoredConfig } from './schema.js';

export function toSnapshot(data: StoredConfig): SafeConfigSnapshot {
  return {
    profiles: data.profiles.map(maskProfile),
    servers: data.servers.map(maskServer),
    presets: data.presets,
    proxies: data.proxies,
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
