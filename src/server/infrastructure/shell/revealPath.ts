import { spawn } from 'child_process';
import { platform } from 'os';

export interface RevealCommand {
  file: string;
  args: string[];
}

/** Pick the argv for opening a filesystem path in the host's native file
 * browser. Split out from the spawn so it can be unit-tested against each
 * platform without touching a real process. `path` is passed verbatim as an
 * argv element — no shell interpretation, so odd characters (spaces, `&`,
 * quotes) travel through safely. */
export function selectRevealCommand(os: NodeJS.Platform, path: string): RevealCommand {
  if (os === 'win32') return { file: 'explorer.exe', args: [path] };
  if (os === 'darwin') return { file: 'open', args: [path] };
  return { file: 'xdg-open', args: [path] };
}

/** Open `path` in the OS file browser. Detached + no stdio + swallowed errors:
 * the click is a UX convenience, not a request-response, so a missing helper
 * (`xdg-open` not installed) or a spurious ENOENT must not tear anything down.
 * unref() lets the parent Node process exit even if the child is still
 * displaying a window. */
export function revealPath(path: string): void {
  const { file, args } = selectRevealCommand(platform(), path);
  try {
    const child = spawn(file, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // spawn can throw synchronously on some platforms when the executable is
    // missing before the async 'error' handler ever fires — swallow.
  }
}
