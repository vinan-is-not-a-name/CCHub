import { el, val, setVal, checked, setChecked } from '../../dom.js';
import type { AppDeps } from '../../deps.js';
import type { SafeServerProfile } from '../../../shared/protocol.js';
import { createCardController } from './cardController.js';
import { buildServerSaveMessage, type ServerFormValues } from './cardSerializers.js';
import { t } from '../../i18n.js';

function readServerForm(): ServerFormValues {
  return {
    name: val('server-name'),
    kind: val('server-kind') as 'local' | 'ssh',
    os: val('server-os'),
    host: val('server-host'),
    port: val('server-port'),
    username: val('server-username'),
    password: val('server-password'),
    key: val('server-key'),
    clearPassword: checked('server-clear-password'),
  };
}

export function mountServerCard(deps: AppDeps) {
  const sshkey = mountServerSshKey(deps);

  return createCardController(deps, {
    prefix: 'server',
    modeKey: 'serverMode',
    selectedKey: 'selectedServerId',
    modeCreateKey: 'server.mode.create',
    modeEditKey: 'server.mode.edit',
    saveCreateKey: 'server.save.create',
    saveEditKey: 'server.save.edit',
    items: (s) => s.config!.servers,
    lookup: (id) => deps.store.getServer(id) as SafeServerProfile | undefined,
    buildSave: (editing, selectedId) => buildServerSaveMessage(readServerForm(), { editing, selectedId }),
    buildDelete: (selectedId) => ({ type: 'config.server.delete', id: selectedId }),
    buildCopy: (selectedId) => ({ type: 'config.server.copy', id: selectedId }),
    fillForm: (s) => {
      setVal('server-name', s.name);
      setVal('server-kind', s.kind);
      setVal('server-os', s.os ?? 'linux');
      if (s.kind === 'ssh') {
        setVal('server-host', s.host);
        setVal('server-port', String(s.port ?? 22));
        setVal('server-username', s.username);
        setVal('server-password', '');
        setVal('server-key', s.auth?.privateKeyPath);
      } else {
        setVal('server-host', '');
        setVal('server-port', '22');
        setVal('server-username', '');
        setVal('server-password', '');
        setVal('server-key', '');
      }
      setChecked('server-clear-password', false);
    },
    resetForm: () => {
      setVal('server-list', '');
      setVal('server-name', '');
      setVal('server-kind', 'local');
      setVal('server-os', defaultOsForBrowser());
      setVal('server-host', '');
      setVal('server-port', '22');
      setVal('server-username', '');
      setVal('server-password', '');
      setVal('server-key', '');
      setChecked('server-clear-password', false);
    },
    renderExtra: (server, editing) => {
      const passwordInput = el<HTMLInputElement>('server-password');
      if (editing && server?.kind === 'ssh' && server.auth.hasPassword) {
        passwordInput.placeholder = server.auth.passwordPreview
          ? `Saved: ${server.auth.passwordPreview} (leave blank to keep)`
          : 'Leave blank to keep saved password';
      } else {
        passwordInput.placeholder = '';
      }
      sshkey.render(editing && server?.kind === 'ssh' ? server.id : null);
    },
  });
}

/** The "install cc-remote key on this server" control. Only meaningful when
 * editing a saved SSH server, so `render(serverId)` shows the row + probes
 * install state for that server, and `render(null)` hides it (new server,
 * local server, or create mode). A monotonic requestId guards against a stale
 * probe/install response landing after the user has switched to a different
 * server — only the response matching the row's current server is applied. */
function mountServerSshKey(deps: AppDeps) {
  const row = el<HTMLDivElement>('server-sshkey-row');
  const button = el<HTMLButtonElement>('server-sshkey-install');
  const status = el<HTMLParagraphElement>('server-sshkey-status');

  // The server the control currently represents, and the id of the in-flight
  // request. A response is applied only when both its serverId matches the
  // shown server AND its requestId is the latest one we issued.
  let shownServerId: string | null = null;
  let pendingRequestId: string | null = null;

  function issue(): string {
    const id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
    pendingRequestId = id;
    return id;
  }

  function setButtonState(opts: { label: string; disabled: boolean }): void {
    button.textContent = opts.label;
    button.disabled = opts.disabled;
  }

  function render(serverId: string | null): void {
    if (serverId === shownServerId) return;
    shownServerId = serverId;
    pendingRequestId = null;
    status.hidden = true;
    status.textContent = '';
    if (!serverId) {
      row.hidden = true;
      return;
    }
    row.hidden = false;
    setButtonState({ label: t('server.sshkey.checking'), disabled: true });
    deps.conn.send({ type: 'config.sshkey.check', serverId, requestId: issue() });
  }

  button.onclick = () => {
    if (!shownServerId) return;
    setButtonState({ label: t('server.sshkey.installing'), disabled: true });
    status.hidden = true;
    deps.conn.send({ type: 'config.sshkey.install', serverId: shownServerId, requestId: issue() });
  };

  function showStatus(text: string): void {
    status.textContent = text;
    status.hidden = false;
  }

  deps.conn.onMessage((msg) => {
    if (msg.type === 'config.sshkey.checked') {
      if (msg.serverId !== shownServerId || msg.requestId !== pendingRequestId) return;
      pendingRequestId = null;
      if (msg.installed === true) {
        setButtonState({ label: t('server.sshkey.installed'), disabled: true });
      } else {
        // installed === false (not present) OR null (probe failed): keep the
        // button actionable. A failed probe shouldn't wrongly disable install.
        setButtonState({ label: t('server.sshkey.install'), disabled: false });
      }
    } else if (msg.type === 'config.sshkey.installed') {
      if (msg.serverId !== shownServerId || msg.requestId !== pendingRequestId) return;
      pendingRequestId = null;
      if (msg.ok) {
        setButtonState({ label: t('server.sshkey.installed'), disabled: true });
        showStatus(t(msg.alreadyInstalled ? 'server.sshkey.alreadyInstalled' : 'server.sshkey.installedNow'));
      } else {
        setButtonState({ label: t('server.sshkey.install'), disabled: false });
        showStatus(t('server.sshkey.failed').replace('{error}', msg.error ?? ''));
      }
    }
  });

  return { render };
}

/**
 * Default OS for client-side new-server form. Uses navigator.userAgent to
 * reflect the browser's host platform. Server-side operations (bootstrap,
 * migration) use schema.ts defaultOsFor() based on Node's platform().
 */
function defaultOsForBrowser(): string {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'windows';
  if (ua.includes('mac')) return 'macos';
  return 'linux';
}
