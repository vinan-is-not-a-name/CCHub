import type { CondaEnvEntry } from '../../../shared/protocol.js';
import { el } from '../../dom.js';
import type { AppDeps } from '../../deps.js';

export interface CondaSelect {
  /** Repopulate options for `serverId`. If `pendingValue` is provided and exists in the result, select it. */
  refresh(serverId: string | undefined, pendingValue?: string): Promise<void>;
}

/**
 * Drive a <select id={selectId}> against `launch.conda.list`. Renders Loading
 * while in flight, ignores stale responses (last-write-wins), preserves the
 * current selection across refreshes, and surfaces discovery errors as the
 * placeholder option's label.
 */
export function bindCondaSelect(deps: AppDeps, selectId: string): CondaSelect {
  let seq = 0;

  return {
    async refresh(serverId, pendingValue) {
      const select = el<HTMLSelectElement>(selectId);
      const mySeq = ++seq;
      select.disabled = true;
      select.innerHTML = '<option value="">Loading conda envs...</option>';

      let envs: CondaEnvEntry[] = [];
      let error: string | undefined;
      try {
        const result = await deps.rpc.request(
          'launch.conda.list.result',
          (requestId) => ({ type: 'launch.conda.list', serverId, requestId }),
        );
        if (mySeq !== seq) return; // stale response
        envs = result.envs;
        error = result.error;
      } catch (err) {
        if (mySeq !== seq) return;
        error = err instanceof Error ? err.message : String(err);
      }

      const previous = select.value;
      select.disabled = false;
      select.innerHTML = '';
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = error ? 'No conda env (discovery failed)' : 'No conda env';
      select.appendChild(blank);
      for (const env of envs) {
        const opt = document.createElement('option');
        opt.value = env.name;
        opt.textContent = env.path ? `${env.name} — ${env.path}` : env.name;
        select.appendChild(opt);
      }
      const choice = pendingValue ?? previous;
      if (choice && [...select.options].some((opt) => opt.value === choice)) select.value = choice;
    },
  };
}
