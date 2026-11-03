// Themed tooltips for every control in the app.
//
// Native `title` tooltips render as an OS box that ignores the HUD palette.
// This module moves each `title` into `data-tip` and draws the text in a
// HUD-styled bubble instead. Titles are adopted at startup, whenever a title
// is set later (MutationObserver), and on hover, so call sites don't change.

const SHOW_DELAY_MS = 350;
const GAP_PX = 8;
const EDGE_PX = 6;

let installed = false;
let bubble: HTMLDivElement | null = null;
let anchor: HTMLElement | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;

/** Move a native title into data-tip, keeping it as the accessible description. */
function adopt(el: HTMLElement): void {
  const title = el.getAttribute('title');
  if (title === null) return;
  el.removeAttribute('title');
  const text = title.trim();
  if (!text) {
    delete el.dataset.tip;
    el.removeAttribute('aria-description');
    return;
  }
  el.dataset.tip = text;
  el.setAttribute('aria-description', text);
  // Icon-only controls relied on the title as their accessible name.
  if (!el.hasAttribute('aria-label') && !el.textContent?.trim()) el.setAttribute('aria-label', text);
}

function ownerOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest<HTMLElement>('[title], [data-tip]');
  if (!el) return null;
  adopt(el);
  return el.dataset.tip ? el : null;
}

function getBubble(): HTMLDivElement {
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.className = 'dafe-tip';
    bubble.setAttribute('role', 'tooltip');
    document.body.appendChild(bubble);
  }
  return bubble;
}

function hide(): void {
  if (showTimer !== null) { clearTimeout(showTimer); showTimer = null; }
  anchor = null;
  bubble?.classList.remove('on');
}

function show(el: HTMLElement): void {
  const tip = getBubble();
  tip.textContent = el.dataset.tip ?? '';
  tip.classList.add('on');
  const r = el.getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const above = r.top - h - GAP_PX >= EDGE_PX;
  const top = above ? r.top - h - GAP_PX : Math.min(r.bottom + GAP_PX, innerHeight - h - EDGE_PX);
  const cx = r.left + r.width / 2;
  const left = Math.max(EDGE_PX, Math.min(cx - w / 2, innerWidth - w - EDGE_PX));
  tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

function arm(el: HTMLElement | null): void {
  if (el === anchor) return;
  hide();
  if (!el) return;
  anchor = el;
  showTimer = setTimeout(() => {
    showTimer = null;
    if (anchor === el && el.isConnected) show(el);
  }, SHOW_DELAY_MS);
}

export function installThemedTooltips(): void {
  if (installed) return;
  installed = true;

  document.querySelectorAll<HTMLElement>('[title]').forEach((el) => adopt(el));
  new MutationObserver((records) => {
    for (const rec of records) {
      if (rec.type === 'attributes') {
        if (rec.target instanceof HTMLElement) adopt(rec.target);
        continue;
      }
      rec.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        if (node.hasAttribute('title')) adopt(node);
        node.querySelectorAll<HTMLElement>('[title]').forEach((el) => adopt(el));
      });
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });

  document.addEventListener('pointerover', (e) => arm(ownerOf(e.target)), true);
  document.addEventListener('pointerout', (e) => {
    if (!anchor) return;
    if (e.relatedTarget instanceof Node && anchor.contains(e.relatedTarget)) return;
    hide();
  }, true);
  document.addEventListener('focusin', (e) => {
    if (e.target instanceof Element && e.target.matches(':focus-visible')) arm(ownerOf(e.target));
  }, true);
  document.addEventListener('focusout', hide, true);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('scroll', hide, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); }, true);
  window.addEventListener('blur', hide);
  window.addEventListener('resize', hide);
}
