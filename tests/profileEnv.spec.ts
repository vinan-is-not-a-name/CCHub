import { test, expect } from '@playwright/test';
import {
  PROFILE_FIELD_TO_ENV,
  ANTHROPIC_ENV_KEYS,
  profileFieldsToEnv,
} from '../src/shared/protocol.js';
import { buildRemoteEnv } from '../src/server/infrastructure/transport/remoteEnv.js';

test.describe('profileFieldsToEnv', () => {
  test('maps every form field onto its env key', () => {
    const env = profileFieldsToEnv({
      baseUrl: 'https://api.test',
      authToken: 'tok',
      model: 'claude-4',
      subagentModel: 'opus',
      smallFastModel: 'haiku',
    });
    expect(env).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.test',
      ANTHROPIC_AUTH_TOKEN: 'tok',
      ANTHROPIC_MODEL: 'claude-4',
      CLAUDE_CODE_SUBAGENT_MODEL: 'opus',
      ANTHROPIC_SMALL_FAST_MODEL: 'haiku',
    });
  });

  test('drops empty and undefined values', () => {
    const env = profileFieldsToEnv({ baseUrl: 'x', authToken: '', model: undefined });
    expect(env).toEqual({ ANTHROPIC_BASE_URL: 'x' });
  });

  test('ANTHROPIC_ENV_KEYS is derived from the map values', () => {
    expect([...ANTHROPIC_ENV_KEYS].sort()).toEqual(
      Object.values(PROFILE_FIELD_TO_ENV).sort(),
    );
  });
});

// buildRemoteEnv is the server-side counterpart: it filters an arbitrary env map
// down to the forwarded Anthropic keys before they cross the wire to the launched
// CLI. Same "only known keys, only non-empty" contract as profileFieldsToEnv, but
// applied to an already-built env rather than form fields — cheap to pin here.
test.describe('buildRemoteEnv', () => {
  test('keeps only ANTHROPIC_ENV_KEYS and drops everything else', () => {
    const out = buildRemoteEnv({
      ANTHROPIC_BASE_URL: 'https://x',
      ANTHROPIC_AUTH_TOKEN: 'tok',
      PATH: '/usr/bin',
      HOME: '/home/u',
    });
    expect(out).toEqual({ ANTHROPIC_BASE_URL: 'https://x', ANTHROPIC_AUTH_TOKEN: 'tok' });
  });

  test('drops known keys whose value is empty', () => {
    const out = buildRemoteEnv({ ANTHROPIC_BASE_URL: '', ANTHROPIC_MODEL: 'claude-4' });
    expect(out).toEqual({ ANTHROPIC_MODEL: 'claude-4' });
  });

  test('empty input yields an empty env', () => {
    expect(buildRemoteEnv({})).toEqual({});
  });
});
