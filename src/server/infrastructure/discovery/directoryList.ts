import { readdir, stat } from 'fs/promises';
import { resolve } from 'path';
import { DirectoryEntry, SshServerProfile } from '../../../shared/protocol.js';
import { LOCAL_DRIVES_PATH, splitLocalPath, splitRemotePath, normalizeLocalPath } from '../../../shared/paths.js';
import { execOnce } from '../transport/remoteExec.js';
import { shellQuote } from '../../utils/shellEscape.js';

const MAX_ENTRIES = 80;

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
