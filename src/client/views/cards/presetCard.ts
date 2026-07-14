import { el, val, setVal, checked, setChecked, fillSelect } from '../../dom.js';
import type { AppDeps } from '../../deps.js';
import { bindCondaSelect } from '../widgets/condaSelect.js';
import { bindCwdSuggest } from '../widgets/cwdSuggest.js';
import { createCardController } from './cardController.js';
import { buildPresetSaveMessage, type PresetFormValues } from './cardSerializers.js';
import { injectSessionFields } from '../sessionFields.js';

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
  // Inject the shared field block before the controller wires up — everything
  // below addresses fields by id, so they must exist first.
  injectSessionFields('preset-fields', 'preset');
  const condaSelect = bindCondaSelect(deps, 'preset-conda');
  const cwdSuggest = bindCwdSuggest(deps, {
    inputId: 'preset-cwd',
    suggestionsId: 'preset-cwd-suggestions',
    getServer: () => deps.store.getServer(val('preset-server')),
  });

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
      const cfg = deps.store.get().config;
      setVal('preset-name', p.name);
      // No blank option anymore, so an empty/stale id would blank the select;
      // fall back to the config default so a real option stays selected.
      setVal('preset-server', p.serverId || cfg?.defaults.serverId || '');
      setVal('preset-profile', p.anthropicProfileId || cfg?.defaults.profileId || '');
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
      const cfg = deps.store.get().config;
      setVal('preset-list', '');
      setVal('preset-name', '');
      // A new preset defaults to the default server/provider (no blank option
      // to land on); proxy stays empty → the "None" entry.
      setVal('preset-server', cfg?.defaults.serverId ?? cfg?.servers[0]?.id ?? '');
      setVal('preset-profile', cfg?.defaults.profileId ?? cfg?.profiles[0]?.id ?? '');
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
      // Server + LLM provider are required picks from existing config — no
      // blank "New…" entry (that would imply creating one inline, which lives
      // in the server/provider cards). Keep the current value so a store
      // notify mid-edit doesn't reset the selection.
      fillSelect(el<HTMLSelectElement>('preset-server'), s.config!.servers, val('preset-server'));
      fillSelect(el<HTMLSelectElement>('preset-profile'), s.config!.profiles, val('preset-profile'));
      // Proxy is optional: keep the blank option but label it "None" (not
      // using a proxy), not "New…".
      fillSelect(el<HTMLSelectElement>('preset-proxy'), s.config!.proxies, val('preset-proxy'), true, 'field.none');
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
    cwdSuggest.hide();
    void condaSelect.refresh(serverId, pendingValue);
  }

  return controller;
}
