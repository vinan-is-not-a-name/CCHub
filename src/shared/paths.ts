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
