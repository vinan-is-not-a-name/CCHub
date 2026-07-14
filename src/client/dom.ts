export function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`element not found: ${id}`);
  return node as T;
}

export function val(id: string): string {
  return (el<HTMLInputElement | HTMLSelectElement>(id)).value.trim();
}

export function setVal(id: string, value?: string) {
  el<HTMLInputElement | HTMLSelectElement>(id).value = value ?? '';
}

export function checked(id: string): boolean {
  return el<HTMLInputElement>(id).checked;
}

export function setChecked(id: string, value: boolean) {
  el<HTMLInputElement>(id).checked = value;
}

export function setText(id: string, text: string) {
  el(id).textContent = text;
}

import { t } from './i18n.js';

export function fillSelect(
  select: HTMLSelectElement,
  items: { id: string; name: string }[],
  selected?: string,
  blank = false,
  blankLabelKey = 'field.new',
) {
  const current = selected ?? select.value;
  select.innerHTML = '';
  if (blank) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = t(blankLabelKey);
    select.appendChild(opt);
  }
  for (const item of items) {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = item.name;
    if (item.id === current) opt.selected = true;
    select.appendChild(opt);
  }
}
