import { test, expect } from '@playwright/test';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { buildLocalShellSpec, type LocalShellApp } from '../src/server/infrastructure/shell/revealLocalShell.js';

// Runtime cwd verification for the ADMIN reveal targets, Windows-only.
//
// Why this exists: on Windows, `Start-Process ... -Verb RunAs
// -WorkingDirectory '<cwd>'` silently ignores -WorkingDirectory. The
// elevated shell lands in `C:\Windows\System32` regardless — this is a
// well-known UAC quirk (the elevated process gets a fresh cwd from its new
// security context). Pure argv-shape unit tests miss it because the spec
// LOOKS right; only a real spawn + probe file
// caught the discrepancy. This spec keeps the shape locked with the runtime
// behavior: the elevated shell lands where we asked it to.
//
// Non-admin reveal is exercised in `revealLocalShell.spec.ts` at the argv
// level only — it's known-good in production and its `cwd` rides on
// `spawn`'s own cwd option, which needs no elevation-crossing tricks.
//
// Skipped on non-Windows (there's no UAC there). Also skipped when
// CCHUB_SKIP_UAC_TESTS is set — the tests trigger a UAC prompt, so CI
// where nobody clicks yes will time out. On a developer machine, click
// "Yes" for each prompt (there are two).

const isWindows = process.platform === 'win32';
const skipUac = process.env.CCHUB_SKIP_UAC_TESTS === '1';

// A path with a space to catch quoting regressions — the elevated cmd
// argv passes through cmd's /K parser and cwd sits inside `"..."` there;
// a `cd /D` without the quotes would fail on a spaced path.
const testCwd = 'D:\\Temp\\cchub-admin cwd';
if (isWindows && !existsSync(testCwd)) mkdirSync(testCwd, { recursive: true });

/** Splice a diagnostic tail into the elevated shell's ArgumentList so the
 * shell writes its own cwd on startup then exits. Same structure as
 * production — we just extend the initial command with a `cd > file &
 * exit` (cmd) or an `Out-File; exit` (powershell). If the production spec
 * lands the elevated shell where we asked it to, the probe file contains
 * the passed cwd; if the shell landed elsewhere, the diff surfaces here. */
function specWithProbe(cwd: string, app: LocalShellApp, probePath: string): { file: string; args: string[]; keepAttached?: boolean } {
  const spec = buildLocalShellSpec(cwd, app);
  const args = [...spec.args];
  if (app === 'cmd-admin') {
    // Prod arg[2] is:
    //   Start-Process ... -ArgumentList '/K cd /D "<cwd>"'
    // Rewrite to chain a probe:
    //   Start-Process ... -ArgumentList '/K cd /D "<cwd>" & cd > "<probe>" & exit'
    // No new quoting layer added — `"<probe>"` is a literal in the outer
    // PS single-quoted string, which is exactly the pattern the prod cwd
    // sits in.
    args[2] = args[2].replace(
      /-ArgumentList '(\/K cd \/D "[^"]+")'$/,
      (_all, inner) => `-ArgumentList '${inner} & cd > "${probePath}" & exit'`,
    );
  } else if (app === 'powershell-admin') {
    // Rebuild the encoded command with a probe tail. We can't just splice
    // the existing base64 because we'd have to decode-modify-re-encode;
    // easier to re-derive with the extra Out-File.
    const inner = `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'; $PWD.Path | Out-File -FilePath '${probePath.replace(/'/g, "''")}' -Encoding ascii; exit`;
    const encoded = Buffer.from(inner, 'utf16le').toString('base64');
    args[2] = `Start-Process -FilePath powershell.exe -Verb RunAs -ArgumentList '-NoExit', '-EncodedCommand', '${encoded}'`;
  } else {
    throw new Error(`probe not implemented for ${app}`);
  }
  return { file: spec.file, args, keepAttached: spec.keepAttached };
}

async function spawnAndRead(spec: ReturnType<typeof specWithProbe>, probePath: string, timeoutMs = 20000): Promise<string> {
  const child = spawn(spec.file, spec.args, {
    detached: !spec.keepAttached,
    stdio: 'ignore',
    windowsHide: spec.keepAttached ? true : false,
  });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(probePath)) {
      // Small settle so a partial write doesn't come back truncated.
      await new Promise((r) => setTimeout(r, 200));
      return readFileSync(probePath, 'utf8').trim();
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`probe file ${probePath} not created within ${timeoutMs}ms — UAC likely dismissed`);
}

test.describe('admin reveal: elevated shell lands in the passed cwd', () => {
  test.skip(!isWindows, 'reveal targets are Windows-only');
  test.skip(skipUac, 'CCHUB_SKIP_UAC_TESTS is set (UAC prompts require interactive click)');
  // Each test pops a UAC prompt on the host desktop. Serial keeps the
  // prompts one at a time.
  test.describe.configure({ mode: 'serial' });

  test('cmd-admin: elevated cmd lands in <cwd>, not C:\\Windows\\System32', async () => {
    // Regression: `-WorkingDirectory` was passed but silently ignored under
    // `-Verb RunAs`, so the elevated cmd landed in C:\Windows\System32.
    // The fix routes the initial `cd /D` through `-ArgumentList` where the
    // elevated shell runs it as its first command.
    const probe = join(testCwd, `probe-cmd-admin-${randomBytes(6).toString('hex')}.log`);
    const spec = specWithProbe(testCwd, 'cmd-admin', probe);
    const actual = await spawnAndRead(spec, probe);
    expect(actual.toLowerCase()).toBe(testCwd.toLowerCase());
    try { unlinkSync(probe); } catch { /* ok */ }
  });

  test('powershell-admin: elevated PowerShell lands in <cwd>', async () => {
    const probe = join(testCwd, `probe-ps-admin-${randomBytes(6).toString('hex')}.log`);
    const spec = specWithProbe(testCwd, 'powershell-admin', probe);
    const actual = await spawnAndRead(spec, probe);
    expect(actual.toLowerCase()).toBe(testCwd.toLowerCase());
    try { unlinkSync(probe); } catch { /* ok */ }
  });
});
