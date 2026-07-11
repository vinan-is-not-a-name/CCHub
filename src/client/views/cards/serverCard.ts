import { el, val, setVal, checked, setChecked } from '../../dom.js';
import type { AppDeps } from '../../deps.js';
import type { SafeServerProfile } from '../../../shared/protocol.js';
import { createCardController } from './cardController.js';
import { buildServerSaveMessage, type ServerFormValues } from './cardSerializers.js';

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
    },
  });
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
