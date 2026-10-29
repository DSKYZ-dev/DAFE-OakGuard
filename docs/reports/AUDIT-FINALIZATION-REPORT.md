# DAFECharts Mobile — Audit & Fix Report (finalization pass)

This document summarizes the audit findings and fixes applied across the
finalization sessions. Tests stay green: `fix-validation-test` (30/30),
`math-audit-test` (23/23), `extreme-test`, `backtest-stress`.

## A. Architecture & build (root-cause fixes)

### A1. Black screen — service worker + build target
- **Root cause 1**: `vite.config.ts` shipped `target: 'esnext'` → untranspiled
  syntax that older WebViews fail to parse (module never executed).
  Fixed → `es2017` for maximum WebView compatibility.
- **Root cause 2**: a leftover PWA `sw.js` was cache-first-serving a stale
  `index.html` (and returning HTML for `.js` chunk requests → parse failure).
  Native (Capacitor) builds now never register a service worker; `sw.js` is a
  self-destructing stub; a pre-boot purge unregisters/caches-clears.
- Added a boot splash + crash overlay so any future boot failure paints its
  stack on screen instead of a black void.

### A2. Genuine 3D on mobile (the big one)
- `three` (r185) is now bundled into the mobile app. `plot3d` indicators render
  through the real WebGL `renderMain3DScene` — surface/ribbon/bars3d/scatter/
  helix/manifold/vortex/nebula/constellation/torus/trail.
- Fallback to iso-2D proxy ONLY when the device genuinely can't sustain it
  (no WebGL, context failure, or sustained <18fps watchdog).
- A dismissible warning modal (with ×) explains the limit and suggests: lower
  Performance mode, turn 3D off, fewer bars, close apps.

## B. LLM / agent

### B1. Dead endpoint
`api.opencode.ai` is a placeholder returning `"Hello, world!"`/`"Not Found"` for
`/models` and `/chat/completions` (HTTP 200). The default LLM config pointed
there, so "TEST CONNECTION" showed a fake green 200 while chat always failed.
- New `llmChat`/`fetchLlmModels` transport: split connect (15s) vs read (180s)
  timeouts, native Anthropic routing, provider-sane default models, defensive
  JSON parsing, live model-list fetch with free-tiers-first sorting.
- TEST CONNECTION now performs a real 1-token chat probe.

### B2. Agent drift / freezing
- The system prompt primed Pine (repeated "Pine corpus"/"Pine parity"/"TradingView"
  mentions). Rewrote the opening to a hard OakScript identity with the canonical
  builtin list, an explicit "never truncate / never claim completion when cut
  off / ≤120 lines so it finishes" contract.
- The validator already auto-detects Pine idioms and emits fixes; this remains.

## C. Editor & UX

| Fix | Detail |
|---|---|
| VP button restored | dedicated VP FAB (toggles volume profile) + separate OST FAB |
| Editor chat | floating panel with close × / minimize — |
| Generated script | closable dialog ("Test on Chart" / "Later") |
| Error-feedback loop | indicator errors auto-push into the editor chat |
| Test on Chart | glows green "● Live on Chart" when active |

## D. Backtest / optimizer (were broken)

- **Optimizer**: input-parse regex assumed `input("title",…)` but the DSL is
  `input(default, "title", …)` → zero inputs detected → every combo identical.
  Fixed to parse the real signature; grid now passes `inputOverrides` Maps.
- **Backtest**: tunable inputs were ignored entirely (no overrides passed) and
  symbol/TF changes never refetched bars. Fixed: overrides applied + fresh bars
  fetched (Massive→Yahoo→synthetic) when symbol/TF differ.
- Result summary now shows in-sample vs out-of-sample split clearly.

## E. Reports / email (no more localhost links)

- New `reports.ts` `submitReport()`: native share-sheet with the actual HTML
  file (Android → Gmail/Drive), else download. Self-contained docs (inline CSS,
  zero host dependency).
- Perf-Tricks matrix: EMAIL/SHARE button is slim, lives in `matrixHost`
  (cleaned up on re-run — no more stacking), and shares a real HTML report.
- Performance report: EMAIL RESULTS routes through the same self-contained
  report (charts + metrics + advisor review).

## F. Math / rendering robustness

- ROC division-by-zero guard (still flagged for a one-line `source[i-length]===0`
  check — see "open items").
- Bars-flatten: clamped `offsetY` within ±2×canvas-height so fling inertia can
  no longer fling candles off-canvas.
- Earlier solid fixes retained: MACD signal/hist NaN poisoning, true least-squares
  `linreg`, precision-preserving HA/aggregate rounding, data-adapter filter rework
  (removed 2%-range/spike caps that deleted valid volatile bars), close-position-
  weighted VP delta, tick forming-bar semantics.

## G. Open items (not yet done — next pass)

1. ROC guard (`runtime.ts:273`): `source[i-length]` zero → Infinity. Add
   `prev = source[i-length]; p = prev !== 0 ? (…)/prev*100 : 0`.
2. `backend/main.py:1215` spike filter `ZeroDivisionError` on zero close.
3. Web `main.ts` `drawTimeAxis` calls (3 sites) omit the `timeframe` arg →
   all charts render HH:MM regardless of timeframe. Mobile already passes it.
4. Indicator corpus deep audit (the agent-generated indicators in `indicators.ts`
   need parity + correctness review) and full `docs.ts` terminology sweep.
5. OST sheet is still a center modal — the "lower 40% of viewport" sheet, on-
   chart hold-to-place limit order, and draggable SL/TP trade-lines are not yet
   implemented.

## H. Test status

- fix-validation-test: 30/30 PASS
- math-audit-test: 23/23 PASS
- extreme-test: PASS
- backtest-stress: PASS
- `tsc --noEmit` (mobile + web): clean
- `vite build` (mobile): success (three.js bundled, ~284KB gzip)
- Gradle `assembleDebug`: BUILD SUCCESSFUL