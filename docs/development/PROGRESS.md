# DAFE Charts — Live Progression Log

> **Purpose**: Live, active performance and progression log for easy handoffs.
> **Last Updated**: 8/13/2026 5:58 PM CT

---

## Current Status: Phase 5 — Live Tick Engine Overhaul (in progress)

### Completed
- ✅ Full application audit completed
- ✅ Root causes identified for all reported issues
- ✅ Phase 1: Created `theme-engine.ts` — unified color resolver
- ✅ Phase 1: Wired theme into chart-renderer.ts (candles, grid, background, VP)
- ✅ Phase 1: Wired theme into iso3d.ts (candles, kagi, thermal, volume)
- ✅ Phase 1: Fixed VP cache key to include theme/engine/show toggles
- ✅ Phase 1: Added `mark3DSceneDirty()` to all VP panel change handlers
- ✅ Phase 1: Wired accessible palette into theme engine
- ✅ Phase 2: Created `rendering-matrix.ts` — adaptive combination strategy
- ✅ Phase 2: Expanded iso3d.ts for all bar types (bricks, footprint, engine treatments)
- ✅ Phase 2: Applied visual engines to candles (thermal, quantum, wireframe, etc.)
- ✅ Phase 2: Made frameBody dispatch table-driven with validation

### In Progress
- ⏳ Phase 5: Live tick engine overhaul — transform-aware ticks, no flashing

### Pending
- [ ] Phase 1: Wire theme into three-indicators.ts & three-lower-pane.ts
- [ ] Phase 2: Fix renderMain3DScene buildBarGroup for bar types
- [ ] Phase 3: Regime visualization (zones, 3D terrain, transition sweep)
- [ ] Phase 4: Header bar & "Suggested: X" dropdown rework
- [ ] Phase 5: Live tick engine overhaul
- [ ] Phase 6: Show toggle fixes
- [ ] Phase 7: Performance hardening
- [ ] Build & verify

---

## Root Causes Found

### 1. Color Themes — Fragmented
- `vp-theme` only affects VP bin bull/bear colors via `THEME_COLORS`
- Candle colors hardcoded at ~15 sites across all renderers
- `packages/themes` workspace completely unused
- `signalColors()` accessible palette never reaches candles

### 2. Bar Type × View × Mode × Engine — Not Adaptive
- `iso3d.ts` only handles line/area/kagi in 3D; all others fall through to generic candles
- Visual Engine only applies to VP volume blocks, never candles
- `frameBody()` dispatch is brittle with narrow branches
- `renderMain3DScene` renders all bars as plain boxes regardless of barType

### 3. "Show" Toggles Do Nothing
- VP cache key missing `showValueArea`, `showDelta`, `showNodes`, `colorTheme`, `visualEngine`
- `iso3d.ts` doesn't check any show toggle
- `drawVolumeProfile` only honors them in `2D-Side` mode
- No `mark3DSceneDirty()` calls on toggle changes

### 4. Regime Toggle — Minimal
- Only shows/hides tiny text strip
- No chart-level visualization

### 5. Toolbar & "Suggested: X"
- `data-status` text sits between symbol and bar-type in toolbar
- "Suggest: X" is hardcoded per regime, single option

### 6. Live Tick — Fragile
- `startLiveTicks()` pushes raw untransformed bars
- CSS `pulse-live` animation causes flashing
- Bar type changes during live ticks don't re-transform
- `generatePerBarVolumes` called every 300ms tick

### 7. Performance
- `getCombinedPlots()` called twice per frame
- `oakPathKey` uses only plot COUNT
- Per-frame `.slice()`/`.flatMap()` allocations
- `chart3DSig` only compares last series value

---

## Files to Change
| File | Change |
|---|---|
| `theme-engine.ts` (new) | Unified theme resolution |
| `rendering-matrix.ts` (new) | Adaptive combination strategy |
| `chart-renderer.ts` | Theme-aware colors, show toggles, perf |
| `iso3d.ts` | All bar types, engine shaders, show toggles |
| `three-indicators.ts` | Bar-type-aware buildBarGroup, theme colors |
| `three-lower-pane.ts` | Theme colors |
| `main.ts` | Cache key, dispatch table, tick overhaul, header, regime zones, dirty flags |
| `volume-profile.ts` | Cache-key-friendly, theme integration |
| `regime-ribbon.ts` | Multi-option suggestion dropdown |
| `index.html` | Header bar, remove pulse animation, dropdown markup |
| `accessibility.ts` | Candle color integration |