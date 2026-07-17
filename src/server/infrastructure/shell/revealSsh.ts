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

/** The XShell key-store basename that the cc-remote private key gets imported
 * under (see infrastructure/shell/sshKeys.ts — the local key file is
 * `~/.cchub/keys/cchub_ed25519`, and XShell's importer keys it by that
 * basename). `UserKey=` takes this NAME, never a disk path — a disk path is
 * silently ignored and XShell falls back to a password prompt. */
const CCHUB_XSHELL_KEY_NAME = 'cchub_ed25519';

/** AuthMethodList sampled from a real GUI-built public-key session: only the
 * public-key method (code 11) is enabled, so login is silent when the key is
 * present in the store + remote authorized_keys. End-to-end verified. */
const AUTH_LIST_PUBKEY = '00,11,20,30';

/** AuthMethodList that enables the interactive password method — XShell shows
 * its password dialog, the user types once, and (because we do NOT auto-feed
 * the password) RemoteCommand still runs, so auto-cd works. This is XShell's
 * historical default for password sessions. */
const AUTH_LIST_PASSWORD = '01,10,20,30';

/** Compose the INI body of a one-shot `.xsh` session file that XShell opens to
 * the given remote cwd. The critical trick: `[CONNECTION:SSH] RemoteCommand`
 * is the only field that actually lands SSH sessions in `<cwd>` — the same-name
 * `InitRemoteDirectory` only affects SFTP/FTP.
 *
 * Password / Passphrase are ALWAYS left empty and we NEVER pass a credential
 * on the command line. That's deliberate: auto-feeding a password (via a
 * `-url ssh://user:pass@host` override) makes XShell skip RemoteCommand
 * entirely — which was the root cause of auto-cd silently not working. With no
 * auto-fed credential, both auth paths below run RemoteCommand.
 *
 * `certInstalled` picks the auth path:
 *  - true  → the cc-remote public key is in the server's authorized_keys, so
 *    we point `UserKey` at the imported key and enable only the public-key
 *    method → silent, promptless login + auto-cd.
 *  - false → we can't rely on the key, so we emit no UserKey and enable the
 *    password method → XShell prompts once, the user types their password, and
 *    RemoteCommand still lands them in cwd. */
export function buildXshellSessionFile(server: SshServerProfile, cwd: string, certInstalled: boolean): string {
  assertSafeIniValue(server.host, 'host');
  assertSafeIniValue(server.username, 'username');
  assertSafeIniValue(cwd, 'cwd');
  const remoteCommand = `cd '${cwd.replace(/'/g, `'\\''`)}' && exec $SHELL -l`;
  const userKey = certInstalled ? CCHUB_XSHELL_KEY_NAME : '';
  const authMethodList = certInstalled ? AUTH_LIST_PUBKEY : AUTH_LIST_PASSWORD;
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
    `AuthMethodList=${authMethodList}`,
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
 * auto-cwd hook) is in play.
 *
 * We NEVER pass a credential on the command line: a `-url ssh://user:pass@host`
 * override makes XShell skip RemoteCommand, which broke auto-cd. `certInstalled`
 * (probed at call time — is the cc-remote public key in the server's
 * authorized_keys?) instead selects the auth path baked into the `.xsh`:
 *   - true  → public-key auth, silent login, auto-cd.
 *   - false → XShell shows its password prompt; the user types once and, since
 *     nothing was auto-fed, RemoteCommand still runs → auto-cd after login.
 *
 * The configured `exePath` takes priority; otherwise we open through
 * `explorer.exe` so the `.xsh` file association works even when `Xshell.exe`
 * isn't on PATH. `unlinkSync` fires 30s later — long enough for XShell to have
 * read the file, short enough that a crash doesn't leave it lying around. */
export function revealXshell(server: SshServerProfile, cwd: string, certInstalled: boolean, opts: RevealSpawnOptions = {}): void {
  const path = join(tmpdir(), `cchub-reveal-${randomBytes(6).toString('hex')}.xsh`);
  try {
    writeFileSync(path, buildXshellSessionFile(server, cwd, certInstalled), 'utf8');
  } catch (err) {
    opts.onError?.(`couldn't write temp session file: ${describeError(err)}`);
    return;
  }
  const exe = opts.exePath ?? 'explorer.exe';
  // Missing configured path is a common misconfiguration — a specific error
  // helps the user open Settings and fix it instead of seeing nothing happen.
  if (opts.exePath && !existsSync(opts.exePath)) {
    opts.onError?.(`XShell exe not found at "${opts.exePath}" — check Settings.`);
    scheduleUnlink(path);
    return;
  }
  try {
    const child = spawn(exe, [path], { detached: true, stdio: 'ignore' });
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
