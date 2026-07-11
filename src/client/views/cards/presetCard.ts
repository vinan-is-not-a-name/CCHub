import { el, val, setVal, checked, setChecked, fillSelect } from '../../dom.js';
import type { AppDeps } from '../../deps.js';
import { bindCondaSelect } from '../widgets/condaSelect.js';
import { createCardController } from './cardController.js';
import { buildPresetSaveMessage, type PresetFormValues } from './cardSerializers.js';
import { t } from '../../i18n.js';

function readPresetForm(): PresetFormValues {
  return {
    name: val('preset-name'),
    serverId: val('preset-server'),
    profileId: val('preset-profile'),
    cwd: val('preset-cwd'),
    conda: val('preset-conda'),
    resume: val('preset-resume'),
    skipPermissions: checked('preset-skip-permissions'),
    proxyId: val('preset-proxy'),
    effort: val('preset-effort'),
  };
}

export function mountPresetCard(deps: AppDeps) {
  const condaSelect = bindCondaSelect(deps, 'preset-conda');

  const controller = createCardController(deps, {
    prefix: 'preset',
    modeKey: 'presetMode',
    selectedKey: 'selectedPresetId',
    modeCreateKey: 'preset.mode.create',
    modeEditKey: 'preset.mode.edit',
    saveCreateKey: 'preset.save.create',
    saveEditKey: 'preset.save.edit',
    items: (s) => s.config!.presets,
    lookup: (id) => deps.store.getPreset(id),
    buildSave: (editing, selectedId) => buildPresetSaveMessage(readPresetForm(), { editing, selectedId }),
    buildDelete: (selectedId) => ({ type: 'config.preset.delete', id: selectedId }),
    buildCopy: (selectedId) => ({ type: 'config.preset.copy', id: selectedId }),
    fillForm: (p) => {
      setVal('preset-name', p.name);
      setVal('preset-server', p.serverId);
      setVal('preset-profile', p.anthropicProfileId);
      setVal('preset-cwd', p.cwd);
      setVal('preset-conda', p.condaEnv);
      setVal('preset-resume', p.resume ?? 'continue');
      setChecked('preset-skip-permissions', p.skipPermissions === true);
      setVal('preset-proxy', p.proxyId);
      setVal('preset-effort', p.effort);
      // Surface the advanced block when it carries non-default values so an
      // editor sees what's set without having to hunt for the collapsed section.
      setAdvancedOpen(p.skipPermissions === true || Boolean(p.proxyId) || Boolean(p.effort));
      updateTarget(p.condaEnv);
    },
    resetForm: () => {
      setVal('preset-list', '');
      setVal('preset-name', '');
      setVal('preset-server', '');
      setVal('preset-profile', '');
      setVal('preset-cwd', '');
      setVal('preset-conda', '');
      setVal('preset-resume', 'continue');
      setChecked('preset-skip-permissions', false);
      setVal('preset-proxy', '');
      setVal('preset-effort', '');
      setAdvancedOpen(false);
      updateTarget();
    },
    onSubscribe: (s) => {
      fillSelect(el<HTMLSelectElement>('preset-server'), s.config!.servers, '', true);
      fillSelect(el<HTMLSelectElement>('preset-profile'), s.config!.profiles, '', true);
      fillSelect(el<HTMLSelectElement>('preset-proxy'), s.config!.proxies, val('preset-proxy'), true);
      renderResumeOptions(el<HTMLSelectElement>('preset-resume'), val('preset-resume') || 'continue');
    },
  });

  el<HTMLSelectElement>('preset-server').onchange = () => updateTarget();
  el<HTMLButtonElement>('preset-browse').onclick = () =>
    deps.bus.emit('launch:select-cwd', { targetInput: 'preset-cwd', serverId: val('preset-server') });

  function setAdvancedOpen(open: boolean) {
    el<HTMLDetailsElement>('preset-advanced').open = open;
  }

  function updateTarget(pendingValue?: string) {
    const serverId = val('preset-server') || undefined;
    el<HTMLButtonElement>('preset-browse').disabled = !serverId;
    void condaSelect.refresh(serverId, pendingValue);
  }

  function renderResumeOptions(select: HTMLSelectElement, selected?: string) {
    select.innerHTML = `<option value="">${t('preset.resume.new')}</option><option value="continue">${t('preset.resume.continue')}</option>`;
    select.value = selected ?? 'continue';
  }

  return controller;
}
