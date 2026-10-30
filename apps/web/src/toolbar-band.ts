/**
 * Floating windows (Dashboard, Model Inputs) keep clear of the bottom toolbar.
 * A window over the band covers the selects and buttons along that edge, so
 * drags, resizes and restored positions are clamped to it.
 */

/** Height of the bottom toolbar band that floating windows stay clear of. */
export const TOOLBAR_BAND = 170;

/** True when a window spanning [left, left + width] with this bottom edge sits over the band. */
export function overlapsToolbarBand(left: number, width: number, bottom: number): boolean {
  return left < window.innerWidth * 0.8
    && left + width > window.innerWidth * 0.2
    && bottom > window.innerHeight - TOOLBAR_BAND;
}

/** The top edge that keeps a window of this size clear of the band. */
export function clearOfToolbarTop(left: number, top: number, width: number, height: number): number {
  return overlapsToolbarBand(left, width, top + height)
    ? Math.max(0, window.innerHeight - TOOLBAR_BAND - height)
    : top;
}
