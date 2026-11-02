/**
 * Contrast scripts — legitimate code that sits right next to a bug class.
 *
 * The shipped library is the main known-good corpus, but it happens not to
 * contain every legitimate pattern a broad rule could catch. These scripts
 * close that gap: each one is valid, runs, and fires its signals (checked by
 * `npm run verify:proposer`), so a rule that flags any of them is too broad.
 */
import type { CorpusEntry } from './types';

export const CONTRAST_SCRIPTS: CorpusEntry[] = [
  {
    name: 'Contrast — New N-bar high or low (ties count)',
    category: 'Contrast',
    source: [
      '// A bar that ties the N-bar high is a new high: >= and <= are correct here',
      'len = input(20, "Lookback", 5, 100, 1)',
      'hh = highest(high, len)',
      'll = lowest(low, len)',
      'newHigh = high >= hh',
      'newLow = low <= ll',
      'if newHigh and not newHigh[1] {',
      '  plotshape(bar_index, high, "New High", "triangledown", "#ffd166")',
      '}',
      'if newLow and not newLow[1] {',
      '  plotshape(bar_index, low, "New Low", "triangleup", "#22aaff")',
      '}',
      'plot(hh, "Range High", "#22aaff", 1, "stepline")',
      'plot(ll, "Range Low", "#ff8844", 1, "stepline")',
    ].join('\n'),
  },
  {
    name: 'Contrast — Donchian breakout on the previous channel',
    category: 'Contrast',
    source: [
      '// The fixed form of the impossible breakout: compare with the channel as of the previous bar',
      'len = input(20, "Channel", 5, 100, 1)',
      'upper = highest(high, len)',
      'lower = lowest(low, len)',
      'if crossover(close, upper[1]) {',
      '  plotshape(bar_index, low, "Channel Break Up", "triangleup", "#22cc88")',
      '}',
      'if crossunder(close, lower[1]) {',
      '  plotshape(bar_index, high, "Channel Break Down", "triangledown", "#ff4477")',
      '}',
      'plot(upper, "Channel High", "#22aaff", 1, "stepline")',
      'plot(lower, "Channel Low", "#ff8844", 1, "stepline")',
    ].join('\n'),
  },
  {
    name: 'Contrast — Highest close of the window',
    category: 'Contrast',
    source: [
      '// close == highest(close, n) is true whenever this close is the highest of the window',
      'len = input(10, "Window", 3, 50, 1)',
      'topClose = highest(close, len)',
      'botClose = lowest(close, len)',
      'if close == topClose and close[1] < topClose[1] {',
      '  plotshape(bar_index, high, "Closing High", "triangledown", "#ffd166")',
      '}',
      'if close == botClose and close[1] > botClose[1] {',
      '  plotshape(bar_index, low, "Closing Low", "triangleup", "#22aaff")',
      '}',
      'plot(ema(close, 1), "Close", "#cccccc", 1)',
      'plot(topClose, "Top Close", "#22cc88", 1, "stepline")',
    ].join('\n'),
  },
  {
    name: 'Contrast — Range position with dynamic lengths',
    category: 'Contrast',
    source: [
      '// Lengths from input() and arithmetic are not literals; the length rule must leave them alone',
      'fast = input(5, "Fast", 2, 50, 1)',
      'slow = input(30, "Slow", 5, 200, 1)',
      'hiS = highest(high, slow)',
      'loS = lowest(low, slow)',
      'pos = (close - loS) / max(hiS - loS, 0.0001) * 100',
      'smooth = sma(pos, fast)',
      'trend = ema(close, slow * 2)',
      'if crossover(smooth, 80) {',
      '  plotshape(bar_index, high, "Upper Zone", "triangledown", "#ff8844")',
      '}',
      'if crossunder(smooth, 20) {',
      '  plotshape(bar_index, low, "Lower Zone", "triangleup", "#22cc88")',
      '}',
      'plot(smooth, "Range Position", "#b48cff", 1, "separate")',
      'plot(trend, "Trend", "#22aaff", 1)',
    ].join('\n'),
  },
];
