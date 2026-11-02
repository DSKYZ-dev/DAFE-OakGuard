/**
 * A small "NEW" tag on features built during the Meta Global AI Developer
 * Hackathon (Oct 26 – Nov 4, 2026), so the demo shows what is new at a glance.
 */
export function newBadge(): HTMLSpanElement {
  const tag = document.createElement('span');
  tag.textContent = 'NEW';
  tag.title = 'Built during the Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026)';
  tag.style.cssText = 'display:inline-block;margin-left:5px;padding:0 4px;border-radius:3px;background:#ffd166;color:#0b0c1d;font-size:8px;font-weight:700;letter-spacing:0.06em;line-height:13px;vertical-align:middle;';
  return tag;
}
