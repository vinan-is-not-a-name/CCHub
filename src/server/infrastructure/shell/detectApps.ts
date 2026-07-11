import { spawn } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/** Async helpers can be injected in tests to keep detectApps pure. Production
 * wires them to child_process + fs; tests pass fakes that record calls. */
export interface DetectDeps {
  /** Run `where <exe>` and resolve to the first line of stdout (an absolute
   * path to the exe) or null on non-zero exit / spawn error. */
  where(exe: string): Promise<string | null>;
  /** List a directory's immediate children. Returns [] on ENOENT so callers
   * don't have to try/catch each Program Files root. */
  readdir(dir: string): string[];
  /** existsSync — mockable so tests don't touch the real filesystem. */
  exists(path: string): boolean;
}

/** The three supported reveal-target apps. Named as they appear in the config
 * schema so callers can pass a lookup key straight through. */
export type DetectableApp = 'xshell' | 'xftp' | 'vscode';

/** Executable filename for each detectable app — used both by `where` and by
 * the Program Files glob. Windows-focused (Xshell/Xftp are Windows-only), but
 * `vscode` is cross-platform: on non-Windows we fall through to `where` for
 * the `code` script and skip the Windows-only Program Files scan. */
const APP_EXE: Record<DetectableApp, string> = {
  xshell: 'Xshell.exe',
  xftp: 'Xftp.exe',
  vscode: process.platform === 'win32' ? 'code.cmd' : 'code',
};

/** NetSarang's default install layout is `<Program Files>\NetSarang\<Product><version>\<Product>.exe`.
 * `<Product>` starts with "Xshell" or "Xftp"; the version suffix varies (7, 8,
 * "8 Portable", etc.), so we glob the directory prefix. */
const PROGRAM_FILES_ROOTS = [
  'C:\\Program Files\\NetSarang',
  'C:\\Program Files (x86)\\NetSarang',
] as const;

/** Live production DetectDeps — wraps child_process.spawn and fs. Kept tiny so
 * detectAppPath / detectApps are the interesting shape and this is just plumbing. */
export const liveDeps: DetectDeps = {
  where(exe) {
    return new Promise((resolve) => {
      // `where` is a Windows-only builtin; other platforms use `which`, but
      // XShell/XFTP are Windows-only apps, so a bare `where` failure on
      // non-Windows is the right result — null → fall through to Program
      // Files scan which also returns nothing → detectAppPath returns null.
      try {
        const child = spawn('where', [exe], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        child.stdout.on('data', (chunk) => { out += chunk.toString(); });
        child.on('error', () => resolve(null));
        child.on('close', (code) => {
          if (code !== 0) return resolve(null);
          const line = out.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
          resolve(line ?? null);
        });
      } catch {
        resolve(null);
      }
    });
  },
  readdir(dir) {
    try { return readdirSync(dir); } catch { return []; }
  },
  exists(path) {
    try { return existsSync(path); } catch { return false; }
  },
};

/** Try to find the exe for one app. Two-stage:
 *  1. `where <Exe>` — hits anything on the user's PATH first (the common case
 *     for a NetSarang install that ran the "Add to PATH" installer option,
 *     and the default for a modern VS Code install too).
 *  2. Glob the app's known Program Files roots for its exe:
 *     - Xshell/Xftp: `C:\Program Files{,, (x86)}\NetSarang\<Prefix>*\<Exe>`.
 *     - VS Code: `<Program Files>\Microsoft VS Code\bin\code.cmd` and the
 *       `AppData\Local\Programs\Microsoft VS Code\bin\code.cmd` per-user
 *       install location (the default of a "current user" installer).
 *
 * Returns null if neither hit; caller falls back to letting the user type a
 * path in the Settings dialog. Errors — missing directory, ENOENT on `where`
 * — are swallowed and treated as "not found" so a single scan failure doesn't
 * break the whole detect flow.  */
export async function detectAppPath(app: DetectableApp, deps: DetectDeps = liveDeps): Promise<string | null> {
  const exe = APP_EXE[app];

  const onPath = await deps.where(exe);
  if (onPath && deps.exists(onPath)) return onPath;

  // Program Files / AppData scans are Windows-only; on POSIX a `where` miss
  // means the app isn't available (Xshell/XFTP don't exist, VS Code is found
  // via `which code` by the caller's `where` fake or real PATH lookup).
  if (process.platform !== 'win32') return null;

  if (app === 'vscode') return scanVscode(deps);

  const prefix = app === 'xshell' ? 'Xshell' : 'Xftp';
  for (const root of PROGRAM_FILES_ROOTS) {
    for (const entry of deps.readdir(root)) {
      if (!entry.toLowerCase().startsWith(prefix.toLowerCase())) continue;
      const candidate = join(root, entry, exe);
      if (deps.exists(candidate)) return candidate;
    }
  }
  return null;
}

/** Convenience: run all three detectors and return the trio. Concurrent
 * because they're independent I/O — the Settings dialog's "Detect" button
 * hits the whole set. */
export async function detectApps(deps: DetectDeps = liveDeps): Promise<{ xshellPath: string | null; xftpPath: string | null; vscodePath: string | null }> {
  const [xshellPath, xftpPath, vscodePath] = await Promise.all([
    detectAppPath('xshell', deps),
    detectAppPath('xftp', deps),
    detectAppPath('vscode', deps),
  ]);
  return { xshellPath, xftpPath, vscodePath };
}

/** VS Code's install layout is fixed on Windows: `<Root>\Microsoft VS Code\
 * bin\code.cmd` where `<Root>` is one of Program Files, Program Files (x86),
 * or the per-user `AppData\Local\Programs`. `existsSync` on each candidate
 * is cheaper than a directory scan since the leaf name is fixed. */
function scanVscode(deps: DetectDeps): string | null {
  const home = homedir();
  const roots = [
    'C:\\Program Files\\Microsoft VS Code',
    'C:\\Program Files (x86)\\Microsoft VS Code',
    join(home, 'AppData', 'Local', 'Programs', 'Microsoft VS Code'),
  ];
  for (const root of roots) {
    const candidate = join(root, 'bin', 'code.cmd');
    if (deps.exists(candidate)) return candidate;
  }
  return null;
}
