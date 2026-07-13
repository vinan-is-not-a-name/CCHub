// Path protocol shared by client and server. Keep this module free of
// node:fs / node:path / process so it stays import-safe for the browser.

export const LOCAL_DRIVES_PATH = '__cchub_drives__';
export const LOCAL_DRIVES_DISPLAY = 'This PC';

export interface PathSplit {
  parent: string;
  filter: string;
}

/** Split a Windows-style path into the parent directory and filename filter prefix. */
export function splitLocalPath(input: string, fallbackParent = ''): PathSplit {
  const normalized = normalizeLocalPath(input);
  if (!normalized) return { parent: fallbackParent, filter: '' };
  if (/^[A-Za-z]:[\\/]?$/.test(normalized)) return { parent: `${normalized[0]}:\\`, filter: '' };
  if (normalized.endsWith('\\') || normalized.endsWith('/')) return { parent: normalized, filter: '' };
  const sep = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
  if (sep === -1) return { parent: fallbackParent, filter: normalized };
  if (sep === 2 && /^[A-Za-z]:[\\/]/.test(normalized)) return { parent: `${normalized.slice(0, 2)}\\`, filter: normalized.slice(3) };
  return { parent: normalized.slice(0, sep), filter: normalized.slice(sep + 1) };
}

/** Split a POSIX-style path into the parent directory and filename filter prefix. */
export function splitRemotePath(input: string): PathSplit {
  const normalized = input.trim() || '/';
  if (normalized === '/') return { parent: '/', filter: '' };
  if (normalized.endsWith('/')) return { parent: normalized.replace(/\/+$/, '') || '/', filter: '' };
  const idx = normalized.lastIndexOf('/');
  if (idx < 0) return { parent: '.', filter: normalized };
  return { parent: normalized.slice(0, idx) || '/', filter: normalized.slice(idx + 1) };
}

/** Compute the parent of a Windows-style path; returns LOCAL_DRIVES_PATH at the root of "This PC". */
export function parentLocalDirectory(input: string): string {
  if (input === LOCAL_DRIVES_PATH || input === LOCAL_DRIVES_DISPLAY) return LOCAL_DRIVES_PATH;
  const normalized = normalizeLocalPath(input).replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:$/.test(normalized)) return LOCAL_DRIVES_PATH;
  const sep = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
  if (sep === 2 && /^[A-Za-z]:[\\/]?/.test(normalized)) return `${normalized.slice(0, 2)}\\`;
  return sep > 2 ? normalized.slice(0, sep) : LOCAL_DRIVES_PATH;
}

/** Compute the parent of a POSIX-style path; '/' is its own parent. */
export function parentRemoteDirectory(input: string): string {
  const normalized = input.replace(/\/+$/, '') || '/';
  if (normalized === '/') return '/';
  return normalized.slice(0, normalized.lastIndexOf('/')) || '/';
}

/** Join a single child segment onto a POSIX parent directory. Used server-side
 * to build the mkdir target for SSH targets, where node's `path.join` would
 * wrongly emit backslashes when the cchub host is Windows. `name` is assumed to
 * already be a validated single segment (see isValidFolderName). */
export function joinRemotePath(parent: string, name: string): string {
  const base = parent.replace(/\/+$/, '');
  return base === '' ? `/${name}` : `${base}/${name}`;
}

/** Filesystem family that governs folder-name rules. Linux and macOS share the
 * same near-permissive rules, so they collapse to 'posix'; only Windows is
 * meaningfully stricter. */
export type FolderNameOs = 'windows' | 'posix';

/** Map a target server OS to its folder-name filesystem family, so callers
 * don't hard-code the linux/macos → posix collapse. Client and server both
 * route through this to keep pre-flight validation identical on both sides. */
export function folderNameOsFor(os: 'windows' | 'linux' | 'macos'): FolderNameOs {
  return os === 'windows' ? 'windows' : 'posix';
}

// POSIX path segments are near-anything: only the separator `/` and the NUL
// byte are illegal. `: " < > | ? * \` are all legal filenames on Linux/macOS,
// so we must not reject them there.
// eslint-disable-next-line no-control-regex
const POSIX_ILLEGAL_FOLDER_CHARS = /[\x00/]/;

// Windows additionally forbids `< > : " / \ | ? *` and the ASCII control chars
// (0x00-0x1f). The double quote is written as \x22 so no literal quote sits in
// the character class.
// eslint-disable-next-line no-control-regex
const WINDOWS_ILLEGAL_FOLDER_CHARS = /[\x00-\x1f<>:\x22/\\|?*]/;

// Windows reserved device names (case-insensitive), bare or with any extension
// — `CON`, `NUL`, `COM1`, `LPT3`, `CON.txt` all resolve to the device, so a
// folder can't take these names.
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** Validate a user-typed folder name for the "new folder" action against the
 * target filesystem `os`. Always rejects blank input and the `.`/`..`
 * navigation aliases. On POSIX only a path separator or NUL byte is illegal;
 * on Windows the reserved char set, device names (CON/NUL/COM1…) and a trailing
 * dot are also rejected. Guarantees the name stays a single, traversal-safe
 * segment the server can join onto the current directory. */
export function isValidFolderName(name: string, os: FolderNameOs): boolean {
  const trimmed = name.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return false;
  if (os === 'posix') return !POSIX_ILLEGAL_FOLDER_CHARS.test(trimmed);
  if (WINDOWS_ILLEGAL_FOLDER_CHARS.test(trimmed)) return false;
  if (WINDOWS_RESERVED_NAMES.test(trimmed)) return false;
  // Windows silently strips a trailing dot, so "foo." would create "foo" —
  // reject it so the created folder matches what the user typed. (A trailing
  // space can't survive the .trim() above, so no separate check is needed.)
  return !trimmed.endsWith('.');
}

/** Translate the wire-level local-drives sentinel to a friendly UI label. */
export function displayDirectoryPath(path: string): string {
  return path === LOCAL_DRIVES_PATH ? LOCAL_DRIVES_DISPLAY : path;
}

/** Reverse of displayDirectoryPath — translate the friendly label back to the wire sentinel. */
export function resolveDirectoryInput(path: string): string {
  return path === LOCAL_DRIVES_DISPLAY ? LOCAL_DRIVES_PATH : path;
}

function normalizeLocalPath(input: string): string {
  const normalized = input.trim();
  if (normalized === LOCAL_DRIVES_PATH) return normalized;
  if (/^[A-Za-z]:$/.test(normalized)) return `${normalized}\\`;
  return normalized;
}

export { normalizeLocalPath };
