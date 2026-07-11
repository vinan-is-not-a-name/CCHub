import { LaunchPreset, ServerProfile, SshServerProfile } from '../../../shared/protocol.js';
import { StoredConfig, defaultOsFor } from './schema.js';

export interface SshSeed {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  defaultCwd?: string;
  /** When defaultTarget === 'ssh', the seeded ssh server becomes the defaults.serverId */
  preferred: boolean;
}

/**
 * Apply env-driven SSH seed to a freshly-created config. Idempotent for first-run only —
 * this is NOT called on subsequent loads, so deleting the seeded server in the UI sticks.
 */
export function seedFromEnv(initial: StoredConfig, seed: SshSeed | undefined): StoredConfig {
  if (!seed) return initial;
  const now = Date.now();
  const sshServer: SshServerProfile = {
    id: 'ssh-default',
    name: seed.host,
    kind: 'ssh',
    os: defaultOsFor('ssh'),
    host: seed.host,
    port: seed.port,
    username: seed.username,
    auth: seed.password
      ? { method: 'password', password: seed.password }
      : { method: 'privateKeyPath', privateKeyPath: seed.privateKeyPath },
    createdAt: now,
    updatedAt: now,
  };
  const servers: ServerProfile[] = [...initial.servers, sshServer];
  const defaults = { ...initial.defaults };
  let presets = initial.presets;
  if (seed.preferred) {
    defaults.serverId = sshServer.id;
    // Replace the auto-created Default preset to point at SSH if it still has the local default.
    presets = presets.map(preset => preset.id === 'default'
      ? { ...preset, serverId: sshServer.id, cwd: seed.defaultCwd ?? '~', updatedAt: now } as LaunchPreset
      : preset);
  }
  return { ...initial, servers, presets, defaults };
}
