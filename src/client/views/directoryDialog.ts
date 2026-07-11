import {
  LOCAL_DRIVES_PATH,
  parentLocalDirectory,
  parentRemoteDirectory,
  displayDirectoryPath,
  resolveDirectoryInput,
} from '../../shared/paths.js';
import type { DirectoryEntry } from '../../shared/protocol.js';
import { el, val, setVal } from '../dom.js';
import type { AppDeps } from '../deps.js';
import { t } from '../i18n.js';
import { showAppToast } from './toast.js';

export function mountDirectoryDialog(deps: AppDeps) {
  const directoryDialog = el<HTMLDialogElement>('directory-dialog');
  let directoryTargetInput = 'launch-cwd';
  let directoryServerId = '';
  let directorySelectedPath = '';
  // 'directory' = original behavior (click dir to navigate, Select confirms
  // the current path). 'file' = also list regular files; clicking a file
  // writes its path to the target input and closes the dialog in one step.
  let directoryMode: 'directory' | 'file' = 'directory';

  el<HTMLButtonElement>('directory-go').onclick = () =>
    loadDirectory(resolveDirectoryInput(val('directory-path')));
  el<HTMLButtonElement>('directory-up').onclick = () =>
    loadDirectory(parentDirectory(val('directory-path')));
  el<HTMLButtonElement>('directory-select').onclick = () =>
    setVal(directoryTargetInput, directorySelectedPath || val('directory-path'));

  deps.bus.on('launch:select-cwd', ({ targetInput, serverId, mode }) => {
    const server = deps.store.getServer(serverId);
    if (!server) {
      showAppToast(t('directory.selectServerFirst'), 'error');
      return;
    }
    directoryTargetInput = targetInput;
    directoryServerId = serverId;
    directoryMode = mode ?? 'directory';
    const start = val(targetInput) || (server.kind === 'ssh' ? '/' : LOCAL_DRIVES_PATH);
    const label = directoryMode === 'file' ? t('directory.target.pickFile').replace('{name}', server.name) : t('directory.target.dir').replace('{name}', server.name);
    el('directory-target').textContent = label;
    directoryDialog.showModal();
    void loadDirectory(start);
  });

  function directoryServer() {
    return deps.store.getServer(directoryServerId);
  }

  function parentDirectory(path: string) {
    const server = directoryServer();
    return server?.kind === 'ssh' ? parentRemoteDirectory(path) : parentLocalDirectory(path);
  }

  async function loadDirectory(path: string) {
    const server = directoryServer();
    if (!server) {
      showAppToast(t('directory.selectServerFirst'), 'error');
      return;
    }
    directorySelectedPath = path === LOCAL_DRIVES_PATH ? '' : path;
    setVal('directory-path', displayDirectoryPath(path));
    const list = el('directory-list');
    list.textContent = t('directory.loading');
    try {
      const result = await deps.rpc.request(
        'launch.cwd.list.result',
        (requestId) => ({
          type: 'launch.cwd.list',
          serverId: server.id,
          path,
          requestId,
          exact: true,
          includeFiles: directoryMode === 'file',
        }),
      );
      renderList(result.path, result.entries);
    } catch (err) {
      list.textContent = `${t('directory.failedPrefix')}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  function renderList(path: string, entries: DirectoryEntry[]) {
    directorySelectedPath = path === LOCAL_DRIVES_PATH ? '' : path;
    setVal('directory-path', displayDirectoryPath(path));
    const list = el('directory-list');
    list.innerHTML = '';
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'directory-empty';
      empty.textContent = directoryMode === 'file' ? t('directory.empty.files') : t('directory.empty.dirs');
      list.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement('button');
      row.type = 'button';
      // Data attribute drives per-kind styling (dir icon vs file icon in CSS)
      // without needing to inline SVG here.
      row.dataset.kind = entry.kind ?? 'directory';
      row.className = 'directory-row';
      row.textContent = entry.name;
      row.title = entry.path;
      row.onclick = () => {
        if (entry.kind === 'file') {
          // File mode: single-click is the whole picker interaction. Write
          // the path to the target input and close — no separate Select
          // confirmation, matches the "OS file picker" mental model.
          setVal(directoryTargetInput, entry.path);
          directoryDialog.close();
          return;
        }
        void loadDirectory(entry.path);
      };
      list.appendChild(row);
    }
  }
}
