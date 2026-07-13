import { applyDomI18n } from '../i18n.js';
import { el } from '../dom.js';

/**
 * Single source of truth for the session-config form fields shared by the
 * Presets config card and the "new session" launch dialog. Both places build a
 * one-shot or persisted launch out of the exact same inputs, so the markup —
 * and therefore the styling and future new fields — lives here once.
 *
 * Element ids are prefixed (`preset-*` vs `launch-*`) so the two mount sites can
 * coexist on the page and their existing controllers keep addressing fields by
 * id. Labels use the shared `preset.*` i18n keys so the two forms read
 * identically.
 *
 * The block intentionally does NOT include:
 *   - the preset's Name field (persisted-preset-only), or
 *   - the launch dialog's "load from preset" row (a quick-fill, not a field).
 * Those stay owned by their respective mount sites.
 */
export function sessionFieldsHtml(prefix: string): string {
  return `
    <div class="session-grid">
      <label class="field"><span data-i18n="preset.server">Server</span> <select id="${prefix}-server"></select></label>
      <label class="field"><span data-i18n="preset.profile">LLM provider</span> <select id="${prefix}-profile"></select></label>
    </div>
    <label class="field span-2"><span data-i18n="preset.cwd">Working directory</span>
      <span class="input-with-action"><input id="${prefix}-cwd" autocomplete="off"><button id="${prefix}-browse" class="secondary-button" value="default" type="button" data-i18n="launch.browse">Browse</button></span>
    </label>
    <div id="${prefix}-cwd-suggestions" class="suggestions span-2" hidden></div>
    <div class="session-grid">
      <label class="field"><span data-i18n="preset.conda">Conda env</span> <select id="${prefix}-conda"><option value="" data-i18n="launch.condaNone">No conda env</option></select></label>
      <label class="field"><span data-i18n="preset.resume">Resume</span> <select id="${prefix}-resume"><option value="" data-i18n="preset.resume.new">New session</option><option value="continue" data-i18n="preset.resume.continue">Continue latest</option></select></label>
    </div>
    <details id="${prefix}-advanced" class="advanced-section span-2">
      <summary data-i18n="preset.advanced">Advanced</summary>
      <label class="check-field"><input id="${prefix}-skip-permissions" type="checkbox"> <span data-i18n="preset.skipPermissions">Skip permission prompts (--dangerously-skip-permissions)</span></label>
      <label class="field"><span data-i18n="preset.proxy">Proxy</span> <select id="${prefix}-proxy" data-i18n-aria-label="preset.proxy" aria-label="Proxy"></select></label>
      <label class="field"><span data-i18n="preset.effort">Effort</span> <select id="${prefix}-effort" data-i18n-aria-label="preset.effort" aria-label="Effort"><option value="">Auto</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">XHigh</option><option value="max">Max</option></select></label>
    </details>
  `;
}

/**
 * Inject the shared field block into a host element, mark it as the shared grid
 * scope, and translate the freshly-added nodes. Idempotent: safe to call once at
 * mount time. Must run before any controller reads the fields by id.
 */
export function injectSessionFields(hostId: string, prefix: string): void {
  const host = el(hostId);
  host.classList.add('session-fields');
  host.innerHTML = sessionFieldsHtml(prefix);
  applyDomI18n(host);
}
