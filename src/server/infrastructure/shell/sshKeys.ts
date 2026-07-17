import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { SshServerProfile } from '../../../shared/protocol.js';
import { execOnce } from '../transport/remoteExec.js';

/** cc-remote's dedicated SSH key pair. This is deliberately NOT the user's
 * system `~/.ssh/id_ed25519` — it's a purpose-made identity that lives under
 * `~/.cchub/keys/` so installing / removing it never touches the user's own
 * SSH setup. The private key is meant to be imported into XShell's key store
 * once by hand (XShell converts it to its proprietary NSSSH format); the
 * public key is what we append to a server's `authorized_keys` so XShell can
 * log in without a password prompt. cc-remote's own ssh2 transport keeps using
 * whatever `SshServerProfile.auth` says — this key pair only serves the XShell
 * reveal path. */
const KEY_NAME = 'cchub_ed25519';
const KEY_COMMENT = 'cchub';

/** How long to allow for the connect + exec round-trip when probing / writing
 * a remote `authorized_keys`. Longer than execOnce's 6s default because the
 * handshake against a cold or distant host can eat several seconds on its own,
 * and a false timeout here reads to the user as "install failed". */
const REMOTE_TIMEOUT_MS = 15_000;

export interface CchubKeyPaths {
  dir: string;
  privatePath: string;
  publicPath: string;
}

export function cchubKeyPaths(): CchubKeyPaths {
  const dir = join(homedir(), '.cchub', 'keys');
  return { dir, privatePath: join(dir, KEY_NAME), publicPath: join(dir, `${KEY_NAME}.pub`) };
}

/** Read the cc-remote public key line (`ssh-ed25519 <body> cchub`), or null
 * when the pair hasn't been generated yet. */
export function readCchubPublicKey(): string | null {
  const { publicPath } = cchubKeyPaths();
  if (!existsSync(publicPath)) return null;
  return readFileSync(publicPath, 'utf8').trim();
}

/** Return the existing public key, generating the pair on first use. Idempotent:
 * an intact pair is left untouched so the private key already imported into
 * XShell stays valid. */
export function ensureCchubKeyPair(): string {
  const existing = readCchubPublicKey();
  if (existing && existsSync(cchubKeyPaths().privatePath)) return existing;
  return generateKeyPair();
}

/** Force a fresh pair, discarding any prior one. The user must re-import the
 * new private key into XShell and re-install the new public key on their
 * servers, so this is a deliberate "start over" action, not a routine call. */
export function regenerateCchubKeyPair(): string {
  return generateKeyPair();
}

function generateKeyPair(): string {
  const { dir, privatePath, publicPath } = cchubKeyPaths();
  mkdirSync(dir, { recursive: true });
  // ssh-keygen prompts interactively before overwriting an existing key file,
  // which would hang a non-interactive spawn. Clear any prior / half-written
  // pair first; this also implements the regenerate path.
  rmSync(privatePath, { force: true });
  rmSync(publicPath, { force: true });
  const res = spawnSync(
    'ssh-keygen',
    ['-t', 'ed25519', '-f', privatePath, '-N', '', '-C', KEY_COMMENT, '-q'],
    { encoding: 'utf8' },
  );
  if (res.error) throw new Error(`ssh-keygen failed to launch: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`ssh-keygen exited ${res.status}: ${(res.stderr || '').trim()}`);
  const pub = readCchubPublicKey();
  if (!pub) throw new Error('ssh-keygen reported success but no public key was written');
  return pub;
}

/** The base64 middle field of an OpenSSH public key line
 * (`ssh-ed25519 <body> comment`). It identifies the key independent of the
 * trailing comment or any leading `authorized_keys` options, so it's the most
 * robust needle for "is this key already present?". */
function keyBody(publicKey: string): string {
  const parts = publicKey.trim().split(/\s+/);
  if (parts.length < 2 || !parts[1]) throw new Error('malformed public key (no base64 body)');
  return parts[1];
}

/** True when the cc-remote public key is already present in the server's
 * `authorized_keys`. Matches on the base64 body so a differing comment or
 * option prefix doesn't cause a false negative. Returns false (rather than
 * throwing) when no key pair exists locally — there's nothing that could be
 * installed yet. */
export async function checkKeyInstalled(server: SshServerProfile): Promise<boolean> {
  const pub = readCchubPublicKey();
  if (!pub) return false;
  const body = keyBody(pub);
  // body is base64 ([A-Za-z0-9+/=]) — no single quotes — so single-quoting it
  // for the remote shell is injection-safe.
  const cmd = `if grep -qF '${body}' ~/.ssh/authorized_keys 2>/dev/null; then echo INSTALLED; else echo MISSING; fi`;
  const out = await execOnce(server, cmd, { timeoutMs: REMOTE_TIMEOUT_MS });
  return out.trim() === 'INSTALLED';
}

export interface InstallResult {
  alreadyInstalled: boolean;
}

/** Append the cc-remote public key to the server's `authorized_keys`,
 * generating the local pair first if needed. Idempotent: an already-present
 * key (matched by body) is left alone and reported via `alreadyInstalled`.
 * Creates `~/.ssh` (700) and `authorized_keys` (600) if missing so a clean
 * account works. The whole key line is base64-encoded for transport so its
 * spaces / comment can't break the remote shell command. */
export async function installKey(server: SshServerProfile): Promise<InstallResult> {
  const pub = ensureCchubKeyPair();
  const body = keyBody(pub);
  const b64 = Buffer.from(pub, 'utf8').toString('base64');
  const cmd = [
    `LINE=$(printf '%s' '${b64}' | base64 -d)`,
    'mkdir -p ~/.ssh && chmod 700 ~/.ssh',
    'touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys',
    `if grep -qF '${body}' ~/.ssh/authorized_keys 2>/dev/null; then echo ALREADY; else printf '%s\\n' "$LINE" >> ~/.ssh/authorized_keys && echo ADDED; fi`,
  ].join(' && ');
  const out = await execOnce(server, cmd, { timeoutMs: REMOTE_TIMEOUT_MS });
  const last = out.trim().split(/\r?\n/).pop() ?? '';
  if (last !== 'ALREADY' && last !== 'ADDED') {
    throw new Error(`unexpected installer output: ${out.trim() || '(empty)'}`);
  }
  return { alreadyInstalled: last === 'ALREADY' };
}
