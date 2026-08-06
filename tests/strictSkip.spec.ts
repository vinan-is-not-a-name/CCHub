import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { probeClaude, canRunClaude } from './support/strictSkip.js';

const HERE = join(fileURLToPath(import.meta.url), '..');

test.describe('claude capability probe', () => {
  // The old gate was `!!ANTHROPIC_API_KEY || TEST_HAS_CLAUDE === 'true'`, which
  // answers "did someone set a flag", not "can this machine run cc". On a
  // machine with a working claude and no flag set, 13 real-cc tests sat out
  // every run — the only 13 that touch the boundary where these bugs live.
  test('reports a definite answer with a reason attached', () => {
    const probe = probeClaude();
    expect(typeof probe.ok).toBe('boolean');
    expect(probe.detail.length).toBeGreaterThan(0);
    // Whichever way it goes, the reason must be specific enough to act on.
    console.log(`[claude probe] ok=${probe.ok} detail=${probe.detail}`);
  });

  test('caches, so 13 gated files do not spawn 13 processes', () => {
    const first = probeClaude();
    const second = probeClaude();
    expect(second).toBe(first); // identity, not just equality
  });

  test('canRunClaude agrees with the probe', () => {
    expect(canRunClaude()).toBe(probeClaude().ok);
  });

  test('a successful probe carries a version string', () => {
    const probe = probeClaude();
    if (!probe.ok) {
      console.log('[claude probe] not available here; version-shape check not applicable');
      return;
    }
    // Real `claude --version` prints something containing a semver.
    expect(probe.detail).toMatch(/\d+\.\d+\.\d+/);
  });
});

test.describe('skip surface', () => {
  const specs = readdirSync(HERE).filter((f) => f.endsWith('.spec.ts'));

  /** Every `test.skip(cond, msg)` in the suite, with its file and line. */
  function rawSkips(): Array<{ file: string; line: number; text: string }> {
    const found: Array<{ file: string; line: number; text: string }> = [];
    for (const file of specs) {
      const lines = readFileSync(join(HERE, file), 'utf8').split('\n');
      lines.forEach((text, i) => {
        // Conditional skips only: `test.skip(` with an argument. A bare
        // `test.skip('name', fn)` is an intentionally disabled test, which is a
        // different thing and visible in the report as such. Comment lines are
        // excluded so this file's own prose about `test.skip(` isn't counted.
        const code = text.replace(/^\s*(\/\/|\*|\/\*).*/, '');
        if (/\btest\.skip\(\s*[^'"`)]/.test(code)) found.push({ file, line: i + 1, text: text.trim() });
      });
    }
    return found;
  }

  test('every conditional skip is inventoried', () => {
    const skips = rawSkips();
    // Not a cap — a record. The point is that adding a silent skip shows up as a
    // diff to this number, so it is a decision someone makes rather than
    // something that accretes.
    console.log(`[skip surface] ${skips.length} conditional skips:`);
    for (const s of skips) console.log(`  ${s.file}:${s.line}  ${s.text.slice(0, 90)}`);
    expect(skips.length).toBeGreaterThan(0);
  });

  test('strict mode is documented where it can be found', () => {
    const helper = readFileSync(join(HERE, 'support', 'strictSkip.ts'), 'utf8');
    expect(helper).toContain('CCHUB_TEST_STRICT');
    // The classification is what lets strict mode distinguish "impossible here"
    // from "you just didn't set it up"; without it strict mode would either be
    // useless or fail on Linux for lacking ConPTY.
    for (const reason of ['platform', 'missing-tool', 'unset-flag', 'no-signal']) {
      expect(helper).toContain(reason);
    }
  });
});
