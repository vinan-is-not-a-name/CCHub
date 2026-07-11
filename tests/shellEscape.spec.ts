import { test, expect } from '@playwright/test';
import { shellQuote } from '../src/server/utils/shellEscape.js';

// shellQuote is the security boundary for every value spliced into a remote bash
// command (env values, paths, conda env names). BashAdapter exercises it through
// one happy case in shell.spec; here we pin the escaping contract directly so a
// regression that lets a single-quote (and thus arbitrary shell) through is caught
// at the cheapest possible layer.
test.describe('shellQuote — POSIX single-quote escaping', () => {
  test('wraps a plain value in single quotes', () => {
    expect(shellQuote('hello')).toBe(`'hello'`);
  });

  test('empty string becomes an empty quoted token (not nothing)', () => {
    expect(shellQuote('')).toBe(`''`);
  });

  test('an embedded single quote is broken out and re-quoted', () => {
    // The classic '\'' trick: close quote, escaped quote, reopen quote.
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`);
  });

  test('multiple single quotes are each escaped', () => {
    expect(shellQuote("''")).toBe(`''"'"''"'"''`);
  });

  test('shell metacharacters stay literal inside the quotes (no injection)', () => {
    // $, backtick, &&, ; etc. are inert once single-quoted — they must NOT be
    // expanded or treated as command separators.
    expect(shellQuote('$(rm -rf /)')).toBe(`'$(rm -rf /)'`);
    expect(shellQuote('a && b; `c`')).toBe(`'a && b; \`c\`'`);
  });
});
