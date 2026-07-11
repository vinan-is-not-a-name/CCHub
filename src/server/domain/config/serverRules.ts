import { randomUUID } from 'crypto';
import { ServerOs, ServerProfile, SshServerProfile } from '../../../shared/protocol.js';
import {
  assertName,
  assertPort,
  assertText,
  cleanOptional,
  defaultOsFor,
} from './schema.js';

export interface ServerRulesInput {
  id?: string;
  name: string;
  kind: 'local' | 'ssh';
  os?: ServerOs;
  host?: string;
  port?: number;
  username?: string;
  auth?: SshServerProfile['auth'];
  clearPassword?: boolean;
}

/**
 * Build a normalized ServerProfile from a save request. SSH validation is
 * intentionally strict: requires either a non-empty password (or a saved one)
 * or a non-empty privateKeyPath, matching the chosen `auth.method`. Pure.
 */
export function buildServer(
  input: ServerRulesInput,
  existing: ServerProfile | undefined,
  now: number,
): ServerProfile {
  const os = input.os ?? existing?.os ?? defaultOsFor(input.kind);
  if (input.kind === 'local') {
    return {
      id: existing?.id ?? input.id ?? randomUUID(),
      name: assertName(input.name),
      kind: 'local',
      os,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }
  return buildSsh(input, existing, os, now);
}

function buildSsh(
  input: ServerRulesInput,
  existing: ServerProfile | undefined,
  os: ServerOs,
  now: number,
): SshServerProfile {
  const existingSsh = existing?.kind === 'ssh' ? existing : undefined;
  const password = input.auth?.password || (!input.clearPassword ? existingSsh?.auth.password : undefined);
  const authMethod = input.auth?.method ?? existingSsh?.auth.method ?? (password ? 'password' : 'privateKeyPath');
  const privateKeyPath = cleanOptional(input.auth?.privateKeyPath ?? existingSsh?.auth.privateKeyPath);
  if (authMethod === 'password' && !password) throw new Error('SSH password is required');
  if (authMethod === 'privateKeyPath' && !privateKeyPath) throw new Error('SSH private key path is required');
  return {
    id: existing?.id ?? input.id ?? randomUUID(),
    name: assertName(input.name),
    kind: 'ssh',
    os,
    host: assertText(input.host, 'host'),
    port: assertPort(input.port ?? 22),
    username: assertText(input.username, 'username'),
    auth: authMethod === 'password'
      ? { method: 'password', password }
      : { method: 'privateKeyPath', privateKeyPath },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}
