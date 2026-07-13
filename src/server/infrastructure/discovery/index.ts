import { CondaEnvEntry, DirectoryEntry, ServerProfile } from '../../../shared/protocol.js';
import { LOCAL_DRIVES_PATH, folderNameOsFor } from '../../../shared/paths.js';
import { listLocalCondaEnvs, listRemoteCondaEnvs } from './condaList.js';
import { createLocalDirectory, createRemoteDirectory, listLocalDirectories, listRemoteDirectories, MkdirError } from './directoryList.js';

export async function listTargetDirectories(
  server: ServerProfile,
  inputPath: string,
  exact = false,
  includeFiles = false,
): Promise<{ path: string; entries: DirectoryEntry[] }> {
  return server.kind === 'ssh'
    ? listRemoteDirectories(server, inputPath, exact, includeFiles)
    : listLocalDirectories(inputPath || process.cwd(), exact, includeFiles);
}

/** Create a single sub-directory under `parent` on the target server. Resolves
 * to the created path, or rejects with a MkdirError carrying a stable code the
 * ws handler forwards to the client. The "This PC" drive-list root has no real
 * filesystem path, so folder creation there is rejected as `invalid`. */
export async function createTargetDirectory(
  server: ServerProfile,
  parent: string,
  name: string,
): Promise<string> {
  if (parent === LOCAL_DRIVES_PATH) throw new MkdirError('invalid');
  return server.kind === 'ssh'
    ? createRemoteDirectory(server, parent, name)
    : createLocalDirectory(parent, name, folderNameOsFor(server.os));
}

export async function listCondaEnvs(
  server: ServerProfile,
): Promise<{ envs: CondaEnvEntry[]; error?: string }> {
  try {
    const envs = server.kind === 'ssh'
      ? await listRemoteCondaEnvs(server)
      : await listLocalCondaEnvs();
    return { envs };
  } catch (error) {
    return { envs: [], error: error instanceof Error ? error.message : String(error) };
  }
}
