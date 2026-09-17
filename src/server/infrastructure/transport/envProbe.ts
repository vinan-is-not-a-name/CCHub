import { SshServerProfile } from '../../../shared/protocol.js';
import { RemoteEnvDiff } from '../../../shared/dto.js';
import { createSshConnection } from './sshFactory.js';

/** One probe result: the env of a single bash invocation mode plus the
 * claude it resolves. `bash -lc` is what cc-remote's session spawns use;
 * `bash -lic` is the closest thing to an interactive SSH login (the `-i`
 * makes .bashrc's `case $- in *i*) ;; *) return` guard pass), so diffing
 * the two exposes exactly what interactive login sets up that cc-remote
 * sessions lack — e.g. this-server's real claude npm-global path,
 * conda init, VLM_* exports. */
export interface RemoteEnvProbe {
  env: Record<string, string>;
  claudePath?: string;
  claudeVersion?: string;
  /** Absolute path of the editor the session's `${EDITOR:-…}` fallback would
   * resolve to — `vim` if present, else `vi`. Undefined when the host has
   * neither, which is the one case injection cannot repair. */
  editorPath?: string;
}

/** Struct-NUL probe payload. env is `KEY=VALUE\0KEY=VALUE\0...`; the two
 * claude markers ride along as their own NUL fields prefixed CCHUB_ so the
 * parser can slice them out unambiguously (a value may contain `=`). */
const PROBE_SCRIPT = [
  'env -0 | sort -z',
  `printf '\\0CCHUB_CLAUDE_PATH\\0%s' "$(command -v claude 2>/dev/null)"`,
  `printf '\\0CCHUB_CLAUDE_VERSION\\0%s' "$(timeout 10 claude --version 2>/dev/null | head -1)"`,
  // Same resolution the launch's `${EDITOR:-…}` fallback performs, so the
  // warning can name the editor the session actually got.
  `printf '\\0CCHUB_EDITOR_PATH\\0%s' "$(command -v vim || command -v vi)"`,
].join('; ');

const PROBE_TIMEOUT_MS = 8000;

/** Parse the NUL-separated probe output into a RemoteEnvProbe. Pure and
 * unit-testable — no network, no need for a live SSH server.
 *
 * Output shape: `<env-0>\0<env-1>\0...\0CCHUB_CLAUDE_PATH\0<path>\0CCHUB_CLAUDE_VERSION\0<version>`
 * so the marker names and their values are distinct NUL items. */
export function parseProbeOutput(raw: string): RemoteEnvProbe {
  const probe: RemoteEnvProbe = { env: {} };
  const items = raw.split('\0');
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    if (item === 'CCHUB_CLAUDE_PATH') { probe.claudePath = items[++i]?.trim() || undefined; continue; }
    if (item === 'CCHUB_CLAUDE_VERSION') { probe.claudeVersion = items[++i]?.trim() || undefined; continue; }
    if (item === 'CCHUB_EDITOR_PATH') { probe.editorPath = items[++i]?.trim() || undefined; continue; }
    const eq = item.indexOf('=');
    if (eq <= 0) continue;
    const key = item.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    probe.env[key] = item.slice(eq + 1);
  }
  return probe;
}

/** Run the probe for one bash invocation mode over SSH. Returns a rejected
 * promise on connection/exec failure or timeout — callers treat that as
 * "no answer", never as a session error. */
export async function probeRemoteEnv(server: SshServerProfile, opts: { interactive: boolean }): Promise<RemoteEnvProbe> {
  const conn = await createSshConnection(server);
  return new Promise<RemoteEnvProbe>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { conn.end(); } catch {}
      reject(new Error('env probe timeout'));
    }, PROBE_TIMEOUT_MS);
    const flag = opts.interactive ? 'i' : '';
    conn.exec(`bash -l${flag}c ${JSON.stringify(PROBE_SCRIPT)}`, { pty: { term: 'xterm-256color', cols: 80, rows: 24 } }, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        try { conn.end(); } catch {}
        reject(err);
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('data', (d: Buffer) => chunks.push(d));
      stream.on('close', () => {
        clearTimeout(timer);
        try { conn.end(); } catch {}
        resolve(parseProbeOutput(Buffer.concat(chunks).toString('utf8')));
        return;
      });
      stream.stderr.on('data', () => {}); // drain — bash -i without a tty would warn
    });
  });
}

/** Keys that legitimately differ between interactive and non-interactive
 * bash invocations and carry no user-meaning: shell bookkeeping only.
 * Everything else that interactive login has and cc-remote's session does
 * not — CONDA_*, VLM_*, HF_ENDPOINT ... — is reported. */
const NOISE_KEYS = new Set([
  '_', 'SHLVL', 'PWD', 'OLDPWD', 'TERM', 'COLORTERM', 'LS_COLORS',
  'BASH', 'BASH_ARGC', 'BASH_ARGV', 'BASH_EXECUTION_STRING',
]);

export function diffRemoteEnv(base: RemoteEnvProbe, interactive: RemoteEnvProbe): RemoteEnvDiff | null {
  const claudePathDiffers = base.claudePath !== interactive.claudePath;
  const claudeVersionDiffers = base.claudeVersion !== interactive.claudeVersion;
  const claude = claudePathDiffers || claudeVersionDiffers
    ? {
        sessionPath: base.claudePath,
        interactivePath: interactive.claudePath,
        sessionVersion: base.claudeVersion,
        interactiveVersion: interactive.claudeVersion,
      }
    : null;

  const missingKeys = Object.keys(interactive.env)
    .filter((k) => !(k in base.env) && !NOISE_KEYS.has(k))
    .sort();

  const baseDirs = pathDirs(base.env.PATH);
  const interactiveDirs = pathDirs(interactive.env.PATH);
  const missingPathDirs = interactiveDirs.filter((d) => !baseDirs.includes(d));

  const injectedEditor = pickInjectedEditor(base, interactive);

  if (!claude && !injectedEditor && missingKeys.length === 0 && missingPathDirs.length === 0) return null;
  return { claude, missingKeys, missingPathDirs, ...(injectedEditor ? { injectedEditor } : {}) };
}

/** The editor cc-remote had to supply for this session, or undefined when the
 * host already had one.
 *
 * A host that sets EDITOR/VISUAL in NEITHER invocation mode — the one this was
 * measured on sets neither, in any profile file — leaves claude with no editor
 * to launch, so Ctrl+G hangs on "Save and close editor to continue..." forever.
 * The launch answers with a `${EDITOR:-…}` fallback (see sshEditorFallback),
 * which is invisible in the terminal: the user sees a *working* Ctrl+G and no
 * reason to suspect their own interactive ssh has the same hole. Hence the
 * report.
 *
 * Deliberately requires BOTH modes to be empty: if interactive login sets one,
 * the session is diverging in the usual way and `missingKeys` already says so. */
function pickInjectedEditor(base: RemoteEnvProbe, interactive: RemoteEnvProbe): string | undefined {
  const bare = (env: Record<string, string>) => !env.EDITOR && !env.VISUAL;
  if (!bare(base.env) || !bare(interactive.env)) return undefined;
  return base.editorPath;
}

function pathDirs(pathValue: string | undefined): string[] {
  return (pathValue ?? '').split(':').filter((d) => d.length > 0);
}
