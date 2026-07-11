import { spawn } from 'child_process';
import { existsSync } from 'fs';
import type { SshServerProfile } from '../../../shared/protocol.js';

/** Options for the VS Code reveal helper. `exePath` is the stored
 * `appSettings.vscodePath`, or undefined if not configured. The launcher we
 * want is the CLI wrapper (`code.cmd` on Windows, `code` script on
 * Linux/mac), NOT `Code.exe` — the wrapper attaches to the running window
 * and routes `--remote` at the right process. Falling back to a bare `code`
 * relies on the "Add to PATH" installer step (default on modern VS Code
 * installs). `onError` fires when we can definitively say the launch didn't
 * happen (configured path missing, spawn ENOENT). Silent otherwise. */
export interface RevealVscodeOptions {
  exePath?: string;
  onError?: (message: string) => void;
}

/** Compose the argv VS Code needs to open `cwd`. When `ssh` is provided the
 * cwd is treated as a remote path and the Remote-SSH connect flag is added;
 * the user's VS Code needs the "Remote - SSH" extension installed for this
 * to actually connect (a fresh VS Code without it just opens the target
 * without a remote — no error, but nothing useful either).
 *
 * Split out from spawn so tests can lock the argv shape without spawning a
 * real process. `code` accepts `<path>` as its positional and `--remote
 * ssh-remote+<userinfo>@<host>[:<port>]` for tunneled opens. Port is only
 * appended when the SSH server uses a non-standard one — VS Code's parser
 * is picky about the `host:port` shape and appending `:22` for the default
 * has been observed to no-op on some builds. */
export function buildVscodeArgs(cwd: string, ssh?: SshServerProfile): string[] {
  if (!ssh) return [cwd];
  const authority = ssh.port && ssh.port !== 22
    ? `ssh-remote+${ssh.username}@${ssh.host}:${ssh.port}`
    : `ssh-remote+${ssh.username}@${ssh.host}`;
  return ['--remote', authority, cwd];
}

/** Launch VS Code against `cwd`. Local: opens `cwd` as a workspace root; SSH:
 * routes through the Remote-SSH extension. Same "silent success, specific
 * failure" contract as revealXshell/Xftp:
 *
 *  - `exePath` set + file missing on disk → onError with a Settings-pointing
 *    message. This is the common misconfiguration case.
 *  - Spawn throws or emits 'error' → onError with the underlying reason.
 *  - Otherwise the child is unref'd and forgotten.
 *
 * Windows note: the `code.cmd` launcher is a batch file, so Node's default
 * spawn (no shell) rejects it with EINVAL. We detect the .cmd extension and
 * enable `shell: true` for that case only — cwd is server-resolved and not
 * user-controlled at this call site, so shell interpretation is safe. Under
 * `shell: true` on Windows, Node concatenates `${command} ${args.join(' ')}`
 * into a single string and passes it to `cmd.exe /d /s /c`. That path does
 * NOT auto-quote a command with spaces (default VS Code install is at
 * `C:\Program Files\Microsoft VS Code\bin\code.cmd`), so cmd truncates at
 * the first space and reports "'C:\Program' is not recognized as an internal
 * or external command." We quote the exe ourselves; cmd's `/c ""a" "b""` rule
 * strips the outer quotes and re-parses correctly. */
export function revealVscode(cwd: string, ssh: SshServerProfile | undefined, opts: RevealVscodeOptions = {}): void {
  const exe = opts.exePath ?? (process.platform === 'win32' ? 'code.cmd' : 'code');
  if (opts.exePath && !existsSync(opts.exePath)) {
    opts.onError?.(`VS Code exe not found at "${opts.exePath}" — check Settings.`);
    return;
  }
  const { command, args, useShell } = buildVscodeSpawn(exe, buildVscodeArgs(cwd, ssh), process.platform);
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      ...(useShell ? { shell: true } : {}),
    });
    child.on('error', (err) => opts.onError?.(`VS Code launch failed: ${describeError(err)}`));
    child.unref();
  } catch (err) {
    opts.onError?.(`VS Code launch failed: ${describeError(err)}`);
  }
}

/** Decide how to invoke `exe` with `args` given the current platform. Split
 * from `revealVscode` so a unit test can lock the quoting behavior without
 * spawning a real process — the very-specific-to-Windows quirk this function
 * exists to encode is what a previous "just set shell: true" attempt got
 * wrong. Kept exported for the test only.
 *
 *  - Non-Windows or exe is not `.cmd`/`.bat`: return the raw exe + args as-is.
 *    Node's default spawn handles argv quoting for actual executables.
 *  - Windows + batch launcher: `shell: true` is required (Node refuses to
 *    directly spawn a batch file with EINVAL). Under shell mode Node just
 *    concatenates `${command} ${args.join(' ')}` and feeds it to `cmd.exe
 *    /d /s /c`, which does NO quoting of its own — so we quote every piece
 *    ourselves. Wrapping the exe (which typically lives at
 *    `C:\Program Files\Microsoft VS Code\bin\code.cmd`) is what fixes the
 *    "'C:\Program' is not recognized" failure.  */
export function buildVscodeSpawn(exe: string, args: string[], platform: NodeJS.Platform): { command: string; args: string[]; useShell: boolean } {
  const useShell = platform === 'win32' && /\.cmd$|\.bat$/i.test(exe);
  if (!useShell) return { command: exe, args, useShell: false };
  return { command: `"${exe}"`, args: args.map(quoteForCmd), useShell: true };
}

/** Wrap an argument in double quotes for cmd.exe consumption when `shell: true`
 * would otherwise concatenate without quoting. Any embedded `"` is escaped as
 * `\"` — cmd's rules are quirky, but for the paths we pass here (Windows FS
 * paths and `--remote ssh-remote+user@host` authorities) this is enough. */
function quoteForCmd(arg: string): string {
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `${err.message} (${code})` : err.message;
  }
  return String(err);
}
