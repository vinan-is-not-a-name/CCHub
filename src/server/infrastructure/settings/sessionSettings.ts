import { rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ResolvedLaunch } from '../../../shared/protocol.js';
import { ANTHROPIC_ENV_KEYS } from '../../../shared/envKeys.js';

/**
 * Per-session `--settings` file for LOCAL sessions.
 *
 * cc's `--settings` accepts either a JSON string or a path, and cchub has always
 * used the string form (see CliLaunchSpec.apiEnv) — it is what SSH launches
 * need, and it keeps the API key out of the remote host's filesystem.
 *
 * On Windows that form cannot work. The command cchub spawns goes through
 * `cmd.exe` to `claude.cmd` (the npm shim) to node, and the JSON's quotes have
 * to survive TWO parses. Measured against the real chain, every encoding fails:
 * a bare `{…}` is split into tokens, cmd's `""` escape collapses to NOTHING
 * rather than a quote (and leaves the string unterminated, swallowing the rest
 * of the command line into the same argument), the backslash form arrives
 * mangled, and caret-escaping is split too. The result is cc reporting
 * `Invalid JSON provided to --settings` on every local session — and, when the
 * mangling happens to yield something path-shaped, `Settings file not found:`.
 *
 * So local sessions get a file instead. It lives in the OS temp dir next to the
 * MCP config, is written per session, and is removed when the session exits for
 * good (the same lifetime the MCP grant has). The API key does land on disk
 * here — under the per-user temp directory, and only for the local transport,
 * where the key is already in the session's process env and in cchub's own
 * config file. Which is why SSH keeps the inline form: there the file would be
 * a new copy on a machine cchub does not own.
 */
export interface SessionSettingsGrant {
  /** Absolute path to this session's `--settings` file. */
  path: string;
}

/** The ANTHROPIC_* subset of a profile env — the keys cc's settings `env`
 * block is meant to carry. */
export function pickApiEnv(profileEnv: ResolvedLaunch['profileEnv']): Record<string, string> | undefined {
  if (!profileEnv) return undefined;
  const out: Record<string, string> = {};
  for (const key of ANTHROPIC_ENV_KEYS) {
    const value = profileEnv[key];
    if (value) out[key] = value;
  }
  return out;
}

/**
 * The settings a launch hands cc through `--settings`, independent of how they
 * are carried. Built once here so the inline string and the written file can
 * never drift apart — they are the same object, only the carrier differs.
 *
 * Returns `{}` when the launch has nothing to say, which callers read as "add
 * no --settings at all" rather than writing an empty file or an empty flag.
 */
export function buildSettingsPayload(launch: ResolvedLaunch): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const env = pickApiEnv(launch.profileEnv);
  if (env && Object.keys(env).length > 0) payload.env = env;
  // cc has no env var or CLI flag for this, only a settings key (2.1.235).
  // Emitted only when ON, like skipPermissions: an unchecked box means "cchub
  // does not turn it on", not "assert false over the user's own settings".
  if (launch.skipWebFetchPreflight) payload.skipWebFetchPreflight = true;
  return payload;
}

export interface SettingsProvisioner {
  provision(sessionId: string, settings: Record<string, unknown>): SessionSettingsGrant;
  cleanup(sessionId: string): void;
}

export class TmpFileSettingsProvisioner implements SettingsProvisioner {
  private readonly paths = new Map<string, string>();

  provision(sessionId: string, settings: Record<string, unknown>): SessionSettingsGrant {
    const path = join(tmpdir(), `cchub-settings-${sessionId}.json`);
    // 0600 where the platform honours it: the file carries the profile's API
    // key, so nothing beyond the owning user has any reason to read it.
    writeFileSync(path, JSON.stringify(settings), { encoding: 'utf8', mode: 0o600 });
    this.paths.set(sessionId, path);
    return { path };
  }

  cleanup(sessionId: string): void {
    const path = this.paths.get(sessionId);
    if (!path) return;
    this.paths.delete(sessionId);
    try { rmSync(path); } catch { /* already gone — fine */ }
  }
}
