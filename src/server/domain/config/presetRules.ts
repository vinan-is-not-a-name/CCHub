import { randomUUID } from 'crypto';
import { LaunchPreset } from '../../../shared/protocol.js';
import { assertCondaEnv, assertName, assertText, cleanOptional } from './schema.js';

export interface PresetRulesInput extends Partial<LaunchPreset> {
  id?: string;
  name: string;
}

export interface PresetReferenceCheck {
  serverExists(id: string): boolean;
  profileExists(id: string): boolean;
  proxyExists(id: string): boolean;
}

/**
 * Build a normalized LaunchPreset from a save request. Throws when serverId is
 * missing or unknown, or when anthropicProfileId / proxyId reference a missing
 * entity. Pure — caller supplies the reference checker so this stays decoupled
 * from the store.
 */
export function buildPreset(
  input: PresetRulesInput,
  existing: LaunchPreset | undefined,
  refs: PresetReferenceCheck,
  now: number,
): LaunchPreset {
  const serverId = assertText(input.serverId, 'serverId');
  if (!refs.serverExists(serverId)) throw new Error('server not found');
  if (input.anthropicProfileId && !refs.profileExists(input.anthropicProfileId)) throw new Error('profile not found');
  if (input.proxyId && !refs.proxyExists(input.proxyId)) throw new Error('proxy not found');
  if (input.condaEnv) assertCondaEnv(input.condaEnv);
  return {
    id: existing?.id ?? input.id ?? randomUUID(),
    name: assertName(input.name),
    serverId,
    cwd: assertText(input.cwd, 'cwd'),
    anthropicProfileId: cleanOptional(input.anthropicProfileId),
    condaEnv: cleanOptional(input.condaEnv),
    resume: cleanOptional(input.resume) as 'continue' | undefined,
    skipPermissions: input.skipPermissions === true || undefined,
    proxyId: cleanOptional(input.proxyId),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}
