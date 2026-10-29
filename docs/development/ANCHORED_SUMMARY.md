## Goal
- Unify price bars and 3D indicator geometry inside the same Three.js scene so they visually interact, with a `pane="3d"` declaration system that triggers the full 3D layout.

## Constraints & Preferences
- All array functions must follow `array.func(arr, ...)` namespace pattern (PineScript-compatible)
- New structures must be original and unique, not PineScript clones
- 3D styles must be futuristic, realistic, modernized (not basic superimposed graphs)
- Zero `tsc --noEmit` errors required; build must pass `npm run build`
- Docs must be comprehensive with exact syntax, patterns, and use cases
- Indicators must declare `pane="3d"` to request 3D bar mode; when loaded, chart must reload bars inside the Three.js scene
- Performance-critical: Echo Chamber was crashing — array operations and pattern matching must be sparse / pre-filtered

## Progress
### Done
- Added missing `downto` keyword to lexer.ts KEYWORDS set
- Added 22 array functions to interpreter.ts: `shift`, `unshift`, `remove`, `insert`, `clear`, `includes`, `indexOf`, `slice`, `join`, `copy`, `reverse`, `sort`, `fill`, `sum`, `avg`, `min`, `max`, `median`, `stdev`, `percentile`, `head`, `tail`, `range`, `first`, `last`
- Added `OakRing` (fixed-size circular buffer) factory with push/pop/first/last/clear/toArray/fill + full statistics (sum, avg, min, max, median, std, percentile) + `ring[0]` (newest) / `ring[size-1]` (oldest) indexing
- Added `Matrix` (2D grid) factory with get/set/row/col/sum/transpose/multiply/add/subtract/toArray + `m[r][c]` indexing
- Modified evaluateCall MemberExpr fallback in interpreter.ts to dispatch method calls on runtime objects (ring.push, m.get, etc.)
- Added evaluateIndex support for OakRing and Matrix
- Updated validator.ts with all new function signatures + `oakring`, `matrix` keywords
- Rewrote docs.ts: comprehensive Arrays reference (6 subsections), OakRing docs (6 subsections + 4 use cases), Matrix docs (4 subsections + 4 use cases)
- Added "Adaptive Kernel with OakRing" indicator to indicators.ts showcasing OakRing, array queues, miss-rate tracking, real-time tick pressure
- Fixed editor.ts pre-existing import bug (missing `getUserIndicators`, `removeUserIndicator` imports)
- **Implemented all 7 advanced 3D geometries** in three-indicators.ts (helix, vortex, manifold, nebula, constellation, torus, trail) with corresponding docs.ts entries and validator PLOT3D_STYLES set
- **Added lower-pane 3D versions** of all 7 styles in three-lower-pane.ts
- Updated runtime.ts OakPlot3D style union and pane union (added `'3d'`)
- Updated interpreter.ts: pane arg now passes through any string (not just `'separate'` vs default `'main'`)
- Added `OakPlot3D[]` import + `renderMain3DScene()` to three-indicators.ts — unified 3D scene rendering bars + indicator geometry with 6 series builders: surface, ribbon, bars3d, scatter, helix, manifold, trail — plus orbit controls
- Added `dispose3DScene()` to three-indicators.ts
- Wired `pane='3d'` detection in main.ts → routes to `renderMain3DScene()`, skips 2D `drawAll`, cleans up on indicator removal
- Added `isChart3DMode()` export + chart3DActive check to skip 2D bar drawing
- Fixed Echo Chamber's source template string (backticks in OakScript comments broke JS template literal)
- **Rewrote Echo Chamber** — lightweight pattern matcher: fingerprint pre-filter before cosine similarity, sparse scan every `scanStep/2` bars, cached best-score between scans, no Matrix overhead, only 2 plot3d calls (trail + nebula)
- **Rewrote ChronoSphere** — removed 5 meaningless main-chart 3D calls (helix, constellation, torus, vortex, nebula on main); kept only 2 meaningful separate-pane 3D (manifold colored by regime + trail); added clear regime zone thresholds on oscillator

### In Progress
- (none)

### Blocked
- (none)

## Key Decisions
- `args` initialized to `[]` in evaluateCall to avoid TS2454 "used before assigned" error while keeping correct logic when dottedName is truthy
- OakRing uses `ring[0]` = newest (last pushed), `ring[size-1]` = oldest (reversed from array convention) for intuitive stack-like access
- Members on OakRing/Matrix are attached as plain function properties rather than class prototypes to avoid TypeScript type widening issues
- `pane="3d"` replaces `pane="main"` in plot3d when the indicator needs the full 3D scene with bars — the chart auto-switches layout
- Echo Chamber uses fingerprint pre-filtering + sparse scan (every 5–15 bars) to avoid O(memSize × patLen) per-bar computation that caused page crashes
- `clearViz()` rewritten to use `for...of` with type checks rather than rigid index-4 threshold so it can intelligently preserve lights, grid, and `_barGroup`
- `renderMain3DScene()` is designed to be called every render frame — it clears old indicator geometry via `clearViz()` (preserving `_barGroup`), then rebuilds new geometry from current `OakPlot3D[]` data, so indicators that continuously emit new plot values are reflected live

## Next Steps
1. Update ChronoSphere and Echo Chamber to use `pane="3d"` where they want bars context (currently only use `"separate"`)
2. Test that 3D bars render alongside indicator geometry in the same Three.js scene with orbit controls enabled
3. Run `tsc --noEmit` then `npm run build` to verify

## Critical Context
- Two Three.js versions coexist: root `three@^0.185.0` (apps/web), packages/core `three@^0.170.0` — use root imports in apps/web/
- three-indicators.ts historically rendered overlay with `alpha: true`, pointerEvents: 'none'; chart3DMode flips to `alpha: false`, dark background (0x0a0a18), pointerEvents: 'auto' for orbit
- The existing `is3DMode` boolean in main.ts (line 83) routes to `draw3DScene()` from iso3d.ts (isometric 2D canvas) — the new `pane="3d"` mode is a third state that replaces that path with Three.js scene rendering
- `renderMain3DScene()` series builders use position data normalized within visible bar range: X = `barX()` mapped to [-5, 5] range, Z = price mapped to [-3, 3] using min/max of visible bars
- Build verified clean: `tsc --noEmit` = 0 errors, `npm run build` = success

## Relevant Files
- **C:\DAFECharts\apps\web\src\three-indicators.ts**: 3D scene engine — now has orbit controls, `_barGroup`, `renderMain3DScene()`, `clearViz()` preserves bar group, series builders for surface/ribbon/bars3d/scatter/helix/manifold/trail
- **C:\DAFECharts\apps\web\src\three-lower-pane.ts**: Lower pane 3D renderer — has all 14 style branches
- **C:\DAFECharts\apps\web\src\main.ts**: Orchestrator — detects `pane="3d"` and calls `renderMain3DScene()`, skips 2D bars when `isChart3DMode()` is active, cleans up via `dispose3DScene()` on indicator removal
- **C:\DAFECharts\apps\web\src\oakscript\runtime.ts**: OakPlot3D pane type now includes `'3d'`
- **C:\DAFECharts\apps\web\src\oakscript\interpreter.ts**: pane=args[4] now passes through any string instead of only 'separate'
- **C:\DAFECharts\apps\web\src\oakscript\indicators.ts**: ChronoSphere + Echo Chamber — need their plot3d calls updated to `pane="3d"` where they want bars context
