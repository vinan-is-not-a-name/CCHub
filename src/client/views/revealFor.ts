import type { AppDeps } from '../deps.js';
import type { SessionInfo } from '../../shared/protocol.js';
import { t } from '../i18n.js';
import { showRevealMenu, type RevealMenuItem } from './revealMenu.js';

/** The single dispatch point for "user clicked the cwd link". Local sessions
 * get a 6-item menu (files / VS Code / cmd / cmd admin / PowerShell /
 * PowerShell admin); SSH sessions get 3 (XShell / XFTP / VS Code Remote-SSH).
 * The 'files' entry used to fire directly without a menu — but once VS Code
 * and the local shell variants joined the party, that special case saved
 * one click at the cost of an asymmetric UX (local: no menu, ssh: menu).
 * Uniform menu now, and 'files' is just the first item.
 *
 * Shared between the grid pane heads (`attach.ts`) and the rail chips
 * (`rail.ts`) so both entry points render the same menu — a divergence there
 * is confusing and easy to introduce as items are added. */
export function revealForSession(deps: AppDeps, info: SessionInfo, anchor: HTMLElement): void {
  const items: RevealMenuItem[] = info.target === 'local'
    ? [
        { label: t('reveal.files'),           onSelect: () => sendReveal(deps, info.id, 'files') },
        { label: t('reveal.vscode'),          onSelect: () => sendReveal(deps, info.id, 'vscode') },
        { label: t('reveal.cmd'),             onSelect: () => sendReveal(deps, info.id, 'cmd') },
        { label: t('reveal.cmd.admin'),       onSelect: () => sendReveal(deps, info.id, 'cmd-admin') },
        { label: t('reveal.powershell'),      onSelect: () => sendReveal(deps, info.id, 'powershell') },
        { label: t('reveal.powershell.admin'),onSelect: () => sendReveal(deps, info.id, 'powershell-admin') },
      ]
    : [
        { label: t('reveal.xshell'),         onSelect: () => sendReveal(deps, info.id, 'xshell') },
        { label: t('reveal.xftp'),           onSelect: () => sendReveal(deps, info.id, 'xftp') },
        { label: t('reveal.vscode.remote'),  onSelect: () => sendReveal(deps, info.id, 'vscode') },
      ];
  showRevealMenu(anchor, { items });
}

type RevealApp = NonNullable<Extract<Parameters<AppDeps['conn']['send']>[0], { type: 'shell.reveal' }>['app']>;

function sendReveal(deps: AppDeps, id: string, app: RevealApp): void {
  deps.conn.send({ type: 'shell.reveal', id, app });
}
