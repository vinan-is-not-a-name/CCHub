import { ClientMessage } from '../../../shared/protocol.js';
import { WsCtx } from '../connection.js';

type ShellMessage = Extract<ClientMessage, { type: 'shell.reveal' }>;

/** Open a session's cwd in one of several applications, picked by `msg.app`:
 *
 *  - 'files' (default when omitted): the OS file browser — the click's
 *    original meaning. Only valid for local sessions; SSH sessions drop.
 *  - 'xshell': generate a one-shot `.xsh` and hand it to XShell. SSH sessions
 *    only (local has a proper local shell already).
 *  - 'xftp':   spawn XFTP with an `sftp://` URL. SSH sessions only.
 *  - 'vscode': launch VS Code at the cwd. Local opens directly; SSH uses the
 *    Remote-SSH extension via `--remote ssh-remote+user@host` — needs the
 *    extension installed but VS Code silently no-ops if it's not there.
 *  - 'cmd' / 'cmd-admin' / 'powershell' / 'powershell-admin': pop a new
 *    Windows console at the cwd. Local sessions only — an SSH request for
 *    these drops (the user wants a shell on the *server* they SSH'd to, and
 *    that's what XShell is for).
 *
 * Silent on every rejection path (unknown id, target/app mismatch, helper
 * missing) — the click is a UX convenience, so a failure never becomes
 * user-visible noise. */
export function handleShellMessage(ctx: WsCtx, msg: ShellMessage): void {
  const session = ctx.manager.get(msg.id);
  if (!session) return;
  const kind = session.launch.server.kind;
  const app = msg.app ?? 'files';
  if (app === 'files') {
    if (kind !== 'local') return;
    ctx.reveal(session.launch.cwd);
    return;
  }
  if (app === 'vscode') {
    if (kind === 'ssh') ctx.revealVscode(session.launch.cwd, session.launch.server);
    else ctx.revealVscode(session.launch.cwd);
    return;
  }
  if (app === 'cmd' || app === 'cmd-admin' || app === 'powershell' || app === 'powershell-admin') {
    if (kind !== 'local') return;
    ctx.revealLocalShell(session.launch.cwd, app);
    return;
  }
  // XShell / XFTP are SSH-only from here on.
  if (kind !== 'ssh') return;
  if (app === 'xshell') ctx.revealXshell(session.launch.server, session.launch.cwd);
  else if (app === 'xftp') ctx.revealXftp(session.launch.server, session.launch.cwd);
}
