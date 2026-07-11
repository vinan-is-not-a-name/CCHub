import { execFile } from 'child_process';
import { delimiter, join } from 'path';
import { promisify } from 'util';
import { CondaEnvEntry, SshServerProfile } from '../../../shared/protocol.js';
import { execOnce } from '../transport/remoteExec.js';
import { shellQuote } from '../../utils/shellEscape.js';
import { condaBinaryCandidates, bashProfileList } from './condaPaths.js';

const execFileAsync = promisify(execFile);
const LOCAL_TIMEOUT_MS = 6000;

export async function listLocalCondaEnvs(): Promise<CondaEnvEntry[]> {
  const output = await execLocalCondaEnvList();
  return parseCondaEnvs(output);
}

export async function listRemoteCondaEnvs(server: SshServerProfile): Promise<CondaEnvEntry[]> {
  const output = await execOnce(server, remoteCondaScript());
  return parseCondaEnvs(output);
}

type LocalCommand = { file: string; args: string[] } | { command: string };

async function execLocalCondaEnvList() {
  const candidates = localCondaCandidates();
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      return 'command' in candidate
        ? (await execFileAsync('cmd.exe', ['/c', candidate.command], { timeout: LOCAL_TIMEOUT_MS })).stdout
        : (await execFileAsync(candidate.file, candidate.args, { timeout: LOCAL_TIMEOUT_MS })).stdout;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(errors.join('; '));
}

function localCondaCandidates() {
  const candidates: LocalCommand[] = [];
  const seen = new Set<string>();
  const addFile = (file: string | undefined, args = ['env', 'list', '--json']) => {
    if (!file || seen.has(file.toLowerCase())) return;
    seen.add(file.toLowerCase());
    if (file.toLowerCase().endsWith('.bat') || file.toLowerCase().endsWith('.cmd')) {
      candidates.push({ command: `"${file}" env list --json` });
      return;
    }
    candidates.push({ file, args });
  };
  const addCommand = (command: string) => {
    const key = `cmd:${command.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ command });
  };

  addFile(process.env.CONDA_EXE);
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    addFile(join(dir, 'conda.exe'));
    addFile(join(dir, 'conda.bat'));
  }
  addFile('conda.exe');
  addCommand('conda env list --json');
  return candidates;
}

function remoteCondaScript() {
  // Try `conda` from PATH first, then each known install prefix's bin/conda. This
  // mirrors `condaBinaryCandidates()` so adding a new prefix only touches one file.
  const fallbackCommands = [
    `'conda env list --json'`,
    ...condaBinaryCandidates().map((bin) => `'${bin} env list --json'`),
  ].join(' \\\n  ');
  return `bash -lc ${shellQuote(`
set -o pipefail
for cmd in \
  ${fallbackCommands}
do
  output=$(eval "$cmd" 2>/tmp/cchub_conda_error)
  code=$?
  if [ $code -eq 0 ]; then
    printf '%s' "$output"
    exit 0
  fi
done
for profile in ${bashProfileList()}; do
  if [ -r "$profile" ]; then
    output=$(. "$profile" >/dev/null 2>&1; conda env list --json 2>/tmp/cchub_conda_error)
    code=$?
    if [ $code -eq 0 ]; then
      printf '%s' "$output"
      exit 0
    fi
  fi
done
cat /tmp/cchub_conda_error 2>/dev/null || printf 'conda not found'
exit 127
`)}`;
}

export function parseCondaEnvs(output: string): CondaEnvEntry[] {
  const parsed = JSON.parse(output);
  const envs = Array.isArray(parsed.envs) ? parsed.envs : [];
  return envs.map((envPath: string) => {
    const name = envPath.includes('/envs/') || envPath.includes('\\envs\\')
      ? envPath.split(/[\\/]/).filter(Boolean).pop() || envPath
      : 'base';
    return { name, path: envPath };
  }).filter((env: CondaEnvEntry, index: number, all: CondaEnvEntry[]) => env.name && all.findIndex(x => x.name === env.name) === index);
}
