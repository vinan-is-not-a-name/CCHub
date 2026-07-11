/**
 * Where conda might be installed on a remote host. Order matters — earlier
 * entries win when multiple are present (matches the historical fallback
 * order in shell.ts and condaList.ts).
 */
export const REMOTE_CONDA_PREFIXES = [
  '$HOME/miniconda3',
  '$HOME/miniforge3',
  '$HOME/anaconda3',
  '/opt/conda',
] as const;

/**
 * Where conda might be installed on a Windows host. Mirrors REMOTE_CONDA_PREFIXES
 * for cmd.exe activation: we cannot eval a hook script the way `bash -lc` can,
 * so the only knob is making sure `conda.bat` is reachable on PATH. cmd.exe
 * happily tolerates non-existent PATH entries, so listing every plausible
 * install location is harmless.
 *
 * `%USERPROFILE%` is expanded by cmd.exe at activation time, so this list
 * works regardless of which user runs cchub.
 */
export const WIN_CONDA_PREFIXES = [
  '%USERPROFILE%\\miniconda3',
  '%USERPROFILE%\\miniforge3',
  '%USERPROFILE%\\anaconda3',
  '%USERPROFILE%\\mambaforge',
  'C:\\ProgramData\\Miniconda3',
  'C:\\ProgramData\\miniforge3',
  'C:\\ProgramData\\Anaconda3',
  'C:\\tools\\miniforge3',
  'C:\\tools\\miniconda3',
] as const;

/** `<prefix>/bin` for each candidate, joined into a PATH-style list (colon-separated). */
export function condaBinPath(): string {
  return REMOTE_CONDA_PREFIXES.map((p) => `${p}/bin`).join(':');
}

/**
 * Joined PATH segment for Windows containing every prefix's `condabin` and
 * `Scripts` directories, semicolon-separated. Prepend this to `%PATH%` before
 * `conda activate` so that `conda.bat` resolves even when the parent process
 * never ran `conda init cmd.exe`.
 *
 * `condabin` first (it's the modern init entry point), `Scripts` as the
 * fallback for older installs.
 */
export function winCondaPathPrepend(): string {
  return WIN_CONDA_PREFIXES
    .flatMap((p) => [`${p}\\condabin`, `${p}\\Scripts`])
    .join(';');
}

/** `<prefix>/bin/conda` for each candidate. */
export function condaBinaryCandidates(): string[] {
  return REMOTE_CONDA_PREFIXES.map((p) => `${p}/bin/conda`);
}

/** `<prefix>/etc/profile.d/conda.sh` for each candidate. */
export function condaProfileScripts(): string[] {
  return REMOTE_CONDA_PREFIXES.map((p) => `${p}/etc/profile.d/conda.sh`);
}

/**
 * Login shell profiles sourced to pick up a user-installed `conda` in a
 * non-interactive bash. Single source of truth for both the activation path
 * (shell.ts) and the env-listing path (condaList.ts).
 */
export const REMOTE_BASH_PROFILES = ['$HOME/.bashrc', '$HOME/.bash_profile', '$HOME/.profile'] as const;

/** Quoted, space-joined list for use in `for profile in <list>; do ...`. */
export function bashProfileList(): string {
  return REMOTE_BASH_PROFILES.map((p) => `"${p}"`).join(' ');
}

/** A best-effort loop that sources each known profile, swallowing errors. */
export function bashProfileSourceSnippet(): string {
  return `for profile in ${bashProfileList()}; do
  [ -r "$profile" ] && . "$profile" >/dev/null 2>&1 || true
done`;
}
