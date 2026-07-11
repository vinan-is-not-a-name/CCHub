import { spawn } from 'child_process';

/** The four supported local-shell reveal targets. Both admin variants go
 * through PowerShell's `Start-Process -Verb RunAs` so Windows shows the
 * standard UAC prompt; there is no way to elevate silently from a non-admin
 * process, by design. Not-Windows targets short-circuit: this file predates
 * a well-defined multi-platform story for "open a terminal here". */
export type LocalShellApp = 'cmd' | 'cmd-admin' | 'powershell' | 'powershell-admin';

export interface RevealLocalShellOptions {
  onError?: (message: string) => void;
}

/** Argv spec produced by `buildLocalShellSpec` — split so callers can spawn
 * with the exact shape and tests can assert against it without spawning. */
export interface LocalShellSpec {
  file: string;
  args: string[];
  /** When set, the initial working directory of the spawned process. Only
   * used by the non-admin variants; the admin variants pass cwd via
   * `Start-Process -WorkingDirectory` so the ELEVATED process lands there
   * (setting the launcher's cwd wouldn't propagate through UAC). */
  cwd?: string;
  /** True for the admin variants whose launcher is `powershell.exe`. Node's
   * `spawn(..., { detached: true })` on Windows silently no-ops
   * powershell.exe's `-Command` block — the launcher exits code 0 without
   * running the payload, so Start-Process is never called and no UAC prompt
   * ever appears. This is a Windows-specific behavior: with detached:true,
   * every variant of stdio/windowsHide silently fails; with detached:false,
   * they all run cleanly. We flag the admin specs
   * here so `revealLocalShell` can drop detached for those; the non-admin
   * cmd.exe launcher tolerates detached:true and keeps it. */
  keepAttached?: boolean;
}

/** Compose the argv Windows needs to pop a new console window at `cwd`.
 *
 *  - Non-admin: `cmd.exe /c start "" cmd.exe` (or powershell.exe). `start`
 *    is what makes Windows allocate a fresh console; a bare
 *    `spawn('cmd.exe')` from Node leaves it attached to the invisible
 *    detached console and no window appears. The empty `""` is start's
 *    required title arg — without it, the shell path is misparsed as the
 *    title on paths containing spaces. `cwd` rides on the outer spawn's
 *    `cwd` option so cmd/powershell inherits it — no /K hack needed and no
 *    quoting minefield for paths containing '&', quotes, or unicode.
 *
 *  - Admin: `powershell -NoProfile -Command Start-Process ... -Verb RunAs
 *    -ArgumentList '<initial-cmd>'`. UAC elevation silently drops
 *    `-WorkingDirectory` — under `-Verb RunAs` the elevated child lands in
 *    `C:\Windows\System32` regardless of that flag. The only way to land
 *    the ELEVATED shell in the right
 *    place is to have it `cd` (or Set-Location) as its first command. For
 *    cmd that's `/K cd /D "<cwd>"`; for PowerShell we route through
 *    `-EncodedCommand` (base64 UTF-16LE) so no quoting rules from cmd,
 *    outer PowerShell, and inner PowerShell layers can interact — Windows
 *    paths can't contain `"` but they can contain `'`, and cascading
 *    single-quote doubling across two PowerShell parsers is easy to get
 *    wrong. `-EncodedCommand` bypasses all of it.
 *
 *    PowerShell string quoting is closed with single quotes and embedded
 *    quotes are doubled (PowerShell's escape convention). */
export function buildLocalShellSpec(cwd: string, app: LocalShellApp): LocalShellSpec {
  assertSafeShellCwd(cwd);
  switch (app) {
    case 'cmd':
      return { file: 'cmd.exe', args: ['/c', 'start', '', 'cmd.exe'], cwd };
    case 'powershell':
      return { file: 'cmd.exe', args: ['/c', 'start', '', 'powershell.exe'], cwd };
    case 'cmd-admin':
      // -ArgumentList is a PowerShell array literal. cmd's /K takes the rest
      // of its command line as one string; `cd /D "<cwd>"` needs the
      // double quotes so a space in cwd doesn't chop the path. Windows FS
      // forbids `"` in a path (NTFS reserved character) so we don't need
      // to escape inside cmd's parser; single quotes still need doubling
      // for the outer PowerShell's single-quoted literal (psSingleQuote).
      return {
        file: 'powershell.exe',
        args: [
          '-NoProfile',
          '-Command',
          `Start-Process -FilePath cmd.exe -Verb RunAs -ArgumentList '/K cd /D "${psSingleQuote(cwd)}"'`,
        ],
        keepAttached: true,
      };
    case 'powershell-admin':
      // Nested PowerShell parsing (outer PS → inner elevated PS) plus a
      // path that can contain single quotes is a quoting minefield. Route
      // the elevated command through `-EncodedCommand`: build a UTF-16LE
      // buffer, base64-encode it, and pass THAT as the ArgumentList entry.
      // Base64 is pure ASCII with no quote characters, so no escaping rule
      // from any parsing layer can break it. See `encodePwshCommand`.
      return {
        file: 'powershell.exe',
        args: [
          '-NoProfile',
          '-Command',
          `Start-Process -FilePath powershell.exe -Verb RunAs -ArgumentList '-NoExit', '-EncodedCommand', '${encodePwshCommand(`Set-Location -LiteralPath '${psSingleQuote(cwd)}'`)}'`,
        ],
        keepAttached: true,
      };
  }
}

/** Reject cwd values that could break out of the string contexts
 * `buildLocalShellSpec` embeds them into. NTFS forbids `"`, `<`, `>`, `|`,
 * `*`, `?` in filenames, so any legitimate on-disk path fails this check for
 * exactly zero characters. But cwd here arrives as WS message data, not as
 * a resolved filesystem path, so an attacker can freely include:
 *
 *  - `"` — breaks out of `/K cd /D "…"` in the cmd-admin variant. Since the
 *    escaped payload runs under UAC elevation, the blast radius is Administrator
 *    code execution, i.e. full local privilege escalation from a browser tab
 *    that already had loopback WS access. NTFS reserves it, so we lose nothing.
 *  - `\r` / `\n` — smuggle a second command past cmd or PowerShell's
 *    line-terminated parsing.
 *  - `\0` — some Node APIs truncate on NUL; leaving it in makes the check
 *    subject to TOCTOU across parser layers.
 *
 * Fail fast (before spawn) with a message that leaks no cwd content, so a
 * malformed request doesn't reflect its own payload back through the error
 * channel. */
export function assertSafeShellCwd(cwd: string): void {
  if (/["<>|\r\n\0]/.test(cwd)) {
    throw new Error('cwd contains characters unsafe for shell reveal');
  }
}

/** Encode a PowerShell command string for `-EncodedCommand`: UTF-16LE bytes,
 * base64-encoded. Both cross-platform (Node Buffer) and stable — the same
 * encoding pwsh reads back with its own decoder. Kept exported for tests. */
export function encodePwshCommand(command: string): string {
  return Buffer.from(command, 'utf16le').toString('base64');
}

/** Escape a string for embedding inside a PowerShell single-quoted literal.
 * Only ' needs doubling — backslash, $, backtick etc. are literal inside
 * '...'. Exported for the specs. */
export function psSingleQuote(s: string): string {
  return s.replace(/'/g, "''");
}

/** Spawn a fresh Windows console at `cwd`. Windows-only; other platforms
 * report through `onError` and return — this reveal target has no coherent
 * meaning off Windows (Terminal.app / gnome-terminal / xterm each need
 * different argv shapes and none of them elevate the same way as UAC). */
export function revealLocalShell(cwd: string, app: LocalShellApp, opts: RevealLocalShellOptions = {}): void {
  if (process.platform !== 'win32') {
    opts.onError?.('Local shell reveal is only supported on Windows.');
    return;
  }
  try {
    // buildLocalShellSpec runs assertSafeShellCwd, which throws for cwd values
    // that would break out of the cmd-admin / PowerShell quoting; keep it in
    // the try/catch so the error surfaces through onError like a spawn failure
    // rather than blowing up the WS handler.
    const spec = buildLocalShellSpec(cwd, app);
    // See LocalShellSpec.keepAttached: admin variants must NOT set detached:true
    // because it silently no-ops powershell.exe's -Command payload on Windows.
    // Non-admin (cmd.exe /c start) tolerates detached and keeps it — the
    // launcher exits sub-second either way, and detached-false with unref is
    // just as safe.
    const detached = !spec.keepAttached;
    // Hide the transient launcher window. For admin variants this suppresses a
    // powershell window that briefly appears then vanishes; for non-admin the
    // visible window is created by cmd.exe /c `start`, not the launcher, so
    // hiding the launcher does not affect the user-facing shell.
    const windowsHide = spec.keepAttached ? true : false;
    const child = spawn(spec.file, spec.args, {
      detached,
      stdio: 'ignore',
      windowsHide,
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
    });
    child.on('error', (err) => opts.onError?.(`${labelFor(app)} launch failed: ${describeError(err)}`));
    child.unref();
  } catch (err) {
    opts.onError?.(`${labelFor(app)} launch failed: ${describeError(err)}`);
  }
}

/** Human-readable app name for error messages (the toast heading uses the
 * same label). Split out so the specs can assert error phrasing. */
export function labelFor(app: LocalShellApp): string {
  switch (app) {
    case 'cmd': return 'CMD';
    case 'cmd-admin': return 'CMD (admin)';
    case 'powershell': return 'PowerShell';
    case 'powershell-admin': return 'PowerShell (admin)';
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `${err.message} (${code})` : err.message;
  }
  return String(err);
}
