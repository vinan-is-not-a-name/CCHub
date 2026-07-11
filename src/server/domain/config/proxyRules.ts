import { randomUUID } from 'crypto';
import { ProxyConfig } from '../../../shared/protocol.js';
import { assertName, assertPort, assertText } from './schema.js';

export interface ProxyRulesInput extends Partial<ProxyConfig> {
  id?: string;
  name: string;
}

/**
 * Build a normalized ProxyConfig from a save request. Throws when host is empty
 * or when bindPort/port are not valid ports. Pure — a fresh id is generated only
 * when neither `existing` nor `input.id` supplies one (mirrors the other rules
 * modules so replay risk stays nil).
 */
export function buildProxy(
  input: ProxyRulesInput,
  existing: ProxyConfig | undefined,
  now: number,
): ProxyConfig {
  return {
    id: existing?.id ?? input.id ?? randomUUID(),
    name: assertName(input.name),
    bindPort: assertPort(input.bindPort as number),
    host: assertText(input.host, 'host'),
    port: assertPort(input.port as number),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}
