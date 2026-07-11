import { el, setText, fillSelect } from '../../dom.js';
import type { AppDeps } from '../../deps.js';
import type { AppState, UiState } from '../../state.js';
import type { ClientMessage } from '../../../shared/protocol.js';
import { subscribeLocale, t } from '../../i18n.js';

type ModeKey = 'profileMode' | 'serverMode' | 'presetMode' | 'proxyMode';
type SelectedKey = 'selectedProfileId' | 'selectedServerId' | 'selectedPresetId' | 'selectedProxyId';

/**
 * Describes one config card (profile / server / preset). The shared skeleton —
 * list onChange→edit/new, save, delete, subscribe→fillSelect+renderModes, and
 * create/edit mode swap — lives in createCardController. Everything card-specific
 * (form fill/reset, save/delete message construction, i18n keys for pill/save
 * text, extra selects) is supplied through this spec.
 */
export interface CardSpec<T extends { id: string; name: string }> {
  /** Element-id prefix; the card uses `${prefix}-list|mode|save|delete|copy`. */
  prefix: string;
  modeKey: ModeKey;
  selectedKey: SelectedKey;
  /** i18n keys for the mode pill in create/edit state, e.g.
   * `provider.mode.create` / `provider.mode.edit`. */
  modeCreateKey: string;
  modeEditKey: string;
  /** i18n keys for the save button in create/edit state, e.g.
   * `provider.save.create` / `provider.save.edit`. */
  saveCreateKey: string;
  saveEditKey: string;
  /** Items for the list select; called only when config is loaded. */
  items(s: AppState): T[];
  lookup(id: string): T | undefined;
  fillForm(entity: T): void;
  resetForm(): void;
  buildSave(editing: boolean, selectedId: string): ClientMessage;
  buildDelete(selectedId: string): ClientMessage;
  buildCopy?(selectedId: string): ClientMessage;
  /** Extra subscribe work beyond fillSelect(list) + renderModes (e.g. preset's
   * server/profile selects). The list select is already populated. */
  onSubscribe?(s: AppState): void;
  /** Card-specific renderModes tail, e.g. password/token placeholder hints. */
  renderExtra?(entity: T | undefined, editing: boolean): void;
}

export interface CardController {
  startNew(): void;
  edit(id: string): void;
  showError(message: string): void;
}

export function createCardController<T extends { id: string; name: string }>(deps: AppDeps, spec: CardSpec<T>): CardController {
  el<HTMLSelectElement>(`${spec.prefix}-list`).onchange = (e) => {
    const id = (e.target as HTMLSelectElement).value;
    if (id) edit(id); else startNew();
  };
  const errorEl = (): HTMLDivElement | null => document.getElementById(`${spec.prefix}-save-error`) as HTMLDivElement | null;
  const clearError = () => { const e = errorEl(); if (e) { e.hidden = true; e.textContent = ''; } };
  const showError = (message: string) => { const e = errorEl(); if (e) { e.textContent = message; e.hidden = false; } };

  el<HTMLButtonElement>(`${spec.prefix}-save`).onclick = () => {
    clearError();
    const ui = deps.store.get().ui;
    const editing = ui[spec.modeKey] === 'edit';
    deps.conn.send(spec.buildSave(editing, ui[spec.selectedKey]));
  };
  el<HTMLButtonElement>(`${spec.prefix}-delete`).onclick = () => {
    const ui = deps.store.get().ui;
    if (ui[spec.modeKey] === 'edit' && ui[spec.selectedKey]) {
      deps.conn.send(spec.buildDelete(ui[spec.selectedKey]));
    }
  };
  el<HTMLButtonElement>(`${spec.prefix}-copy`).onclick = () => {
    const ui = deps.store.get().ui;
    if (ui[spec.modeKey] === 'edit' && ui[spec.selectedKey] && spec.buildCopy) {
      deps.conn.send(spec.buildCopy(ui[spec.selectedKey]));
    }
  };

  deps.store.subscribe((s) => {
    if (!s.config) return;
    fillSelect(el<HTMLSelectElement>(`${spec.prefix}-list`), spec.items(s), s.ui[spec.selectedKey], true);
    spec.onSubscribe?.(s);
    renderModes();
  });

  // Re-run renderModes on locale change so the pill / save-button text tracks
  // the newly-loaded dictionary. applyDomI18n has already reset the static
  // defaults; renderModes overrides them based on current edit state.
  subscribeLocale(() => { if (deps.store.get().config) renderModes(); });

  function startNew() {
    clearError();
    patchMode('create', '');
    spec.resetForm();
  }

  function edit(id: string) {
    clearError();
    const entity = spec.lookup(id);
    if (!entity) return startNew();
    patchMode('edit', id);
    spec.fillForm(entity);
  }

  function renderModes() {
    const ui = deps.store.get().ui;
    const selectedId = ui[spec.selectedKey];
    const editing = ui[spec.modeKey] === 'edit' && Boolean(selectedId);
    setText(`${spec.prefix}-mode`, t(editing ? spec.modeEditKey : spec.modeCreateKey));
    setText(`${spec.prefix}-save`, t(editing ? spec.saveEditKey : spec.saveCreateKey));
    el<HTMLButtonElement>(`${spec.prefix}-delete`).disabled = !editing;
    el<HTMLButtonElement>(`${spec.prefix}-copy`).disabled = !editing;
    spec.renderExtra?.(editing ? spec.lookup(selectedId) : undefined, editing);
  }

  function patchMode(mode: 'create' | 'edit', id: string) {
    const patch: Partial<UiState> = {};
    (patch as Record<ModeKey, string>)[spec.modeKey] = mode;
    (patch as Record<SelectedKey, string>)[spec.selectedKey] = id;
    deps.store.patchUi(patch);
  }

  return { startNew, edit, showError };
}
