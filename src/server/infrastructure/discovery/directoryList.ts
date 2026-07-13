import { mkdir, readdir, stat } from 'fs/promises';
import { resolve } from 'path';
import { DirectoryEntry, SshServerProfile } from '../../../shared/protocol.js';
import { LOCAL_DRIVES_PATH, splitLocalPath, splitRemotePath, normalizeLocalPath, joinRemotePath, isValidFolderName, folderNameOsFor, type FolderNameOs } from '../../../shared/paths.js';
import { execOnce } from '../transport/remoteExec.js';
import { shellQuote } from '../../utils/shellEscape.js';

const MAX_ENTRIES = 80;

/** Stable failure codes for the "new folder" action. The client maps these to
 * localized toast text, so the server never emits locale-specific strings.
 *   - invalid: name rejected by isValidFolderName (or an un-creatable root)
 *   - exists:  a directory of that name is already there
 *   - denied:  filesystem refused for permission reasons (local only — remote
 *              shells can't reliably distinguish this from a generic failure)
 *   - failed:  anything else */
export type MkdirErrorCode = 'invalid' | 'exists' | 'denied' | 'failed';

export class MkdirError extends Error {
  constructor(public readonly code: MkdirErrorCode) {
    super(code);
    this.name = 'MkdirError';
  }
}

/** Create one sub-directory `name` under the local `parent`; returns its full
 * path on success. Non-recursive on purpose so an existing folder surfaces as
 * an `exists` error instead of silently succeeding. */
export async function createLocalDirectory(parent: string, name: string, os: FolderNameOs): Promise<string> {
  if (!isValidFolderName(name, os)) throw new MkdirError('invalid');
  const target = resolve(parent, name.trim());
  try {
    await mkdir(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new MkdirError('exists');
    if (code === 'EACCES' || code === 'EPERM') throw new MkdirError('denied');
    throw new MkdirError('failed');
  }
  return target;
}

/** Create one sub-directory `name` under the remote POSIX `parent` via a single
 * ssh round-trip; returns its full path on success. Uses a plain (non-`-p`)
 * mkdir and prints a stable token per outcome so the result survives locale
 * differences in the remote shell's error text. */
export async function createRemoteDirectory(server: SshServerProfile, parent: string, name: string): Promise<string> {
  if (!isValidFolderName(name, folderNameOsFor(server.os))) throw new MkdirError('invalid');
  const target = joinRemotePath(parent, name.trim());
  const quoted = shellQuote(target);
  const script = `mkdir ${quoted} 2>/dev/null && printf DONE || { test -d ${quoted} && printf EXISTS || printf FAIL; }`;
  const output = (await execOnce(server, script)).trim();
  if (output.includes('DONE')) return target;
  if (output.includes('EXISTS')) throw new MkdirError('exists');
  throw new MkdirError('failed');
}

export async function listLocalDirectories(inputPath: string, exact = false, includeFiles = false): Promise<{ path: string; entries: DirectoryEntry[] }> {
  if (inputPath === LOCAL_DRIVES_PATH) return listLocalDrives();
  const { parent, filter } = exact
    ? { parent: normalizeLocalPath(inputPath), filter: '' }
    : splitLocalPath(inputPath, process.cwd());
  const raw = await readDirectoryContents(parent, filter, includeFiles);
  const entries = raw.map<DirectoryEntry>((e) => ({ name: e.name, path: resolve(parent, e.name), kind: e.kind }));
  return { path: parent, entries };
}

export async function listRemoteDirectories(server: SshServerProfile, inputPath: string, exact = false, includeFiles = false): Promise<{ path: string; entries: DirectoryEntry[] }> {
  const { parent, filter } = exact ? { parent: inputPath || '/', filter: '' } : splitRemotePath(inputPath || '/');
  const includeFilesFlag = includeFiles ? '1' : '0';
  // Python listing so we get one round-trip regardless of listing size; the
  // `include_files` flag either widens the filter to include regular files
  // (each tagged with `kind: 'file'`) or keeps the directory-only shape.
  const script = `python3 -c ${shellQuote(`import json, os, sys
parent=sys.argv[1]
flt=sys.argv[2].lower()
include_files=sys.argv[3]=='1'
out=[]
try:
    with os.scandir(parent) as it:
        for e in it:
            if not e.name.lower().startswith(flt):
                continue
            if e.is_dir(follow_symlinks=False):
                out.append({'name': e.name, 'path': os.path.join(parent, e.name), 'kind': 'directory'})
            elif include_files and e.is_file(follow_symlinks=False):
                out.append({'name': e.name, 'path': os.path.join(parent, e.name), 'kind': 'file'})
except Exception:
    pass
out=sorted(out, key=lambda x: (x['kind']!='directory', x['name'].lower()))[:${MAX_ENTRIES}]
print(json.dumps(out))`)} ${shellQuote(parent)} ${shellQuote(filter)} ${includeFilesFlag}`;
  const output = await execOnce(server, script);
  return { path: parent, entries: JSON.parse(output || '[]') };
}

async function listLocalDrives(): Promise<{ path: string; entries: DirectoryEntry[] }> {
  const checks = await Promise.all('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(async (letter): Promise<DirectoryEntry | undefined> => {
    const drive = `${letter}:\\`;
    try {
      await readdir(drive);
      return { name: drive, path: drive, kind: 'directory' };
    } catch {
      return undefined;
    }
  }));
  return { path: LOCAL_DRIVES_PATH, entries: checks.filter((entry): entry is DirectoryEntry => Boolean(entry)) };
}

/** List the parent's immediate children as `{name, kind}` pairs, filtered by
 * prefix. When `includeFiles` is false the shape matches the pre-existing
 * directory-only picker; when true, regular files (and symlinks to them) come
 * through tagged as `file`. Directories always sort first, then files, both
 * groups alphabetized — reads better in a picker than a raw dirent order. */
async function readDirectoryContents(parent: string, filter: string, includeFiles: boolean): Promise<{ name: string; kind: 'directory' | 'file' }[]> {
  const entries = await readdir(parent, { withFileTypes: true });
  const items = await Promise.all(entries.map(async (entry) => {
    if (!entry.name.toLowerCase().startsWith(filter.toLowerCase())) return undefined;
    if (entry.isDirectory()) return { name: entry.name, kind: 'directory' as const };
    if (includeFiles && entry.isFile()) return { name: entry.name, kind: 'file' as const };
    if (entry.isSymbolicLink()) {
      try {
        const s = await stat(resolve(parent, entry.name));
        if (s.isDirectory()) return { name: entry.name, kind: 'directory' as const };
        if (includeFiles && s.isFile()) return { name: entry.name, kind: 'file' as const };
      } catch { /* dangling link — drop */ }
    }
    return undefined;
  }));
  return items
    .filter((it): it is { name: string; kind: 'directory' | 'file' } => Boolean(it))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}
