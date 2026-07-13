import {
  LOCAL_DRIVES_PATH,
  parentLocalDirectory,
  parentRemoteDirectory,
  displayDirectoryPath,
  resolveDirectoryInput,
  isValidFolderName,
  folderNameOsFor,
} from '../../shared/paths.js';
import type { DirectoryEntry } from '../../shared/protocol.js';
import { el, val, setVal } from '../dom.js';
import type { AppDeps } from '../deps.js';
import { t } from '../i18n.js';
import { showAppToast } from './toast.js';

const MKDIR_ERROR_CODES = new Set(['invalid', 'exists', 'denied', 'failed']);

export function mountDirectoryDialog(deps: AppDeps) {
  const directoryDialog = el<HTMLDialogElement>('directory-dialog');
  let directoryTargetInput = 'launch-cwd';
  let directoryServerId = '';
  let directorySelectedPath = '';
  // The server-resolved path of the listing currently on screen — the parent
  // that "New folder" creates into and reloads after a successful mkdir.
  let currentListedPath = '';
  // 'directory' = original behavior (click dir to navigate, Select confirms
  // the current path). 'file' = also list regular files; clicking a file
  // writes its path to the target input and closes the dialog in one step.
  let directoryMode: 'directory' | 'file' = 'directory';

  const newFolderRow = el('directory-newfolder-row');
  const newFolderName = el<HTMLInputElement>('directory-newfolder-name');
  const newFolderToggle = el<HTMLButtonElement>('directory-newfolder');

  el<HTMLButtonElement>('directory-go').onclick = () =>
    loadDirectory(resolveDirectoryInput(val('directory-path')));
  el<HTMLButtonElement>('directory-up').onclick = () =>
    loadDirectory(parentDirectory(val('directory-path')));
  el<HTMLButtonElement>('directory-select').onclick = () =>
    setVal(directoryTargetInput, directorySelectedPath || val('directory-path'));

  // The path input lives inside <form method="dialog">, so a bare Enter submits
  // the form and fires the default primary button (#directory-select = Select).
  // Users expect Enter to mean "go to this path", so intercept it and route to
  // Go instead of letting the submit through.
  el<HTMLInputElement>('directory-path').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    void loadDirectory(resolveDirectoryInput(val('directory-path')));
  });

  newFolderToggle.onclick = () => (newFolderRow.hidden ? openNewFolderRow() : closeNewFolderRow());
  el<HTMLButtonElement>('directory-newfolder-cancel').onclick = () => closeNewFolderRow();
  el<HTMLButtonElement>('directory-newfolder-create').onclick = () => void createFolder();
  newFolderName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      // Same form-submit trap as the path input — Enter here must Create, not Select.
      e.preventDefault();
      void createFolder();
    } else if (e.key === 'Escape') {
      // Dismiss the inline row without letting Escape bubble up to close the dialog.
      e.preventDefault();
      e.stopPropagation();
      closeNewFolderRow();
    }
  });

  deps.bus.on('launch:select-cwd', ({ targetInput, serverId, mode }) => {
    const server = deps.store.getServer(serverId);
    if (!server) {
      showAppToast(t('directory.selectServerFirst'), 'error');
      return;
    }
    directoryTargetInput = targetInput;
    directoryServerId = serverId;
    directoryMode = mode ?? 'directory';
    closeNewFolderRow();
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

  function openNewFolderRow() {
    newFolderRow.hidden = false;
    newFolderName.value = '';
    newFolderName.focus();
  }

  function closeNewFolderRow() {
    newFolderRow.hidden = true;
    newFolderName.value = '';
  }

  // "New folder" only makes sense inside a real directory — the "This PC" drive
  // list (empty/sentinel path) has no filesystem location to create into.
  function updateNewFolderAvailability() {
    const usable = Boolean(currentListedPath) && currentListedPath !== LOCAL_DRIVES_PATH;
    newFolderToggle.disabled = !usable;
    if (!usable) closeNewFolderRow();
  }

  async function createFolder() {
    const server = directoryServer();
    if (!server) {
      showAppToast(t('directory.selectServerFirst'), 'error');
      return;
    }
    const name = newFolderName.value.trim();
    if (!isValidFolderName(name, folderNameOsFor(server.os))) {
      showAppToast(t('directory.mkdir.error.invalid'), 'error');
      return;
    }
    const parent = currentListedPath;
    if (!parent || parent === LOCAL_DRIVES_PATH) {
      showAppToast(t('directory.mkdir.error.failed'), 'error');
      return;
    }
    try {
      const result = await deps.rpc.request(
        'launch.cwd.mkdir.result',
        (requestId) => ({ type: 'launch.cwd.mkdir', serverId: server.id, parent, name, requestId }),
      );
      if (!result.ok) {
        const code = result.error && MKDIR_ERROR_CODES.has(result.error) ? result.error : 'failed';
        showAppToast(t(`directory.mkdir.error.${code}`), 'error');
        return;
      }
      closeNewFolderRow();
      showAppToast(t('directory.mkdir.created'), 'info');
      await loadDirectory(parent);
    } catch {
      showAppToast(t('directory.mkdir.error.failed'), 'error');
    }
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
    currentListedPath = path;
    updateNewFolderAvailability();
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
