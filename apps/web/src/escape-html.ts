/**
 * Escape a value before it is placed in innerHTML. Anything that can come from
 * a news feed, a user-written script, a broker, or an error message goes
 * through here, including the values inside attributes.
 */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
