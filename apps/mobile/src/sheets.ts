export interface SheetOptions {
  title?: string;
  height?: string;
}

let backdrop: HTMLDivElement | null = null;
let sheet: HTMLDivElement | null = null;
let bodyEl: HTMLElement | null = null;
let onCloseCb: (() => void) | null = null;

export function initSheets(): void {
  backdrop = document.createElement('div');
  backdrop.id = 'sheet-backdrop';
  sheet = document.createElement('div');
  sheet.id = 'sheet';

  const grab = document.createElement('div');
  grab.id = 'sheet-grab';
  const header = document.createElement('div');
  header.id = 'sheet-header';
  const title = document.createElement('div');
  title.id = 'sheet-title';
  const close = document.createElement('button');
  close.id = 'sheet-close';
  close.textContent = '✕';
  header.appendChild(title);
  header.appendChild(close);
  bodyEl = document.createElement('div');
  bodyEl.id = 'sheet-body';

  sheet.appendChild(grab);
  sheet.appendChild(header);
  sheet.appendChild(bodyEl);
  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);

  backdrop.addEventListener('click', closeSheet);
  close.addEventListener('click', closeSheet);
  grab.addEventListener('touchstart', (e) => e.preventDefault());
}

export function openSheet(build: (body: HTMLElement, close: () => void) => void, opts: SheetOptions = {}): void {
  if (!sheet || !bodyEl || !backdrop) return;
  const title = sheet.querySelector('#sheet-title') as HTMLElement;
  title.textContent = opts.title ?? '';
  if (opts.height) sheet.style.maxHeight = opts.height;
  bodyEl.replaceChildren();
  onCloseCb = null;
  build(bodyEl, closeSheet);
  backdrop.classList.add('visible');
  sheet.classList.add('visible');
}

export function closeSheet(): void {
  if (!sheet || !backdrop) return;
  backdrop.classList.remove('visible');
  sheet.classList.remove('visible');
  if (onCloseCb) {
    const cb = onCloseCb;
    onCloseCb = null;
    cb();
  }
}

export function onSheetClosed(cb: () => void): void {
  onCloseCb = cb;
}

export function sectionTitle(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'sheet-section-title';
  el.textContent = text;
  return el;
}

export function gridButton(label: string, selected: boolean, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'sheet-grid-btn' + (selected ? ' selected' : '');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

export function searchInput(placeholder: string, onInput: (v: string) => void): HTMLInputElement {
  const i = document.createElement('input');
  i.className = 'sheet-search';
  i.placeholder = placeholder;
  i.addEventListener('input', () => onInput(i.value.toUpperCase()));
  return i;
}

export function listRow(symbol: string, name: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'sheet-row';
  const s = document.createElement('span');
  s.className = 'sym-symbol';
  s.textContent = symbol;
  const n = document.createElement('span');
  n.className = 'sym-name';
  n.textContent = name;
  b.appendChild(s);
  b.appendChild(n);
  b.addEventListener('click', onClick);
  return b;
}