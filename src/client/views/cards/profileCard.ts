import { el, val, setVal, checked, setChecked } from '../../dom.js';
import type { AppDeps } from '../../deps.js';
import { PROFILE_FIELD_TO_ENV } from '../../../shared/protocol.js';
import { t } from '../../i18n.js';
import { createCardController } from './cardController.js';
import { buildProfileSaveMessage, buildProfileTestMessage, type ProfileFormValues } from './cardSerializers.js';

function readProfileForm(): ProfileFormValues {
  return {
    name: val('profile-name'),
    baseUrl: val('profile-base-url'),
    authToken: val('profile-auth-token'),
    model: val('profile-model'),
    subagentModel: val('profile-subagent-model'),
    smallFastModel: val('profile-small-model'),
    clearAuthToken: checked('profile-clear-token'),
  };
}

function setProfileTestResult(text: string, variant: 'error' | 'info'): void {
  const result = el<HTMLDivElement>('profile-test-result');
  result.hidden = false;
  result.textContent = text;
  result.classList.toggle('error', variant === 'error');
  result.classList.toggle('info', variant === 'info');
}

export function mountProfileCard(deps: AppDeps) {
  const controller = createCardController(deps, {
    prefix: 'profile',
    modeKey: 'profileMode',
    selectedKey: 'selectedProfileId',
    modeCreateKey: 'provider.mode.create',
    modeEditKey: 'provider.mode.edit',
    saveCreateKey: 'provider.save.create',
    saveEditKey: 'provider.save.edit',
    items: (s) => s.config!.profiles,
    lookup: (id) => deps.store.getProfile(id),
    buildSave: (editing, selectedId) => buildProfileSaveMessage(readProfileForm(), { editing, selectedId }),
    buildDelete: (selectedId) => ({ type: 'config.profile.delete', id: selectedId }),
    buildCopy: (selectedId) => ({ type: 'config.profile.copy', id: selectedId }),
    fillForm: (p) => {
      setVal('profile-name', p.name);
      setVal('profile-base-url', p.env?.[PROFILE_FIELD_TO_ENV.baseUrl]);
      setVal('profile-auth-token', '');
      setVal('profile-model', p.env?.[PROFILE_FIELD_TO_ENV.model]);
      setVal('profile-subagent-model', p.env?.[PROFILE_FIELD_TO_ENV.subagentModel]);
      setVal('profile-small-model', p.env?.[PROFILE_FIELD_TO_ENV.smallFastModel]);
      setChecked('profile-clear-token', false);
    },
    resetForm: () => {
      setVal('profile-list', '');
      setVal('profile-name', '');
      setVal('profile-base-url', '');
      setVal('profile-auth-token', '');
      setVal('profile-model', '');
      setVal('profile-subagent-model', '');
      setVal('profile-small-model', '');
      setChecked('profile-clear-token', false);
      el<HTMLDivElement>('profile-test-result').hidden = true;
    },
    renderExtra: (profile, editing) => {
      const tokenInput = el<HTMLInputElement>('profile-auth-token');
      if (editing && profile?.hasAuthToken) {
        tokenInput.placeholder = profile.authTokenPreview
          ? `Saved: ${profile.authTokenPreview} (leave blank to keep)`
          : 'Leave blank to keep saved token';
      } else {
        tokenInput.placeholder = '';
      }
    },
  });

  el<HTMLButtonElement>('profile-test').onclick = async () => {
    const button = el<HTMLButtonElement>('profile-test');
    button.disabled = true;
    setProfileTestResult(t('test.testing'), 'info');
    const ui = deps.store.get().ui;
    const ctx = { editing: ui.profileMode === 'edit', selectedId: ui.selectedProfileId };
    try {
      const result = await deps.rpc.request(
        'config.profile.test.result',
        (requestId) => buildProfileTestMessage(readProfileForm(), ctx, requestId),
      );
      if (result.ok) setProfileTestResult(t('test.ok'), 'info');
      else setProfileTestResult(`${t('test.failedPrefix')}: ${result.message}`, 'error');
    } catch (err) {
      setProfileTestResult(`${t('test.failedPrefix')}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      button.disabled = false;
    }
  };

  return controller;
}
