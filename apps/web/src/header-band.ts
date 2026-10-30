/**
 * The header bar is the Regime Ribbon pinned across the top of the chart. Floating
 * windows start below it with a fixed gap, so none covers the bar on first load,
 * while dragging, or when a saved position is restored. index.html uses the same
 * numbers for the Trading and News & Events defaults.
 */

/** Height of the header bar (#regime-ribbon). */
export const HEADER_BAR_HEIGHT = 26;

/** Space between the header bar and the top row of windows, and between windows. */
export const WINDOW_GAP = 12;

/** Top edge every floating window starts at: directly below the header bar. */
export const WINDOW_TOP_MIN = HEADER_BAR_HEIGHT + WINDOW_GAP;

/** Left edge of the Trading panel: the draw-tool rail sits on the screen edge (left 12, 48px wide). */
export const TRADING_LEFT = 12 + 48 + WINDOW_GAP;

/** Left edge of the second top-row window: Trading is 240px wide. */
export const SECOND_COLUMN_LEFT = TRADING_LEFT + 240 + WINDOW_GAP;

/** Bottom edge of News & Events at full height (300px content plus its 2px border). */
export const NEWS_BOX_BOTTOM = WINDOW_TOP_MIN + 302;

/** Keep a window's top edge at or below the header bar. */
export function clearOfHeaderTop(top: number): number {
  return Math.max(WINDOW_TOP_MIN, top);
}
