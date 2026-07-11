/** Attach a sidebar tab switcher to a dialog with the shape:
 *
 *   <div class="tabbed-layout">
 *     <nav class="tab-nav">
 *       <button class="tab-link" data-tab="a">…</button>
 *       ...
 *     </nav>
 *     <div class="tab-panels">
 *       <section data-tab-panel="a">…</section>
 *       ...
 *     </div>
 *   </div>
 *
 * Clicking a `.tab-link` toggles the matching `[data-tab-panel]` visible via
 * the `hidden` attribute and marks the link `.active`. Runs once per dialog —
 * safe to call on every open (idempotent).
 */
export function setupDialogTabs(dialog: HTMLElement): void {
  const layout = dialog.querySelector<HTMLElement>('.tabbed-layout');
  if (!layout) return;
  if (layout.dataset.tabsWired === '1') return;
  layout.dataset.tabsWired = '1';

  const links = Array.from(layout.querySelectorAll<HTMLButtonElement>('.tab-link'));
  const panels = Array.from(layout.querySelectorAll<HTMLElement>('[data-tab-panel]'));

  const activate = (name: string) => {
    for (const link of links) {
      const on = link.dataset.tab === name;
      link.classList.toggle('active', on);
      link.setAttribute('aria-selected', on ? 'true' : 'false');
      link.tabIndex = on ? 0 : -1;
    }
    for (const panel of panels) panel.hidden = panel.dataset.tabPanel !== name;
  };

  for (const link of links) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const name = link.dataset.tab;
      if (name) activate(name);
    });
  }

  const first = links[0]?.dataset.tab;
  if (first) activate(first);
}
