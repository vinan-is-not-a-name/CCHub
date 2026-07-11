/** Small popover shown when the user clicks the parenthesized cwd detail on
 * a session's tab/pane label. Renders as a vertical list of buttons, each
 * being one place to open the cwd (files, VS Code, XShell, XFTP, cmd,
 * powershell, etc). The exact set is decided by the caller so this file
 * doesn't need to know about session kind (local vs ssh) or which apps are
 * relevant to each.
 *
 * Singleton: only one menu open at a time. A second `showRevealMenu` closes
 * the previous one first. Auto-closes on outside click, Escape, or scroll.
 * `position: fixed` because tab labels live in overflow-hidden containers and
 * an absolutely-positioned menu would get clipped. */

let currentClose: (() => void) | null = null;

export interface RevealMenuItem {
  label: string;
  onSelect(): void;
}

export interface RevealMenuOptions {
  items: RevealMenuItem[];
}

export function showRevealMenu(anchor: HTMLElement, opts: RevealMenuOptions): void {
  currentClose?.();

  const menu = document.createElement('div');
  menu.className = 'reveal-menu';
  menu.setAttribute('role', 'menu');

  for (const item of opts.items) {
    menu.appendChild(makeItem(item.label, () => { close(); item.onSelect(); }));
  }

  document.body.appendChild(menu);
  positionMenu(menu, anchor);

  const onDocPointer = (event: PointerEvent) => {
    if (event.target instanceof Node && menu.contains(event.target)) return;
    close();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  };
  const onScroll = () => close();

  function close(): void {
    if (currentClose !== close) return;
    currentClose = null;
    document.removeEventListener('pointerdown', onDocPointer, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
    menu.remove();
  }
  currentClose = close;

  // Deferring the listener wiring past this tick prevents the click that
  // opened the menu from also closing it: the pointerdown that started this
  // codepath is still bubbling when we get here.
  setTimeout(() => {
    document.addEventListener('pointerdown', onDocPointer, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
  }, 0);
}

function makeItem(text: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'reveal-menu-item';
  btn.setAttribute('role', 'menuitem');
  btn.textContent = text;
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return btn;
}

function positionMenu(menu: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  // Draw below the anchor by default; if that would clip past the viewport
  // bottom, flip above.
  const menuRect = menu.getBoundingClientRect();
  let top = rect.bottom + 4;
  if (top + menuRect.height > window.innerHeight - 8) {
    top = Math.max(8, rect.top - menuRect.height - 4);
  }
  let left = rect.left;
  if (left + menuRect.width > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - menuRect.width - 8);
  }
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
}
