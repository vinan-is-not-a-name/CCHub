import { el } from '../dom.js';
import type { AppDeps } from '../deps.js';
import { isNotifyEnabled, setNotifyEnabled } from './notify.js';
import { setupDialogTabs } from './dialogTabs.js';
import { getLocale, setLocale, t, type Locale } from '../i18n.js';

/** Small dialog that hosts app-level preferences: browser notifications toggle
 * (stored in localStorage — browser-bound) and remote-client exe paths
 * (stored server-side in appSettings — same trust boundary as the rest of
 * config, single-user local-first model).
 *
 * The Detect button asks the server to scan PATH + `C:\Program Files\NetSarang\`
 * for Xshell.exe / Xftp.exe; results fill the inputs but don't persist until
 * the user clicks Save. Save writes the current input values (empty string
 * clears a field) and closes; Cancel discards changes. */
export function mountSettingsDialog(deps: AppDeps): void {
  const dialog = el<HTMLDialogElement>('settings-dialog');
  const notifyCheckbox = el<HTMLInputElement>('settings-notify');
  const localeSelect = el<HTMLSelectElement>('settings-locale');
  const xshellInput = el<HTMLInputElement>('settings-xshell-path');
  const xftpInput = el<HTMLInputElement>('settings-xftp-path');
  const vscodeInput = el<HTMLInputElement>('settings-vscode-path');
  const detectButton = el<HTMLButtonElement>('settings-detect');
  const detectStatus = el<HTMLParagraphElement>('settings-detect-status');
  const xshellBrowse = el<HTMLButtonElement>('settings-xshell-browse');
  const xftpBrowse = el<HTMLButtonElement>('settings-xftp-browse');
  const vscodeBrowse = el<HTMLButtonElement>('settings-vscode-browse');
  const saveButton = el<HTMLButtonElement>('settings-save');
  const sshkeyPublic = el<HTMLTextAreaElement>('settings-sshkey-public');
  const sshkeyGenerate = el<HTMLButtonElement>('settings-sshkey-generate');
  const sshkeyCopy = el<HTMLButtonElement>('settings-sshkey-copy');
  const sshkeyStatus = el<HTMLParagraphElement>('settings-sshkey-status');
  const sshkeyPrivateHint = el<HTMLParagraphElement>('settings-sshkey-private-hint');
  const sshkeyPrivatePath = el<HTMLElement>('settings-sshkey-private-path');

  // Serial number the Detect button emits with each request; the response is
  // only applied if it matches, so a rapid re-click doesn't let a stale scan
  // overwrite a newer one.
  let pendingDetectId: string | null = null;

  setupDialogTabs(dialog);

  deps.bus.on('settings:open', () => {
    populateFromStore();
    detectStatus.textContent = '';
    sshkeyStatus.textContent = '';
    deps.conn.send({ type: 'config.sshkey.get' });
    dialog.showModal();
  });

  function populateFromStore(): void {
    const settings = deps.store.get().config?.appSettings ?? {};
    xshellInput.value = settings.xshellPath ?? '';
    xftpInput.value = settings.xftpPath ?? '';
    vscodeInput.value = settings.vscodePath ?? '';
    notifyCheckbox.checked = isNotifyEnabled();
    localeSelect.value = getLocale();
  }

  // Locale is a UI-only preference (localStorage) and applies immediately —
  // no need to wait for Save. Matches how the topbar theme / font selects
  // work, and gives instant visual feedback that the language changed.
  localeSelect.onchange = () => setLocale(localeSelect.value as Locale);

  detectButton.onclick = () => {
    const requestId = String(Date.now());
    pendingDetectId = requestId;
    detectStatus.textContent = t('settings.detect.scanning');
    deps.conn.send({ type: 'config.settings.detect', requestId });
  };

  xshellBrowse.onclick = () => openPicker('settings-xshell-path');
  xftpBrowse.onclick = () => openPicker('settings-xftp-path');
  vscodeBrowse.onclick = () => openPicker('settings-vscode-path');

  /** Fire the shared directory picker in file mode against the local server
   * (server-host machine = user's workstation under the single-user model).
   * Reuses the same picker the launch dialog
   * uses for cwd selection — same UX, same server-side listing, no new
   * component. Falls back to the raw target input if no local server is
   * configured (edge case: user has ssh-only setups). */
  function openPicker(targetInput: string): void {
    const local = deps.store.get().config?.servers.find((s) => s.kind === 'local');
    if (!local) {
      detectStatus.textContent = t('settings.detect.noLocal');
      return;
    }
    deps.bus.emit('launch:select-cwd', {
      targetInput,
      serverId: local.id,
      mode: 'file',
    });
  }

  deps.conn.onMessage((msg) => {
    if (msg.type !== 'config.settings.detected') return;
    if (msg.requestId !== pendingDetectId) return;
    pendingDetectId = null;
    // Detect is a "please find these" action, not a "please only fill blanks"
    // one — the user clicked the button explicitly, so a non-empty existing
    // path should be replaced with what the scan found. A `null` result means
    // "still not found", which leaves the current input alone (clobbering to
    // empty would erase whatever the user just typed and is never what they
    // want after a failed scan).
    if (msg.xshellPath) xshellInput.value = msg.xshellPath;
    if (msg.xftpPath) xftpInput.value = msg.xftpPath;
    if (msg.vscodePath) vscodeInput.value = msg.vscodePath;
    detectStatus.textContent = describeDetectResult({
      XShell: msg.xshellPath,
      XFTP: msg.xftpPath,
      'VS Code': msg.vscodePath,
    });
  });

  // SSH key tab. Generate creates the pair on first use, or regenerates after
  // an explicit confirm (regeneration invalidates the key already imported
  // into XShell / installed on servers). Copy puts the public key on the
  // clipboard. The pair lives server-side under ~/.cchub/keys — the client
  // only ever sees the public key text + the private key's path for the
  // one-time XShell import.
  sshkeyGenerate.onclick = () => {
    const hasKey = sshkeyPublic.value.trim().length > 0;
    if (hasKey && !confirm(t('settings.sshkey.regenWarn'))) return;
    sshkeyStatus.textContent = '';
    deps.conn.send({ type: 'config.sshkey.generate' });
  };

  sshkeyCopy.onclick = () => {
    const key = sshkeyPublic.value.trim();
    if (!key) return;
    navigator.clipboard?.writeText(key).then(
      () => { sshkeyStatus.textContent = t('settings.sshkey.copied'); },
      () => {},
    );
  };

  deps.conn.onMessage((msg) => {
    if (msg.type !== 'config.sshkey.info') return;
    sshkeyPublic.value = msg.publicKey ?? '';
    sshkeyCopy.disabled = !msg.publicKey;
    sshkeyGenerate.textContent = msg.publicKey ? t('settings.sshkey.regenerate') : t('settings.sshkey.generate');
    if (msg.privateKeyPath) {
      sshkeyPrivatePath.textContent = msg.privateKeyPath;
      sshkeyPrivateHint.hidden = false;
    } else {
      sshkeyPrivateHint.hidden = true;
    }
  });

  saveButton.onclick = () => {
    // Persist notify toggle (localStorage) and remote-client paths (server).
    // Requesting notification permission needs a user-gesture context, and
    // the click itself is one, so this is the moment to ask.
    const notifyOn = notifyCheckbox.checked;
    setNotifyEnabled(notifyOn);
    if (notifyOn && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
    deps.conn.send({
      type: 'config.settings.save',
      xshellPath: xshellInput.value.trim(),
      xftpPath: xftpInput.value.trim(),
      vscodePath: vscodeInput.value.trim(),
    });
    dialog.close();
  };
}

/** Turn a detect result into a one-line status message. Enumerates the found
 * / missing sets and reports both; keeps the message useful even as more
 * targets are added to the detect flow (this used to be a hard-coded matrix
 * of "which subset was found" and each new target doubled it). */
function describeDetectResult(results: Record<string, string | null>): string {
  const found: string[] = [];
  const missing: string[] = [];
  for (const [name, path] of Object.entries(results)) {
    if (path) found.push(name);
    else missing.push(name);
  }
  if (missing.length === 0) return t('settings.detect.all');
  if (found.length === 0) return t('settings.detect.none');
  return t('settings.detect.partial')
    .replace('{found}', found.join(', '))
    .replace('{missing}', missing.join(', '));
}
