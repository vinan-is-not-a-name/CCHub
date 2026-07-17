import type { RecentLaunch } from '../../shared/protocol.js';
import { el, val, setVal, checked, setChecked, fillSelect } from '../dom.js';
import type { AppDeps } from '../deps.js';
import { bindCondaSelect } from './widgets/condaSelect.js';
import { bindCwdSuggest } from './widgets/cwdSuggest.js';
import { injectSessionFields } from './sessionFields.js';
import { t } from '../i18n.js';

export function mountLaunchDialog(deps: AppDeps, params: URLSearchParams) {
  const launchDialog = el<HTMLDialogElement>('launch-dialog');
  // Inject the shared field block before binding widgets — condaSelect and
  // cwdSuggest both grab fields by id.
  injectSessionFields('launch-fields', 'launch');
  const condaSelect = bindCondaSelect(deps, 'launch-conda');
  const cwdSuggest = bindCwdSuggest(deps, {
    inputId: 'launch-cwd',
    suggestionsId: 'launch-cwd-suggestions',
    getServer: () => {
      const id = val('launch-server') || deps.store.get().config?.defaults.serverId;
      return deps.store.getServer(id);
    },
  });

  deps.bus.on('launch:open', () => {
    render();
    launchDialog.showModal();
  });
  deps.bus.on('launch:prefill', ({ recent }) => {
    render();
    applyRecent(recent);
    launchDialog.showModal();
  });

  el<HTMLSelectElement>('launch-preset').onchange = () => applyPreset();
  el<HTMLSelectElement>('launch-server').onchange = () => updateTarget();
  el<HTMLButtonElement>('launch-browse').onclick = () =>
    deps.bus.emit('launch:select-cwd', { targetInput: 'launch-cwd', serverId: val('launch-server') });
  el<HTMLButtonElement>('launch-create').onclick = () => {
    deps.bus.emit('launch:create', {
      presetId: val('launch-preset') || undefined,
      serverId: val('launch-server'),
      profileId: val('launch-profile'),
      cwd: val('launch-cwd'),
      condaEnv: val('launch-conda'),
      resume: val('launch-resume'),
      skipPermissions: checked('launch-skip-permissions'),
      proxyId: val('launch-proxy'),
      effort: val('launch-effort'),
    });
  };

  // re-render when config changes; preserve user-typed values mid-edit
  deps.store.subscribe((s) => {
    if (s.ui.preserveLaunchValues) return;
    if (launchDialog.open) render();
  });

  function render() {
    const config = deps.store.get().config;
    if (!config) return;
    fillSelect(el<HTMLSelectElement>('launch-preset'), config.presets, undefined, true);
    fillSelect(el<HTMLSelectElement>('launch-proxy'), config.proxies, val('launch-proxy'), true, 'field.none');
    applyPreset();
  }

  function applyPreset() {
    const config = deps.store.get().config;
    if (!config) return;
    const preset = deps.store.getPreset(val('launch-preset'));
    const serverId = preset ? preset.serverId : initialServerId();
    fillSelect(el<HTMLSelectElement>('launch-server'), config.servers, serverId);
    fillSelect(el<HTMLSelectElement>('launch-profile'), config.profiles, preset?.anthropicProfileId ?? config.defaults.profileId);
    // Reset proxy to the preset's own value (or None). Falling back to the
    // current form value here would leak the previous preset's proxy into a
    // preset that doesn't define one — and it's read back verbatim at create.
    fillSelect(el<HTMLSelectElement>('launch-proxy'), config.proxies, preset?.proxyId ?? '', true, 'field.none');
    setVal('launch-resume', preset?.resume ?? 'continue');
    cwdSuggest.hide();
    setVal('launch-cwd', preset ? preset.cwd : params.get('sshCwd') ?? params.get('cwd') ?? '');
    setChecked('launch-skip-permissions', preset?.skipPermissions === true);
    setVal('launch-effort', preset?.effort ?? '');
    // Always start collapsed here: the launch dialog is "pick a preset and go",
    // so auto-opening for only some presets reads as inconsistent. The preset's
    // advanced values still apply on create — this is purely what's shown.
    setAdvancedOpen(false);
    updateBadge(preset?.name);
    void condaSelect.refresh(serverId, preset?.condaEnv ?? '');
  }

  function initialServerId() {
    const config = deps.store.get().config;
    const target = params.get('target') as 'local' | 'ssh' | null;
    if (target) return config?.servers.find((s) => s.kind === target)?.id ?? config?.defaults.serverId;
    return config?.defaults.serverId;
  }

  function updateTarget() {
    el<HTMLButtonElement>('launch-browse').hidden = false;
    cwdSuggest.hide();
    void condaSelect.refresh(val('launch-server') || undefined);
  }

  function setAdvancedOpen(open: boolean) {
    el<HTMLDetailsElement>('launch-advanced').open = open;
  }

  function updateBadge(presetName?: string) {
    const badge = el('launch-preset-badge');
    if (presetName) {
      badge.textContent = presetName;
    } else {
      badge.textContent = t('launch.noPreset');
    }
  }

  /** Overlay a RecentLaunch onto the freshly-rendered form. Runs AFTER
   * render()+applyPreset() so we selectively overwrite only the fields the
   * recent entry actually pinned. Values that no longer resolve (e.g. the
   * preset was deleted since) fall back to whatever applyPreset filled. */
  function applyRecent(recent: RecentLaunch): void {
    const config = deps.store.get().config;
    if (!config) return;
    if (recent.presetId && config.presets.some(p => p.id === recent.presetId)) {
      setVal('launch-preset', recent.presetId);
      applyPreset();
    }
    if (recent.serverId && config.servers.some(s => s.id === recent.serverId)) {
      setVal('launch-server', recent.serverId);
    }
    if (recent.profileId && config.profiles.some(p => p.id === recent.profileId)) {
      setVal('launch-profile', recent.profileId);
    }
    if (typeof recent.cwd === 'string') setVal('launch-cwd', recent.cwd);
    setVal('launch-resume', recent.resume ?? '');
    // Refresh conda list against the (possibly new) server, then set the value.
    // We can't just setVal on the select — the option list is populated async.
    void condaSelect.refresh(val('launch-server') || undefined, recent.condaEnv ?? '');
  }
}
