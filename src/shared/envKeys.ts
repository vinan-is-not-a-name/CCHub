/**
 * Single source of truth for the profile form-field ↔ Anthropic env-key relation.
 * Adding a new forwarded env var means adding one line here; the env-key list,
 * the key union, and the field→env conversion all derive from this map. Keep this
 * module dependency-free so `domain.ts` can import the key type without a cycle.
 */
export const PROFILE_FIELD_TO_ENV = {
  baseUrl: 'ANTHROPIC_BASE_URL',
  authToken: 'ANTHROPIC_AUTH_TOKEN',
  model: 'ANTHROPIC_MODEL',
  subagentModel: 'CLAUDE_CODE_SUBAGENT_MODEL',
  smallFastModel: 'ANTHROPIC_SMALL_FAST_MODEL',
} as const;

export type ProfileEnvField = keyof typeof PROFILE_FIELD_TO_ENV;
export type AnthropicEnvKey = typeof PROFILE_FIELD_TO_ENV[ProfileEnvField];

/** Anthropic env keys forwarded to the launched CLI. Derived from PROFILE_FIELD_TO_ENV. */
export const ANTHROPIC_ENV_KEYS = Object.values(PROFILE_FIELD_TO_ENV) as readonly AnthropicEnvKey[];

/** Standard proxy env vars, both cases — set when a preset's SSH reverse tunnel
 * is active so the remote claude routes through `127.0.0.1:<bindPort>`. Lowercase
 * variants included because some tools (curl, git) read those specifically. */
export const PROXY_ENV_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
] as const;

/** Every env key the shell adapters export into the launch command and that
 * remoteEnv forwards over SSH: Anthropic profile vars + proxy vars. One list so
 * adding a forwarded var is a single edit and both code paths stay in sync. */
export const FORWARDED_ENV_KEYS = [...ANTHROPIC_ENV_KEYS, ...PROXY_ENV_KEYS] as readonly string[];

/** Map flat profile form fields onto their env keys, dropping empty values. */
export function profileFieldsToEnv(
  fields: Partial<Record<ProfileEnvField, string | undefined>>,
): Partial<Record<AnthropicEnvKey, string>> {
  const env: Partial<Record<AnthropicEnvKey, string>> = {};
  for (const field of Object.keys(PROFILE_FIELD_TO_ENV) as ProfileEnvField[]) {
    const value = fields[field];
    if (value) env[PROFILE_FIELD_TO_ENV[field]] = value;
  }
  return env;
}
