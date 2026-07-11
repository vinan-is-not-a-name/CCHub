import { CondaEnvEntry, DirectoryEntry, ServerProfile } from '../../../shared/protocol.js';
import { listLocalCondaEnvs, listRemoteCondaEnvs } from './condaList.js';
import { listLocalDirectories, listRemoteDirectories } from './directoryList.js';

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
