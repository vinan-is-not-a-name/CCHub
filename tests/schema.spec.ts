import { test, expect } from '@playwright/test';
import {
  assertName,
  assertText,
  assertPort,
  assertCondaEnv,
  cleanOptional,
  sanitizeAnthropicEnv,
} from '../src/server/domain/config/schema.js';

// These validators guard every persisted config value. The rules specs touch a
// few through buildServer/buildPreset, but the boundary values (port 0/65536,
// 80-char name truncation, illegal conda chars, trim-or-undefined) deserve direct
// assertions so a loosened bound is caught here, not by a downstream surprise.

test.describe('assertText', () => {
  test('trims and returns a non-empty string', () => {
    expect(assertText('  hi  ', 'x')).toBe('hi');
  });

  test('throws "<name> is required" on empty/whitespace/non-string', () => {
    expect(() => assertText('   ', 'host')).toThrow('host is required');
    expect(() => assertText('', 'host')).toThrow('host is required');
    expect(() => assertText(undefined, 'host')).toThrow('host is required');
    expect(() => assertText(123, 'host')).toThrow('host is required');
  });
});

test.describe('assertName', () => {
  test('passes a normal name through (trimmed)', () => {
    expect(assertName('  My Server  ')).toBe('My Server');
  });

  test('truncates to 80 chars', () => {
    expect(assertName('x'.repeat(200))).toHaveLength(80);
  });

  test('requires a non-empty value', () => {
    expect(() => assertName('  ')).toThrow('name is required');
  });
});

test.describe('assertPort — integer in [1, 65535]', () => {
  test('accepts the inclusive bounds', () => {
    expect(assertPort(1)).toBe(1);
    expect(assertPort(65535)).toBe(65535);
    expect(assertPort(22)).toBe(22);
  });

  test('rejects 0, 65536, negatives and non-integers', () => {
    for (const bad of [0, 65536, -1, 22.5, NaN]) {
      expect(() => assertPort(bad)).toThrow('invalid port');
    }
  });
});

test.describe('assertCondaEnv — allowed character set', () => {
  test('accepts letters, digits, dot, underscore, dash', () => {
    expect(() => assertCondaEnv('py3.11_env-A')).not.toThrow();
  });

  test('rejects spaces and shell metacharacters', () => {
    for (const bad of ['bad name', 'a;b', 'a$b', '', 'a/b']) {
      expect(() => assertCondaEnv(bad)).toThrow('invalid conda env');
    }
  });
});

test.describe('cleanOptional', () => {
  test('returns trimmed string when non-empty', () => {
    expect(cleanOptional('  v  ')).toBe('v');
  });

  test('returns undefined for empty, whitespace, or non-string', () => {
    expect(cleanOptional('')).toBeUndefined();
    expect(cleanOptional('   ')).toBeUndefined();
    expect(cleanOptional(undefined)).toBeUndefined();
    expect(cleanOptional(5)).toBeUndefined();
  });
});

test.describe('sanitizeAnthropicEnv', () => {
  test('keeps only known Anthropic keys with non-empty values', () => {
    const out = sanitizeAnthropicEnv({
      ANTHROPIC_BASE_URL: '  https://x  ',
      ANTHROPIC_MODEL: '',
      // @ts-expect-error — unknown keys must be dropped
      UNRELATED: 'nope',
    });
    expect(out).toEqual({ ANTHROPIC_BASE_URL: 'https://x' });
  });
});
