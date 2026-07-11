import type { DirectoryEntry, SafeServerProfile } from '../../../shared/protocol.js';
import { el, val, setVal } from '../../dom.js';
import type { AppDeps } from '../../deps.js';

export interface CwdSuggest {
  hide(): void;
}

/**
 * On-input cwd autocomplete for SSH servers. Local servers don't need it
 * (the OS picker handles them), so this widget no-ops when the resolved
 * server isn't SSH. Backed by `launch.cwd.list`.
 */
export function bindCwdSuggest(
  deps: AppDeps,
  opts: { inputId: string; suggestionsId: string; getServer: () => SafeServerProfile | undefined },
): CwdSuggest {
  let debounce: number | undefined;

  el<HTMLInputElement>(opts.inputId).oninput = () => {
    const server = opts.getServer();
    if (server?.kind !== 'ssh') return;
    if (debounce) window.clearTimeout(debounce);
    debounce = window.setTimeout(() => void request(val(opts.inputId), server.id), 200);
  };

  function hide(): void {
    const suggestions = document.getElementById(opts.suggestionsId);
    if (!suggestions) return;
    suggestions.hidden = true;
    suggestions.innerHTML = '';
  }

  async function request(path: string, serverId: string): Promise<void> {
    try {
      const result = await deps.rpc.request(
        'launch.cwd.list.result',
        (requestId) => ({ type: 'launch.cwd.list', serverId, path, requestId }),
      );
      render(result.entries);
    } catch {
      // Connection lost or timeout — leave the input alone, hide stale suggestions.
      hide();
    }
  }

  function render(entries: DirectoryEntry[]): void {
    const suggestions = document.getElementById(opts.suggestionsId);
    if (!suggestions) return;
    suggestions.innerHTML = '';
    if (entries.length === 0) { hide(); return; }
    for (const entry of entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = entry.path;
      button.onclick = () => {
        setVal(opts.inputId, entry.path);
        hide();
      };
      suggestions.appendChild(button);
    }
    suggestions.hidden = false;
  }

  return { hide };
}
