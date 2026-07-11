import { FORWARDED_ENV_KEYS } from '../../../shared/protocol.js';

const REMOTE_KEYS = new Set<string>(FORWARDED_ENV_KEYS);

export function buildRemoteEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key, value]) => REMOTE_KEYS.has(key) && Boolean(value)),
  ) as NodeJS.ProcessEnv;
}
