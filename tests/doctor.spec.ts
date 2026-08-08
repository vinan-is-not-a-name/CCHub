import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { assertRedacted } from './support/redactPty.js';
// The doctor is plain .mjs with no types; importing the real module (rather than
// re-implementing its logic here) is the whole point — a spec that copies the
// detector would agree with a wrong copy. The local aliases below give the
// untyped exports the shapes this file relies on.
import * as doctorModule from '../scripts/doctor.mjs';

/** One reported divergence between two fingerprints. */
interface Divergence {
  key: string;
  baseline: unknown;
  current: unknown;
  why: string | null;
}

const doctor = doctorModule as unknown as {
  ccTerminalId(env: Record<string, string>): string | null;
  shape(v: string | undefined): string | null;
  flatten(obj: Record<string, unknown>, prefix?: string): Record<string, unknown>;
  diffFingerprints(baseline: unknown, current: unknown): Divergence[];
  CC_KITTY_TERMINALS: string[];
  TERMINAL_VARS: string[];
};
const { ccTerminalId, shape, flatten, diffFingerprints, CC_KITTY_TERMINALS, TERMINAL_VARS } = doctor;

/**
 * Tests for the environment fingerprint (scripts/doctor.mjs).
 *
 * The doctor exists because the deciding variable in every recent bug was a
 * property of the machine, and CI cannot see the machine. That makes its own
 * correctness untestable in the usual sense — there is no "right" fingerprint.
 * What IS testable, and what this covers, are the three claims the tool makes
 * that could silently be false:
 *
 *   1. `ccTerminalId` reproduces cc's detector. If this drifts from cc, the
 *      report confidently prints the wrong conclusion — worse than printing
 *      nothing. Pinned against the same host table the differential spec uses.
 *   2. `shape()` does not disclose. The report is meant to be pasted into an
 *      issue, so a value that leaks a GUID or a home directory is a privacy bug
 *      in a diagnostic tool.
 *   3. `--diff` actually reports divergence, and attaches the explanation.
 *
 * Importing the module also asserts something by construction: the CLI is
 * behind a `main()` guard, so a spec run neither shells out to PowerShell nor
 * prints a fingerprint.
 */

const DOCTOR_PATH = join(fileURLToPath(import.meta.url), '..', '..', 'scripts', 'doctor.mjs');

test.describe('ccTerminalId reproduces cc\'s detector', () => {
  // The same host table as tests/ptyDifferential.spec.ts, plus the expected id.
  // These are the shells that actually launch the server, and the id is what cc
  // computes from each. `windows-terminal` and `tmux` are on cc's kitty
  // allowlist; the others are not — that split is the bug from 12f2996.
  const HOSTS: Array<[string, Record<string, string>, string | null]> = [
    ['Windows Terminal', { WT_SESSION: '177a1758-8055-413f-9e64-3d41ccfc1f21', WT_PROFILE_ID: '{guid}' }, 'windows-terminal'],
    ['Cmder / ConEmu', { ConEmuANSI: 'OFF', ConEmuPID: '16180', ConEmuTask: '{cmd::Cmder}' }, 'conemu'],
    ['Git Bash', { MSYSTEM: 'MINGW64', TERM: 'xterm-256color' }, 'mingw64'],
    ['kitty', { TERM: 'xterm-kitty', KITTY_WINDOW_ID: '1' }, 'kitty'],
    ['WezTerm', { TERM_PROGRAM: 'WezTerm' }, 'WezTerm'],
    ['tmux', { TMUX: '/tmp/tmux-1000/default,123,0' }, 'tmux'],
    ['VS Code', { TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '1.90.0' }, 'vscode'],
    ['ghostty', { TERM: 'xterm-ghostty' }, 'ghostty'],
    ['bare cmd.exe', {}, null],
  ];

  for (const [name, env, expected] of HOSTS) {
    test(`${name} → ${expected ?? '<none>'}`, () => {
      expect(ccTerminalId(env)).toBe(expected);
    });
  }

  test('the kitty-keyboard verdict splits the hosts the way the captures do', () => {
    // This is the line the whole report hangs on, and it is checkable against
    // recorded evidence: the two committed fixtures were captured from these
    // exact two hosts, and one contains `CSI >1u` while the other does not.
    const wtId = ccTerminalId({ WT_SESSION: 'guid' });
    const conemuId = ccTerminalId({ ConEmuPID: '1' });
    expect(CC_KITTY_TERMINALS.includes(wtId)).toBe(true);
    expect(CC_KITTY_TERMINALS.includes(conemuId)).toBe(false);

    const dir = join(fileURLToPath(import.meta.url), '..', 'fixtures', 'pty');
    const wtCapture = readFileSync(join(dir, 'startup-wt-54x30.raw'), 'utf8');
    const conemuCapture = readFileSync(join(dir, 'startup-conemu-170x40.raw'), 'utf8');
    // The verdict and the bytes must agree. If cc changes its allowlist, one of
    // these two halves breaks and the disagreement is the finding.
    expect(wtCapture.includes('\x1b[>1u'), 'WT: verdict says push, capture must contain it').toBe(true);
    expect(conemuCapture.includes('\x1b[>1u'), 'ConEmu: verdict says no push, capture must lack it').toBe(false);
  });

  test('detector precedence matches cc\'s order, not just its outcomes', () => {
    // cc reads these in a fixed order and returns the first hit, so a machine
    // exporting several wins by precedence. A refactor that reorders the checks
    // would still pass the per-host cases above but break here.
    // TERM_PROGRAM is read before WT_SESSION:
    expect(ccTerminalId({ TERM_PROGRAM: 'WezTerm', WT_SESSION: 'guid' })).toBe('WezTerm');
    // WT_SESSION before MSYSTEM — the real Git-Bash-inside-Windows-Terminal case:
    expect(ccTerminalId({ WT_SESSION: 'guid', MSYSTEM: 'MINGW64', TERM: 'xterm-256color' })).toBe('windows-terminal');
    // MSYSTEM before ConEmu* — Git Bash inside Cmder, which is this machine:
    expect(ccTerminalId({ MSYSTEM: 'MINGW64', ConEmuPID: '1' })).toBe('mingw64');
    // ConEmu* before bare TERM:
    expect(ccTerminalId({ ConEmuANSI: 'OFF', TERM: 'xterm-256color' })).toBe('conemu');
    // TERM is the last resort, not a winner:
    expect(ccTerminalId({ TERM: 'xterm-256color' })).toBe('xterm-256color');
  });

  test('every var the detector branches on is in the reported list', () => {
    // Anti-drift between the two halves of the file: if someone adds a branch to
    // the transcribed detector but forgets to report the variable, the report
    // shows a conclusion with no visible cause — exactly the situation that cost
    // a week of round-trips.
    const source = readFileSync(DOCTOR_PATH, 'utf8');
    const body = source.slice(source.indexOf('export function ccTerminalId'), source.indexOf('CC_KITTY_TERMINALS'));
    const read = new Set([...body.matchAll(/env\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!));
    const missing = [...read].filter((v) => !TERMINAL_VARS.includes(v));
    expect(missing, 'detector reads these but the report never shows them').toEqual([]);
  });
});

test.describe('shape() does not disclose', () => {
  test('identifying values are reduced to a shape', () => {
    expect(shape('177a1758-8055-413f-9e64-3d41ccfc1f21')).toBe('<set: guid>');
    expect(shape('D:\\codebase\\cc-remote')).toBe('<set: path depth 3>');
    expect(shape('/home/someone/work')).toBe('<set: path depth 4>');
    expect(shape('16180')).toBe('<set: number>');
    expect(shape('')).toBe('<set: empty>');
    expect(shape(undefined)).toBe(null);
  });

  test('no shaped output contains the input it described', () => {
    // The property, rather than the six cases above: for anything that looks
    // identifying, none of the original substance may survive into the report.
    const secrets = [
      'D:\\Users\\wfwzy\\codebase\\cc-remote',
      '/Users/someone/Documents/private',
      '177a1758-8055-413f-9e64-3d41ccfc1f21',
      '{2f4d8a91-3c7b-4e15-9a6f-8d2c1b7e4a03}',
      'C:\\Program Files\\Some Vendor\\thing.exe',
    ];
    for (const s of secrets) {
      const out = shape(s);
      // Split on separators and check no meaningful component leaks through.
      for (const part of s.split(/[\\/{},.\s-]+/).filter((p) => p.length >= 4)) {
        expect(out, `shape(${JSON.stringify(s)}) leaked ${JSON.stringify(part)}`).not.toContain(part);
      }
    }
  });

  test('values cc branches on are reported verbatim', () => {
    // The other half: shaping everything would be private and useless. cc
    // compares these against exact strings, so the report must show them.
    expect(shape('xterm-256color')).toBe('xterm-256color');
    expect(shape('MINGW64')).toBe('MINGW64');
    expect(shape('WezTerm')).toBe('WezTerm');
    expect(shape('vscode')).toBe('vscode');
    expect(shape('OFF')).toBe('OFF');
    expect(shape('{cmd::Cmder}')).toBe('{cmd::Cmder}');
  });

  test('a long opaque value is reduced to its length', () => {
    const long = 'a'.repeat(200);
    expect(shape(long)).toBe('<set: 200 chars>');
    expect(shape(long)).not.toContain('aaaa');
  });

  test('a GUID inside a longer string is still not printed', () => {
    // TMUX and similar carry a socket path plus ids. The path branch catches the
    // POSIX form; what must never happen is the raw value being echoed.
    const tmux = '/tmp/tmux-1000/default,177a1758,0';
    const out = shape(tmux);
    expect(out).not.toContain('177a1758');
    expect(out).not.toContain('tmux-1000');
  });
});

test.describe('--diff reports divergence with its explanation', () => {
  const good = {
    platform: 'win32 10.0.26100', node: 'v24.11.1', claude: '2.1.220 (Claude Code)',
    conhost: '10.0.26100.7306', conptyDll: 'bundled dll present',
    ccTerminalId: 'conemu', ccWouldPushKittyKeyboard: false,
    terminalEnv: { ConEmuANSI: 'OFF', ConEmuPID: '<set: number>' },
  };

  test('identical fingerprints produce no differences', () => {
    expect(diffFingerprints(good, structuredClone(good))).toEqual([]);
  });

  test('the WT-vs-ConEmu divergence is reported and explained', () => {
    // The real comparison this tool was built for: the bad machine as it was
    // before 12f2996, against the good one.
    const bad = {
      ...structuredClone(good),
      ccTerminalId: 'windows-terminal',
      ccWouldPushKittyKeyboard: true,
      terminalEnv: { WT_SESSION: '<set: guid>', WT_PROFILE_ID: '{guid}' },
    };
    const diffs = diffFingerprints(good, bad);
    const byKey = new Map(diffs.map((d) => [d.key, d]));

    expect(byKey.has('ccTerminalId')).toBe(true);
    expect(byKey.has('ccWouldPushKittyKeyboard')).toBe(true);
    // The explanation is the part that turns a diff into a diagnosis; it must
    // point at the commit that fixed it.
    expect(byKey.get('ccWouldPushKittyKeyboard')!.why).toContain('12f2996');
    // Nested env vars are compared per-key, not as one opaque object, so the
    // report names the variable rather than saying "terminalEnv differs".
    expect(diffs.some((d) => d.key === 'terminalEnv.WT_SESSION')).toBe(true);
    expect(diffs.some((d) => d.key === 'terminalEnv.ConEmuANSI')).toBe(true);
  });

  test('a missing conpty.dll is reported and explained', () => {
    const bad = { ...structuredClone(good), conptyDll: 'bundled dll MISSING (host conhost will be used)' };
    const [d] = diffFingerprints(good, bad);
    expect(d.key).toBe('conptyDll');
    expect(d.why).toContain('9f0e66d');
  });

  test('a key present on only one side is reported, not dropped', () => {
    // Version skew between baselines: an older baseline lacks a field the
    // current doctor collects. Silently ignoring it would hide the divergence.
    const older: Record<string, unknown> = structuredClone(good);
    delete older.conptyDll;
    const diffs = diffFingerprints(older, good);
    expect(diffs.map((d) => d.key)).toContain('conptyDll');
    const d = diffs.find((x) => x.key === 'conptyDll')!;
    expect(d.baseline).toBe(null);
    expect(d.current).toBe('bundled dll present');
  });

  test('flatten reaches nested keys and leaves scalars alone', () => {
    expect(flatten({ a: 1, b: { c: 2, d: { e: 3 } } })).toEqual({ a: 1, 'b.c': 2, 'b.d.e': 3 });
    expect(flatten({ ok: false, n: null })).toEqual({ ok: false, n: null });
  });

  test('false and null are compared by value, not by truthiness', () => {
    // `ccWouldPushKittyKeyboard: false` vs a baseline missing the key entirely
    // must diff. A truthiness-based comparison would call them equal, which is
    // the difference between "this machine is fine" and "we never checked".
    expect(diffFingerprints({}, { ccWouldPushKittyKeyboard: false }).length).toBe(1);
    expect(diffFingerprints({ x: false }, { x: false })).toEqual([]);
  });
});

test.describe('the doctor is safe to import and to paste', () => {
  test('importing it runs no CLI', () => {
    // Asserted by construction: if `main()` ran at import time, this spec file
    // would have shelled out to PowerShell and printed a fingerprint before the
    // first test. The guard is what makes the import above cheap and silent.
    const source = readFileSync(DOCTOR_PATH, 'utf8');
    expect(source).toContain('import.meta.url === pathToFileURL(process.argv[1]).href');
    // And collect() — the only function that shells out — is not called at
    // module scope.
    const topLevelCollect = source.split('\n').filter((l) => /^const \w+ = collect\(\)/.test(l));
    expect(topLevelCollect, 'collect() must only run inside main()').toEqual([]);
  });

  test('it reads only — no spawn that could change the machine', () => {
    // A diagnostic that modifies the box it is diagnosing is worse than none.
    // Every command it runs is a fixed literal; this pins that none of them are
    // writes and that nothing is interpolated into a shell string.
    const source = readFileSync(DOCTOR_PATH, 'utf8');
    for (const forbidden of ['spawn(', 'exec(', 'unlink', 'rmdir', 'Remove-Item', 'Set-ItemProperty', 'reg add']) {
      expect(source, `doctor must not use ${forbidden}`).not.toContain(forbidden);
    }
    // No template interpolation in any command line.
    const cmdLines = source.split('\n').filter((l) => l.includes('tryExec'));
    for (const l of cmdLines) {
      expect(l, `interpolated command: ${l.trim()}`).not.toMatch(/tryExec\w*\(\s*`[^`]*\$\{/);
    }
  });

  test('every committed baseline is free of identifying values', () => {
    // The report is meant to be pasted into an issue, and a baseline is a saved
    // report. Reusing the PTY captures' guard means one definition of "leak"
    // covers both — and this discovers files, so a hand-added baseline is
    // scanned without anyone remembering to wire it up.
    const dir = join(fileURLToPath(import.meta.url), '..', 'fixtures', 'env');
    const baselines = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(baselines.length, 'expected at least one committed baseline').toBeGreaterThan(0);

    for (const file of baselines) {
      const text = readFileSync(join(dir, file), 'utf8');
      assertRedacted(text, `baseline ${file}`);
      // The shaping must actually have run: a baseline is only publishable
      // because `shape()` processed it, and a raw `{...process.env}` dump would
      // pass the guard above while still carrying build numbers and ids.
      const fp = JSON.parse(text);
      for (const [k, v] of Object.entries(fp.terminalEnv ?? {})) {
        expect(shape(v as string), `${file}: terminalEnv.${k} was not shaped`).toBe(v);
      }
    }
  });

  test('a baseline is a fingerprint, not a dump of the environment', () => {
    // Anti-scope-creep with privacy teeth: if someone widens collect() to record
    // the whole env, most of what lands here is neither needed nor publishable.
    const dir = join(fileURLToPath(import.meta.url), '..', 'fixtures', 'env');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const fp = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      const reported = Object.keys(fp.terminalEnv ?? {});
      const unexpected = reported.filter((k) => !TERMINAL_VARS.includes(k));
      expect(unexpected, `${file} reports vars the detector never reads`).toEqual([]);
      // And the two conclusions the tool exists to print are present.
      expect(fp, `${file} must record cc's terminal id`).toHaveProperty('ccTerminalId');
      expect(typeof fp.ccWouldPushKittyKeyboard, `${file}`).toBe('boolean');
    }
  });
});
