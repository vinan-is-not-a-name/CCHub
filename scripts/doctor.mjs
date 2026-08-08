/**
 * Environment fingerprint — the piece that runs on the machine we can't reach.
 *
 *   node scripts/doctor.mjs                  # print this machine's fingerprint
 *   node scripts/doctor.mjs --json           # machine-readable
 *   node scripts/doctor.mjs --save <file>    # write a baseline
 *   node scripts/doctor.mjs --diff <file>    # compare against a baseline
 *
 * Every bug in the recent run lived on a boundary with software we don't
 * control, and the deciding variable was always a property of the *machine*:
 * which shell launched the server, which conhost build was in play, what the
 * font metrics did to the row pitch. None of that is visible in CI, and asking
 * for it over chat took a week of round-trips — the WT_SESSION value that
 * cracked the case was one `echo %WT_SESSION%` that nobody thought to run.
 *
 * So this collects the whole set at once. It reads only; it launches nothing and
 * changes nothing. `--diff` against a baseline captured on a working machine
 * turns "it's broken on my box" into a list of the ways the two boxes differ.
 *
 * IMPORTANT: run this from the SAME shell you start the server from. Almost
 * everything here is inherited from the launching process, so the answer changes
 * with the shell: on the machine this was written on, PowerShell reports
 * `ccTerminalId: conemu` while Git Bash in the same window reports `mingw64`,
 * because the latter also exports MSYSTEM and TERM. That is not noise — it is
 * the whole mechanism behind the env-leak bug (12f2996), which is why the report
 * deliberately shows the raw variables next to the conclusion.
 *
 * Privacy: values that identify a person or machine are reported as a shape, not
 * a value — `WT_SESSION` shows as `<set: guid>`, paths as their depth. The point
 * is which variables are present and what cc will conclude from them, and none
 * of that needs the actual GUID. Output is meant to be pasteable into an issue.
 */
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { createRequire } from 'module';
import { join, dirname, resolve } from 'path';
import { pathToFileURL } from 'url';
import os from 'os';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

/** Run a command and return trimmed stdout, or null. Never throws — a missing
 * tool is a finding, not a crash. */
function tryExec(cmd, args) {
  try {
    // `shell` is deliberately off: every command here is a fixed literal with no
    // interpolation, so there is nothing for a shell to add, and passing args
    // through one on Windows both triggers a deprecation warning and re-parses
    // them. `.cmd` shims (claude) are handled by the caller passing the full
    // command line with shell: true explicitly where needed.
    return execFileSync(cmd, args, {
      encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Run a command line through the shell — needed for Windows `.cmd` shims like
 * `claude`, which CreateProcess cannot launch directly. */
function tryExecShell(commandLine) {
  try {
    return execFileSync(commandLine, [], {
      encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'], shell: true,
    }).trim();
  } catch {
    return null;
  }
}

/** Describe a value's shape without disclosing it. */
export function shape(v) {
  if (v === undefined) return null;
  if (v === '') return '<set: empty>';
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v)) return '<set: guid>';
  if (/^[A-Za-z]:[\\/]/.test(v) || v.startsWith('/')) return `<set: path depth ${v.split(/[\\/]+/).length}>`;
  if (/^\d+$/.test(v)) return '<set: number>';
  // Short, non-identifying values are the interesting ones (TERM, MSYSTEM,
  // TERM_PROGRAM) — cc branches on these exact strings, so they are reported.
  if (v.length <= 24) return v;
  return `<set: ${v.length} chars>`;
}

/**
 * cc's terminal-id detector, transcribed from claude 2.1.220 in its original
 * order. This is the single most valuable line of the report: it is what cc will
 * conclude about this machine, and it is computed at startup and never written
 * to disk, so there is no other way to see it.
 */
export function ccTerminalId(env) {
  if (env.CURSOR_TRACE_ID) return 'cursor';
  if ((env.VSCODE_GIT_ASKPASS_MAIN ?? '').toLowerCase().includes('cursor')) return 'cursor';
  if ((env.__CFBundleIdentifier ?? '').toLowerCase().includes('vscodium')) return 'codium';
  if (env.VisualStudioVersion) return 'visualstudio';
  if (env.TERMINAL_EMULATOR === 'JetBrains-JediTerm') return 'pycharm';
  if (env.TERM === 'xterm-ghostty') return 'ghostty';
  if ((env.TERM ?? '').includes('kitty')) return 'kitty';
  if (env.TERM_PROGRAM) return env.TERM_PROGRAM;
  if (env.TMUX) return 'tmux';
  if (env.STY) return 'screen';
  if (env.KONSOLE_VERSION) return 'konsole';
  if (env.GNOME_TERMINAL_SERVICE) return 'gnome-terminal';
  if (env.XTERM_VERSION) return 'xterm';
  if (env.VTE_VERSION) return 'vte-based';
  if (env.TERMINATOR_UUID) return 'terminator';
  if (env.KITTY_WINDOW_ID) return 'kitty';
  if (env.ALACRITTY_LOG) return 'alacritty';
  if (env.TILIX_ID) return 'tilix';
  if (env.WT_SESSION) return 'windows-terminal';
  if (env.MSYSTEM) return env.MSYSTEM.toLowerCase();
  if (env.ConEmuANSI || env.ConEmuPID || env.ConEmuTask) return 'conemu';
  if (env.WSL_DISTRO_NAME) return `wsl-${env.WSL_DISTRO_NAME}`;
  if (env.TERM) return env.TERM;
  return null;
}

/** Terminal ids for which cc pushes the kitty keyboard protocol +
 * modifyOtherKeys and enables synchronized output. xterm.js implements none of
 * those, so an id in this list is the failure mode from commit 12f2996. */
export const CC_KITTY_TERMINALS = ['iTerm.app', 'kitty', 'WezTerm', 'ghostty', 'tmux', 'windows-terminal', 'WarpTerminal'];

/** Env vars cc's detector reads, in the order it reads them. */
export const TERMINAL_VARS = [
  'CURSOR_TRACE_ID', 'VSCODE_GIT_ASKPASS_MAIN', '__CFBundleIdentifier', 'VisualStudioVersion',
  'TERMINAL_EMULATOR', 'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TMUX', 'STY',
  'KONSOLE_VERSION', 'GNOME_TERMINAL_SERVICE', 'XTERM_VERSION', 'VTE_VERSION', 'TERMINATOR_UUID',
  'KITTY_WINDOW_ID', 'ALACRITTY_LOG', 'TILIX_ID', 'WT_SESSION', 'WT_PROFILE_ID', 'MSYSTEM',
  'WSL_DISTRO_NAME', 'ConEmuANSI', 'ConEmuPID', 'ConEmuTask', 'ConEmuBuild',
];

function collect() {
  const env = process.env;
  const terminalEnv = {};
  for (const k of TERMINAL_VARS) {
    const s = shape(env[k]);
    if (s !== null) terminalEnv[k] = s;
  }

  const ccId = ccTerminalId(env);

  // The bundled ConPTY (commit 9f0e66d): without it the host's conhost rewrites
  // cc's SGR, which is invisible from inside the app.
  let conptyDll = null;
  try {
    const require_ = createRequire(import.meta.url);
    const pkg = require_.resolve('node-pty/package.json');
    const dll = join(dirname(pkg), 'build', 'Release', 'conpty', 'conpty.dll');
    conptyDll = existsSync(dll) ? 'bundled dll present' : 'bundled dll MISSING (host conhost will be used)';
  } catch (err) {
    conptyDll = `node-pty not resolvable: ${err.message.split('\n')[0]}`;
  }

  // conhost build: the variable behind the SGR-rewrite difference between the
  // two machines. Only meaningful on Windows.
  const conhost = process.platform === 'win32'
    ? tryExec('powershell', ['-NoProfile', '-Command',
        '(Get-Item $env:SystemRoot\\System32\\conhost.exe).VersionInfo.ProductVersion'])
    : null;

  // `claude` is a .cmd shim on Windows, which CreateProcess cannot launch, so
  // this one genuinely needs a shell.
  const claudeVersion = process.platform === 'win32'
    ? tryExecShell('claude --version')
    : tryExec('claude', ['--version']);

  // Full build including the UBR (revision), which os.release() omits — and it
  // is exactly the digit that differs from the conhost build. Read from the
  // registry rather than `cmd /c ver`: that prints a localized string in the
  // console's OEM codepage ("Microsoft Windows [版本 ...]" as CP936 bytes), which
  // is mojibake once decoded as UTF-8 and carries no information the numbers
  // don't. Single quotes only — the string is passed to PowerShell as one argv
  // entry, and nested double quotes do not survive that.
  const osVersion = process.platform === 'win32'
    ? tryExec('powershell', ['-NoProfile', '-Command',
        "$v = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'; "
        + "(($v.CurrentMajorVersionNumber, $v.CurrentMinorVersionNumber, $v.CurrentBuild, $v.UBR) -join '.') + ' ' + $v.DisplayVersion"])
    : os.version?.() ?? null;

  return {
    platform: `${process.platform} ${os.release()}`,
    osVersion,
    node: process.version,
    claude: claudeVersion ?? '<not runnable>',
    conhost: conhost ?? '<n/a>',
    conptyDll,
    // The two lines that matter most.
    ccTerminalId: ccId ?? '<none>',
    ccWouldPushKittyKeyboard: CC_KITTY_TERMINALS.includes(ccId ?? ''),
    terminalEnv,
  };
}

/** Fields whose disagreement between two machines is worth calling out, with
 * what that disagreement means. */
const EXPLAIN = {
  ccTerminalId: 'cc computes a different terminal id → it may negotiate different protocols',
  ccWouldPushKittyKeyboard: 'cc pushes kitty keyboard + modifyOtherKeys on one machine only; xterm.js supports neither (see 12f2996)',
  conptyDll: 'one machine falls back to the host conhost, which rewrites cc\'s SGR (see 9f0e66d)',
  conhost: 'different conhost build → different SGR/rewrite behaviour',
  claude: 'different cc version → different emitted sequences',
  node: 'different node → different node-pty binary',
};

export function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, key));
    else out[key] = v;
  }
  return out;
}

/**
 * Keys whose values disagree between two fingerprints, with the explanation
 * attached. Extracted so the spec exercises the same comparison the CLI prints
 * rather than a paraphrase of it.
 */
export function diffFingerprints(baseline, current) {
  const a = flatten(baseline);
  const b = flatten(current);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .map((k) => ({
      key: k,
      baseline: a[k] ?? null,
      current: b[k] ?? null,
      why: EXPLAIN[k.split('.').pop()] ?? EXPLAIN[k] ?? null,
    }));
}

/**
 * Run the CLI. Kept behind a function so importing this file — which the spec
 * does, to test the pure functions against the real source — neither shells out
 * nor prints anything.
 */
function main() {
  const fp = collect();

  if (flag('--json')) {
    console.log(JSON.stringify(fp, null, 2));
    return;
  }

  if (value('--save')) {
    const out = value('--save');
    // Create the directory: this flag is run by someone on the machine we cannot
    // reach, and "ENOENT" is a worse answer than a baseline.
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, JSON.stringify(fp, null, 2) + '\n', 'utf8');
    console.log(`baseline written to ${out}`);
    return;
  }

  if (value('--diff')) {
    const baseline = JSON.parse(readFileSync(value('--diff'), 'utf8'));
    const diffs = diffFingerprints(baseline, fp);
    if (diffs.length === 0) {
      console.log('identical to baseline — no environment divergence to explain the difference');
    } else {
      console.log(`${diffs.length} difference(s) from ${value('--diff')}:\n`);
      for (const d of diffs) {
        console.log(`  ${d.key}`);
        console.log(`    baseline: ${JSON.stringify(d.baseline)}`);
        console.log(`    this box: ${JSON.stringify(d.current)}`);
        if (d.why) console.log(`    → ${d.why}`);
        console.log('');
      }
    }
    process.exitCode = diffs.length > 0 ? 1 : 0;
    return;
  }

  console.log('cc-remote environment fingerprint\n');
  const flat = flatten(fp);
  const width = Math.max(...Object.keys(flat).map((k) => k.length));
  for (const [k, v] of Object.entries(flat)) {
    console.log(`  ${k.padEnd(width)}  ${v}`);
  }
  console.log('');
  if (fp.ccWouldPushKittyKeyboard) {
    console.log('  ⚠ cc would push the kitty keyboard protocol here. xterm.js implements');
    console.log('    neither kitty keyboard nor modifyOtherKeys, so input encoding will');
    console.log('    mismatch unless normalizeTerminalEnv strips these vars (commit 12f2996).');
    console.log('');
  }
  if (typeof fp.conptyDll === 'string' && fp.conptyDll.includes('MISSING')) {
    console.log('  ⚠ node-pty\'s bundled conpty.dll is absent, so the host conhost will');
    console.log('    handle the PTY and may rewrite cc\'s SGR (commit 9f0e66d).');
    console.log('');
  }
  console.log('  --save <file> to record a baseline, --diff <file> to compare machines.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
