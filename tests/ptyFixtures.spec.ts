import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { redactPtyCapture, assertRedacted } from './support/redactPty.js';

const HERE = join(fileURLToPath(import.meta.url), '..');
const FIXTURE_DIR = join(HERE, 'fixtures', 'pty');

/** Every committed capture. Read once here so a new fixture is picked up by the
 * privacy guard automatically — an opt-in list would let someone add a capture
 * that never gets scanned, which is the failure mode this whole file exists to
 * prevent. */
const FIXTURES = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.raw'));

test.describe('redactPtyCapture', () => {
  // The length guarantee is what makes a redacted capture still usable as a
  // rendering oracle: cc positions its UI with absolute column moves computed
  // against the text it wrote, so a shorter replacement would leave those
  // columns pointing past the text and every grid assertion downstream would be
  // measuring the redaction instead of cc.
  test('keeps byte length identical', () => {
    const cases = [
      'cwd: D:\\some\\deep\\project\\path here',
      'home: /home/alice/work/repo done',
      'session 177a1758-8055-413f-9e64-3d41ccfc1f21 end',
      'plan: API Usage Billing shown',
      'C:/Users/bob/x mixed /Users/carol/y',
    ];
    for (const input of cases) {
      const { text } = redactPtyCapture(input);
      expect(text.length, `length changed for ${JSON.stringify(input)}`).toBe(input.length);
    }
  });

  test('removes the identifying value, not just part of it', () => {
    const { text } = redactPtyCapture('cwd is D:\\temp\\new right here');
    expect(text).not.toContain('temp');
    expect(text).not.toContain('new');
    expect(text).toContain('cwd is ');
    expect(text).toContain(' right here');
  });

  test('redacts a username passed by value, outside any path', () => {
    const { text } = redactPtyCapture('hello wfwzy on host', { userName: 'wfwzy' });
    expect(text).not.toContain('wfwzy');
    expect(text.length).toBe('hello wfwzy on host'.length);
  });

  test('leaves escape sequences and column moves untouched', () => {
    const input = '\x1b[1B\x1b[16G\x1b[38;2;102;102;102mD:\\temp\\x\x1b[53G\x1b[2m';
    const { text } = redactPtyCapture(input);
    for (const seq of ['\x1b[1B', '\x1b[16G', '\x1b[38;2;102;102;102m', '\x1b[53G', '\x1b[2m']) {
      expect(text).toContain(seq);
    }
  });

  test('leaves non-identifying paths readable', () => {
    // cc's own output mentions `/usr/bin`-style paths and `/init`-style slash
    // commands; redacting those would cost readability for no privacy gain.
    const { text } = redactPtyCapture('run /init to create a file, PATH=/usr/bin');
    expect(text).toContain('/init');
    expect(text).toContain('/usr/bin');
  });

  test('reports what it redacted', () => {
    const { redactions } = redactPtyCapture('D:\\a\\b and 177a1758-8055-413f-9e64-3d41ccfc1f21');
    expect(redactions.map((r) => r.kind).sort()).toEqual(['guid', 'winPath']);
  });

  // Without this, `assertRedacted` could be trivially satisfied by a redactor
  // that does nothing, as long as the guard's patterns never matched anything.
  test('assertRedacted rejects an unredacted capture', () => {
    expect(() => assertRedacted('cwd D:\\temp\\new')).toThrow(/Windows filesystem path/);
    expect(() => assertRedacted('id 177a1758-8055-413f-9e64-3d41ccfc1f21')).toThrow(/GUID/);
    expect(() => assertRedacted('sk-ant0123456789abcdefghij')).toThrow(/API key/);
    expect(() => assertRedacted('ghp_0123456789abcdefghij')).toThrow(/GitHub token/);
    expect(() => assertRedacted('-----BEGIN RSA PRIVATE KEY-----')).toThrow(/private key/);
  });

  test('assertRedacted accepts the redactor\'s own output', () => {
    const dirty = 'cwd D:\\Temp\\cchub-cwd-probe plan API Usage Billing id 177a1758-8055-413f-9e64-3d41ccfc1f21';
    const { text } = redactPtyCapture(dirty);
    expect(() => assertRedacted(text)).not.toThrow();
  });

  test('is idempotent', () => {
    const once = redactPtyCapture('D:\\temp\\new and /home/alice/x').text;
    const twice = redactPtyCapture(once).text;
    expect(twice).toBe(once);
  });
});

test.describe('committed PTY fixtures', () => {
  test('there is at least one', () => {
    // Guards the per-fixture loop below from passing vacuously if the directory
    // is ever emptied or renamed.
    expect(FIXTURES.length).toBeGreaterThan(0);
  });

  for (const name of FIXTURES) {
    test(`${name} carries nothing identifying`, () => {
      const text = readFileSync(join(FIXTURE_DIR, name), 'utf8');
      // Throws with the offending substring and offset, so a leak is fixable
      // without hunting through the capture by hand.
      assertRedacted(text, name);
    });

    test(`${name} is a real cc capture, not a hand-written stub`, () => {
      const text = readFileSync(join(FIXTURE_DIR, name), 'utf8');
      // A stub would be easy to write and would quietly turn the replay layer
      // back into "my own model of cc" — the exact problem these fixtures
      // exist to escape. Real captures always carry cc's startup handshake.
      expect(text).toContain('\x1b[?1049h'); // enters the alt screen
      expect(text).toContain('\x1b[?9001h'); // win32-input-mode
      expect(text).toContain('Claude Code');
      expect(text.length).toBeGreaterThan(1000);
    });
  }
});
