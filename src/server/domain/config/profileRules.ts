import { randomUUID } from 'crypto';
import { AnthropicEnvProfile } from '../../../shared/protocol.js';
import { assertName, sanitizeAnthropicEnv } from './schema.js';

export interface ProfileRulesInput extends Partial<AnthropicEnvProfile> {
  id?: string;
  name: string;
  clearAuthToken?: boolean;
}

/**
 * Build a normalized AnthropicEnvProfile from a save request, preserving the
 * existing token unless `clearAuthToken` is set or a new value is supplied.
 * Pure — no IO, no randomUUID()-based replay risk (a fresh id is generated
 * only when neither `existing` nor `input.id` provides one).
 */
export function buildProfile(
  input: ProfileRulesInput,
  existing: AnthropicEnvProfile | undefined,
  now: number,
): AnthropicEnvProfile {
  const env = sanitizeAnthropicEnv(input.env ?? {});
  if (existing && !input.clearAuthToken && !env.ANTHROPIC_AUTH_TOKEN) {
    env.ANTHROPIC_AUTH_TOKEN = existing.env.ANTHROPIC_AUTH_TOKEN;
  }
  return {
    id: existing?.id ?? input.id ?? randomUUID(),
    name: assertName(input.name),
    env,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}
