import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import type { SshServerProfile } from '../../../shared/protocol.js';

/** Reject values that contain CR / LF / NUL before we splice them into the
 * INI body. A newline in `host`, `username`, `cwd`, or `userKey` would let
 * a spoofed value smuggle a new `[SECTION]` header or overwrite a real
 * field with an attacker-chosen value (e.g. `AuthMethodList=` or
 * `Password=`). Legitimate SSH hosts / usernames / paths never contain
 * these; the field arrives from a stored config but that config is
 * writeable over WS, so treat it as untrusted at the sink. */
function assertSafeIniValue(value: string, field: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new Error(`${field} contains characters unsafe for the XShell session file`);
  }
}

/** Reject `host` values that would reshape a URL authority. Legitimate hosts
 * are DNS labels (`[A-Za-z0-9._-]+`) or IPv6 literals wrapped in brackets
 * (`[::1]`). Everything else — `/`, `@`, `?`, `#`, spaces, control chars —
 * could steer the URL parser off the `sftp://user:pass@host:port/path`
 * authority we're building and hand the userinfo to the wrong endpoint. */
function assertSafeHost(host: string): void {
  if (!/^[A-Za-z0-9._\-:[\]]+$/.test(host)) {
    throw new Error('host contains characters unsafe for a URL authority');
  }
}

/** Compose the INI body of a one-shot `.xsh` session file that XShell opens to
 * the given remote cwd. The critical trick: `[CONNECTION:SSH] RemoteCommand`
 * is the only field that actually lands SSH sessions in `<cwd>` — the same-name
 * `InitRemoteDirectory` only affects SFTP/FTP. Password /
 * Passphrase are always left empty because XShell's stored encrypted values
 * carry a per-machine salt we can't reproduce; when we want silent login we
 * override them from the command-line URL (see buildXshellUrl / revealXshell).
 * UserKey is a plain path so private-key auth is fully hands-off. */
export function buildXshellSessionFile(server: SshServerProfile, cwd: string): string {
  assertSafeIniValue(server.host, 'host');
  assertSafeIniValue(server.username, 'username');
  assertSafeIniValue(cwd, 'cwd');
  const remoteCommand = `cd '${cwd.replace(/'/g, `'\\''`)}' && exec $SHELL -l`;
  const userKey = server.auth.method === 'privateKeyPath' && server.auth.privateKeyPath
    ? server.auth.privateKeyPath
    : '';
  if (userKey) assertSafeIniValue(userKey, 'privateKeyPath');
  return [
    '[SessionInfo]',
    'Version=8.1',
    'Description=cchub reveal',
    '[CONNECTION]',
    'Protocol=SSH',
    `Host=${server.host}`,
    `Port=${server.port}`,
    '[CONNECTION:SSH]',
    `RemoteCommand=${remoteCommand}`,
    '[CONNECTION:AUTHENTICATION]',
    `UserName=${server.username}`,
    'Password=',
    `UserKey=${userKey}`,
    'Passphrase=',
    'AuthMethodList=01,10,20,30',
    'UseExpectSend=0',
    'UseInitScript=0',
    '[TERMINAL]',
    'Type=xterm',
    'CodePage=65001',
    'Rows=24',
    'Cols=80',
    '',
  ].join('\r\n');
}

/** Compose the `sftp://` URL XFTP's `-url` flag takes. The path segment is
 * what lands the initial directory (RFC 3986 SFTP URI shape). Password-auth
 * servers get their credential inlined as `user:password@` so XFTP never has
 * to prompt; every user/password/path segment goes through `encodeURIComponent`
 * so passwords like `p@ss:w/rd#!` don't break the URL structure. Private-key
 * auth skips the inline password (XFTP will fall back to its own key auth
 * against the agent / default identity — the CLI has no `-i` equivalent).
 *
 * The obvious tradeoff: passwords passed via argv are visible to any local
 * user with a process listing, so this is only appropriate when cchub and
 * XFTP run on the same trust boundary (a single-user Windows box). */
export function buildXftpUrl(server: SshServerProfile, cwd: string): string {
  const user = encodeURIComponent(server.username);
  const userinfo = server.auth.method === 'password' && server.auth.password
    ? `${user}:${encodeURIComponent(server.auth.password)}`
    : user;
  // Host must be a URL-authority-safe shape (DNS label or bracketed IPv6).
  // The IPv6 form has literal `[]` and colons that URL-encoding libraries
  // would mangle, so we validate rather than encode.
  assertSafeHost(server.host);
  const path = cwd.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  const abs = path.startsWith('/') ? path : `/${path}`;
  return `sftp://${userinfo}@${server.host}:${server.port}${abs}`;
}

/** Compose the `ssh://user:password@host:port` URL that XShell's `-url` flag
 * takes when we want to bypass the password prompt. Same shape as buildXftpUrl
 * but SSH protocol and no path segment (XShell URL doesn't carry cwd — that's
 * what the paired `.xsh` file's RemoteCommand is for). Returns null when there
 * is no password to inline (private-key auth, or password-auth with an empty
 * password field), in which case revealXshell falls back to opening the `.xsh`
 * through the file association and lets XShell prompt if needed. */
export function buildXshellUrl(server: SshServerProfile): string | null {
  if (server.auth.method !== 'password' || !server.auth.password) return null;
  const user = encodeURIComponent(server.username);
  const pass = encodeURIComponent(server.auth.password);
  // See buildXftpUrl on host validation.
  assertSafeHost(server.host);
  return `ssh://${user}:${pass}@${server.host}:${server.port}`;
}

/** Options for the reveal helpers. `exePath` comes from stored appSettings
 * (Settings dialog), or is undefined when the user hasn't configured / detected
 * one yet; falling back to the bare exe name leans on PATH. `onError` fires
 * only when we can definitively say the launch didn't happen — missing file
 * on disk, synchronous spawn throw, async 'error' event. Silent success is
 * the norm; users don't need a "successfully spawned" confirmation. */
export interface RevealSpawnOptions {
  exePath?: string;
  onError?: (message: string) => void;
}

/** Spawn XShell against a one-shot `.xsh` file, then schedule deletion. We
 * write to `%TEMP%` and hand the path to XShell so `RemoteCommand` (the
 * auto-cwd hook) is in play. When the server has a password we can inline,
 * we also pass `-url ssh://user:password@host:port` — per XShell's docs, URL
 * properties override the ones in the paired session file, so the password
 * from the URL wins over the empty Password= field, and no prompt appears.
 * When there's no inline-able password (private-key auth, or empty password)
 * we open through `explorer.exe` so the file association still works even if
 * `Xshell.exe` isn't on PATH. `unlinkSync` fires 30s later — long enough for
 * XShell to have read the file, short enough that a crash doesn't leave the
 * (credential-adjacent) file lying around forever. */
export function revealXshell(server: SshServerProfile, cwd: string, opts: RevealSpawnOptions = {}): void {
  const path = join(tmpdir(), `cchub-reveal-${randomBytes(6).toString('hex')}.xsh`);
  try {
    writeFileSync(path, buildXshellSessionFile(server, cwd), 'utf8');
  } catch (err) {
    opts.onError?.(`couldn't write temp session file: ${describeError(err)}`);
    return;
  }
  const url = buildXshellUrl(server);
  // Configured path takes priority. When no path is configured *and* we need
  // to inline a URL password we still spawn `Xshell.exe` directly (URL
  // override only works via the CLI); otherwise fall back to explorer's
  // file association, which is more forgiving of unusual install layouts.
  const exe = opts.exePath ?? (url ? 'Xshell.exe' : 'explorer.exe');
  const args = url ? ['-url', url, path] : [path];
  // Missing configured path is a common misconfiguration — a specific error
  // helps the user open Settings and fix it instead of seeing nothing happen.
  if (opts.exePath && !existsSync(opts.exePath)) {
    opts.onError?.(`XShell exe not found at "${opts.exePath}" — check Settings.`);
    scheduleUnlink(path);
    return;
  }
  try {
    const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => opts.onError?.(`XShell launch failed: ${describeError(err)}`));
    child.unref();
  } catch (err) {
    opts.onError?.(`XShell launch failed: ${describeError(err)}`);
  }
  scheduleUnlink(path);
}

/** Spawn XFTP with an `sftp://user@host:port/cwd` URL. No temp file needed —
 * unlike XShell, XFTP's command-line `-url` accepts the initial-directory
 * segment directly. Configured `exePath` takes priority
 * over PATH resolution; a missing configured file reports a specific error
 * so the user knows to open Settings. */
export function revealXftp(server: SshServerProfile, cwd: string, opts: RevealSpawnOptions = {}): void {
  const url = buildXftpUrl(server, cwd);
  const exe = opts.exePath ?? 'Xftp.exe';
  if (opts.exePath && !existsSync(opts.exePath)) {
    opts.onError?.(`XFTP exe not found at "${opts.exePath}" — check Settings.`);
    return;
  }
  try {
    const child = spawn(exe, ['-url', url], { detached: true, stdio: 'ignore' });
    child.on('error', (err) => opts.onError?.(`XFTP launch failed: ${describeError(err)}`));
    child.unref();
  } catch (err) {
    opts.onError?.(`XFTP launch failed: ${describeError(err)}`);
  }
}

/** Schedule an unlink of the temp `.xsh` file 30s out — long enough for
 * XShell to have parsed it, short enough that a crash doesn't leave a
 * credential-adjacent file lying around forever. `unref` so a pending
 * timer doesn't hold the process open on shutdown. */
function scheduleUnlink(path: string): void {
  setTimeout(() => {
    try { unlinkSync(path); } catch { /* already gone or locked — fine */ }
  }, 30_000).unref();
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `${err.message} (${code})` : err.message;
  }
  return String(err);
}
