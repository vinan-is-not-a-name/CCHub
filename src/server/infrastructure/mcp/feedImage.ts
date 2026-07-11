import { statSync } from 'fs';
import { isAbsolute, extname, normalize, relative, sep } from 'path';
import { tmpdir } from 'os';
import { SessionState, SessionTarget } from '../../../shared/protocol.js';
import { FEED_IMAGE_EXTENSIONS, FEED_IMAGE_MAX_BYTES } from '../../../shared/mcp.js';

/**
 * The single capability the MCP layer is handed. It can feed an image to a
 * session and nothing else — no kill, no output read, no session enumeration,
 * no env access. Even a buggy tool handler structurally cannot reach another
 * session's machinery. This is the whitelist-of-behavior counterpart to the
 * whitelist-of-data SessionContext.
 */
export interface FeedOptions {
  /** Send the trailing CR after the bracketed paste so cc submits immediately.
   * Default true — the MCP `feed_image` tool relies on it, since the agent that
   * called the tool cannot subsequently press Enter itself. The browser
   * paste-image path passes `false`: the user hit Ctrl+V, so THEY press Enter
   * (possibly after typing a prompt to accompany the image). */
  autoSubmit?: boolean;
}

export interface SessionFeeder {
  /** Validate the image, gate on session state/target, then paste (and, by
   * default, submit) it into that session's PTY. Rejects (throws) with an
   * agent-readable message on any failure so the calling claude can
   * self-correct in its loop. */
  feed(sessionId: string, imagePath: string, opts?: FeedOptions): Promise<void>;
}

/** Just the slice of a session feed needs. ManagedSession satisfies it
 * structurally, and tests can supply a trivial fake without a real PTY. */
export interface FeedTarget {
  readonly state: SessionState;
  /** Exposes `server.kind` (used to gate the feed to local sessions) and `cwd`
   * (used by `validateImagePath` to bound the paths a caller can feed). */
  readonly launch: { server: { kind: SessionTarget }; cwd: string };
  paste(text: string, opts?: { autoSubmit?: boolean }): void;
  /** Append this image's absolute path to the session's lifetime image log so
   * the `[Image #N]` chips cc later renders into its scrollback can be looked up
   * by occurrence index when the user clicks them in the browser. The Nth call
   * (1-based) defines what the Nth `[Image #...]` placeholder in the terminal
   * buffer points to — regardless of cc's per-turn `#N` numbering. */
  recordImage(imagePath: string): void;
}

export interface SessionLookup {
  get(id: string): FeedTarget | undefined;
}

export interface ValidateImageOptions {
  /** When non-empty, the image path must resolve inside at least one of these
   * roots. The `feed()` implementation always passes the session's cwd plus
   * `os.tmpdir()` so agent-produced files (chart.png in the workspace, tmp
   * artefacts) land in-bounds while an attacker who slips an MCP POST past
   * the loopback / Origin / auth checks still can't ask the server to read
   * arbitrary files. `paste-image` fabricates the path under `tmpdir()`
   * itself, so tmpdir alone covers that route. */
  allowedRoots?: string[];
}

/** Return `true` iff `candidate` resolves inside `root`. Both arguments are
 * normalized first (Windows path.normalize trims `..` and folds `/` → `\`).
 * We use `path.relative` rather than string prefix matching so
 * `/foo` vs `/foobar` doesn't accidentally match. */
function isPathInside(candidate: string, root: string): boolean {
  const rel = relative(normalize(root), normalize(candidate));
  if (rel === '') return true;
  if (rel === '..') return false;
  if (rel.startsWith('..' + sep)) return false;
  return !isAbsolute(rel);
}

/**
 * Pure, side-effect-free validation of a candidate image path. Throws a
 * descriptive Error on any violation; returns normally when the path is safe
 * to paste. We don't own the image's lifecycle (the agent created it), so any
 * TOCTOU between this check and the paste is the agent's responsibility — we
 * only guard against obvious mistakes (relative path, wrong type, missing,
 * absurdly large, out-of-bounds).
 */
export function validateImagePath(imagePath: string, opts: ValidateImageOptions = {}): void {
  if (typeof imagePath !== 'string' || imagePath.length === 0) {
    throw new Error('image path is required');
  }
  if (!isAbsolute(imagePath)) {
    throw new Error(`image path must be absolute: ${imagePath}`);
  }
  if (/[\r\n\0]/.test(imagePath)) {
    throw new Error('image path contains control characters');
  }
  const ext = extname(imagePath).slice(1).toLowerCase();
  if (!FEED_IMAGE_EXTENSIONS.includes(ext as (typeof FEED_IMAGE_EXTENSIONS)[number])) {
    throw new Error(`unsupported image type ".${ext}" (allowed: ${FEED_IMAGE_EXTENSIONS.join(', ')})`);
  }
  if (opts.allowedRoots && opts.allowedRoots.length > 0) {
    const inAllowed = opts.allowedRoots.some((root) => isPathInside(imagePath, root));
    if (!inAllowed) {
      throw new Error(`image path is outside the session's allowed roots: ${imagePath}`);
    }
  }
  let stat;
  try {
    stat = statSync(imagePath);
  } catch {
    throw new Error(`image not found: ${imagePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`image path is not a file: ${imagePath}`);
  }
  if (stat.size > FEED_IMAGE_MAX_BYTES) {
    throw new Error(`image too large: ${stat.size} bytes (max ${FEED_IMAGE_MAX_BYTES})`);
  }
}

/**
 * Bridge from the (privileged) session registry to the (narrow) SessionFeeder
 * capability. This factory is the ONE place that touches the manager; the MCP
 * route receives only the returned SessionFeeder, never the manager itself.
 */
export function makeSessionFeeder(lookup: SessionLookup): SessionFeeder {
  return {
    async feed(sessionId: string, imagePath: string, opts?: FeedOptions): Promise<void> {
      const session = lookup.get(sessionId);
      if (!session) {
        throw new Error(`session not found: ${sessionId}`);
      }
      if (session.launch.server.kind !== 'local') {
        throw new Error('image feed is only supported for local sessions in this version');
      }
      if (session.state === 'exited') {
        throw new Error('session has exited; cannot feed image');
      }
      // Bound the accepted paths to (a) the session's own working directory
      // (agent-produced charts / renders live here) and (b) the OS tmp dir
      // (the paste-image route writes there, and it's the conventional spot
      // for short-lived artefacts). Anything outside both — e.g. asking us
      // to feed `C:\Users\me\.ssh\id_rsa.png` — is rejected before we touch
      // the disk.
      validateImagePath(imagePath, { allowedRoots: [session.launch.cwd, tmpdir()] });
      session.recordImage(imagePath);
      session.paste(imagePath, opts);
    },
  };
}
