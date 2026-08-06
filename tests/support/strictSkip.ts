/**
 * Skips that can be made to fail.
 *
 * A skipped test and a passing test look the same in the summary line: both are
 * "not a failure". That is fine on a machine that genuinely can't run the test,
 * and actively harmful on the machine you are currently debugging — the
 * environment-conditional skip deletes coverage from exactly the place the
 * divergence lives. `tests/imeAnchorDpr.spec.ts:138` is the worked example: it
 * self-skips when the platform's row pitch is an integer, so on the machine
 * where the IME box drifted it reported success by not existing.
 *
 * Two things fix that, and this module is the second one:
 *
 *   1. Detect capability instead of asking for a flag. `hasClaude` used to mean
 *      "TEST_HAS_CLAUDE was set", so 13 real-cc tests sat out every run on a
 *      machine with a perfectly working `claude` on PATH. `canRunClaude()`
 *      looks for the binary.
 *   2. Under `CCHUB_TEST_STRICT=1`, turn "skipped, but this machine could have
 *      run it" into a failure. Strict mode is for the run you do when you are
 *      chasing a bug and need to know that nothing quietly opted out.
 *
 * Reasons are classified rather than free-text so strict mode can tell apart
 * "this OS will never do this" (still skips, correctly — no amount of strictness
 * makes ConPTY exist on Linux) from "this needs a flag/tool that is in fact
 * available here" (fails, loudly).
 */
import { test } from '@playwright/test';
import { execFileSync } from 'child_process';

/** Set `CCHUB_TEST_STRICT=1` to make avoidable skips fail. */
export const STRICT = process.env.CCHUB_TEST_STRICT === '1';

/**
 * Why a test is being skipped.
 *
 * - `platform`: this OS/browser can never run it. Always a real skip.
 * - `missing-tool`: needs an external binary. Strict mode fails, because the
 *   honest response to "cc isn't installed" on a dev machine is to install it,
 *   not to silently drop the tests that cover cc.
 * - `unset-flag`: needs opt-in config (a remote preset, an interactive UAC
 *   click). Strict mode fails: the flag is the user's to set, and a silent skip
 *   hides that they haven't.
 * - `no-signal`: the machine's data doesn't exercise the condition — the
 *   dangerous one. Strict mode fails, because "my metrics happen to be benign"
 *   is indistinguishable from "the assertion no longer holds", and a test that
 *   opts out on some machines is not coverage. Prefer searching for a
 *   configuration that does exercise it (see imeAnchorMatrix.spec.ts).
 */
export type SkipReason = 'platform' | 'missing-tool' | 'unset-flag' | 'no-signal';

/** Reasons that stay skips even under strict mode: no flag can conjure a
 * different operating system. */
const UNAVOIDABLE: ReadonlySet<SkipReason> = new Set<SkipReason>(['platform']);

/**
 * Skip `when` true — unless strict mode says this machine should have coped, in
 * which case fail with the same message.
 *
 * Call it exactly where `test.skip(cond, msg)` would go.
 */
export function skipUnlessStrict(when: boolean, reason: SkipReason, message: string): void {
  if (!when) return;
  if (STRICT && !UNAVOIDABLE.has(reason)) {
    throw new Error(
      `CCHUB_TEST_STRICT=1: refusing to skip (${reason}) — ${message}\n` +
      `This machine could run this test; a silent skip here is a coverage hole ` +
      `exactly where behaviour differs between machines.`,
    );
  }
  test.skip(when, `[${reason}] ${message}`);
}

let claudeProbe: { ok: boolean; detail: string } | undefined;

/**
 * Is a real `claude` runnable here?
 *
 * Probes the binary rather than trusting an env flag, and caches — this runs per
 * test file and spawning a process 13 times to learn the same fact is waste.
 * `--version` is used because it neither needs auth nor makes a network call.
 */
export function probeClaude(): { ok: boolean; detail: string } {
  if (claudeProbe) return claudeProbe;
  if (process.env.TEST_HAS_CLAUDE === 'false') {
    claudeProbe = { ok: false, detail: 'TEST_HAS_CLAUDE=false (explicitly disabled)' };
    return claudeProbe;
  }
  try {
    // `claude` on Windows is a .cmd shim, which CreateProcess won't launch
    // directly — hence a shell. The command is a fixed literal with no
    // interpolation, so there is nothing here for a shell to re-parse.
    const cmd = process.platform === 'win32' ? 'claude --version' : 'claude';
    const args = process.platform === 'win32' ? [] : ['--version'];
    const out = execFileSync(cmd, args, {
      encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32',
    });
    claudeProbe = { ok: true, detail: out.trim() };
  } catch (err) {
    claudeProbe = { ok: false, detail: `claude --version failed: ${(err as Error).message.split('\n')[0]}` };
  }
  return claudeProbe;
}

/** True when this machine can launch a real cc. Replaces the old
 * `!!ANTHROPIC_API_KEY || TEST_HAS_CLAUDE === 'true'`, which answered "did
 * someone set a flag" — a question about the runner's config, not about whether
 * the test could actually run. */
export function canRunClaude(): boolean {
  return probeClaude().ok;
}

/** Skip a test that needs a real cc. Under strict mode, a missing cc fails
 * instead: the tests gated on this are the only ones that exercise real cc, so
 * losing them silently is how a cc-boundary bug ships. */
export function requireClaude(): void {
  const probe = probeClaude();
  skipUnlessStrict(!probe.ok, 'missing-tool', `needs a runnable claude CLI (${probe.detail})`);
}

/** Skip when an opt-in env flag is absent. */
export function requireEnv(name: string, why: string): void {
  skipUnlessStrict(!process.env[name], 'unset-flag', `${name} not set — ${why}`);
}

/** Skip on the wrong OS. Stays a skip under strict mode. */
export function requirePlatform(platform: NodeJS.Platform, why: string): void {
  skipUnlessStrict(process.platform !== platform, 'platform', `${why} (needs ${platform}, this is ${process.platform})`);
}

/**
 * Skip because the machine's own measurements don't exercise the condition.
 *
 * Under strict mode this fails, and that is the intended sharp edge: it is the
 * shape of skip that hid the IME drift. If you reach for this, consider first
 * whether the test can *search* for a configuration that does produce a signal
 * on this machine, which is strictly better than opting out.
 */
export function requireSignal(present: boolean, what: string): void {
  skipUnlessStrict(!present, 'no-signal', `this machine produces no signal for ${what}`);
}
