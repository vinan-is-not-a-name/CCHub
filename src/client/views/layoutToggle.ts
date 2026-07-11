import type { AppDeps } from '../deps.js';
import {
  LAYOUT_MODES,
  loadLayoutMode,
  saveLayoutMode,
  type LayoutMode,
} from './layout.js';
import { subscribeLocale, t } from '../i18n.js';

/** Aero glass segmented control that switches the session display layout. Owns
 * the persisted preference; the actual relayout happens in the session view via
 * the `layout:change` bus event, keeping this view free of terminal internals. */
export function mountLayoutToggle(deps: AppDeps): void {
  const host = document.getElementById('layout-host');
  if (!host) return;

  const group = document.createElement('div');
  group.className = 'layout-toggle';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', t('layout.group.aria'));

  const buttons = new Map<LayoutMode, HTMLButtonElement>();
  for (const mode of LAYOUT_MODES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'layout-toggle-btn';
    btn.dataset.layout = mode;
    btn.onclick = () => select(mode);
    buttons.set(mode, btn);
    group.appendChild(btn);
  }
  host.appendChild(group);
  applyLabels();

  function applyLabels(): void {
    group.setAttribute('aria-label', t('layout.group.aria'));
    for (const [mode, btn] of buttons) {
      const label = t(`layout.mode.${mode}`);
      btn.textContent = label;
      const title = t('layout.tooltip').replace('{name}', label);
      btn.title = title;
      btn.setAttribute('aria-label', title);
    }
  }

  function select(mode: LayoutMode): void {
    saveLayoutMode(mode);
    deps.bus.emit('layout:change', mode);
  }

  function highlight(mode: LayoutMode): void {
    for (const [m, btn] of buttons) {
      const on = m === mode;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', String(on));
    }
  }

  const initial = loadLayoutMode();
  deps.store.subscribe((s) => highlight(s.ui.layoutMode));
  subscribeLocale(applyLabels);
  highlight(initial);
  if (initial !== 'tabs') deps.bus.emit('layout:change', initial);
}
