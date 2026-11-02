# DAFE Charts — Live Progression Log

> **Purpose**: Handoff log. The current state of the hackathon build is in `docs/development/TODO.md` (verification and OakGuard steps) and `docs/PARTNER_HANDOFF.md` (submission status and known limits). The August phase log is kept below as history.
> **Last Updated**: 10/31/2026

---

## Current Status (10/31/2026)

### Done
- OakScript docs: `npm run verify:docs` checks that every builtin is named in the in-editor reference (`docs.ts`) and the agent mirror (`backend/oak_kb.py`). The agent section describes preview, Accept & Apply, Decline and auto-accept. OakGuard has its own section.
- Security: web `innerHTML` values that carry feed, script or error text are escaped through `apps/web/src/escape-html.ts`. The backend sends a stored key only to its provider's own origin (LLM and market-data base URLs are pinned).
- Desktop layout: the draw rail and Trading sit under Active Signal Models; the background dashboards are removed from the signal library and the lower pane.
- NVIDIA NIM: `minimaxai/minimax-m3.1-flash` is the NVIDIA model and passes a live test.
- OpenCode: configured at `https://opencode.ai/zen/v1`; `deepseek-v4-pro` and `qwen3.8-flash` both pass live tests. The saved Trade Advisor role is now OpenCode `qwen3.8-flash`; the saved OakScript Coder role stays Meta `muse-spark-1.3` for the Stage One model-usage criterion.
- Cross-model editor evidence: on the 5-prompt final set, DeepSeek V4 Pro (OpenCode) passed prompt 1, the hardest case, with valid, coverage-clean, executing code (4,971 chars, 440s). The 600s-timeout rerun passed prompt 1 again (3,442 chars, 2 briefs, 2 drafts, 2 repairs). Prompt 2's Qwen brief and DeepSeek replies completed (8,210, 7,561 and 6,319 chars) with backend HTTP 200, but the local harness lost every 5+ minute response to `read ECONNRESET`; prompt 2 is ungraded, not a code failure. The focused `--only 2` rerun and the transport limitation are recorded in `docs/reports/CROSS_MODEL_ACCEPTANCE.md`.
- Qwen 3.8 Flash was also tried as the prompt-2 coder to beat the 5-minute client limit (`qwen-p2-600`): 0/1, 829.1s, no code. The advisor brief completed (2,433 chars, 229s), then the coder call returned the backend's `OpenCode timed out — try again.` detail sub-second with no provider call logged, so it was neither a 600s timeout nor a code-quality failure; a direct Qwen coder probe right after answered in 2.4s. Recorded as indeterminate for code quality, not as failed gates. NVIDIA MiniMax-M3.1-Flash is the next candidate if more depth is wanted.
- Mobile feature parity: every desktop feature has a mobile implementation (see `docs/PARTNER_HANDOFF.md` §6). The particle field is verified in the test browser (2,512 painted pixels behind the chart). A debug APK now builds successfully at `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk` (5.4 MB) with the synced assets and the `RECORD_AUDIO` permission. Still to confirm on a device: voice, the 3D view, and the honesty certificate render.
- Security: no API key is present in tracked files or git history. The 23-character literal in commit `47f31c2` was the localStorage key name `dafe_mobile_massive_key`, not a credential. Runtime keys live only in the encrypted backend vault; any provider key shared in chat during development (the OpenCode key was) should be revoked and re-issued at the provider before publishing.
- Public repository: no git remote is configured.

---

## Historical log: Phase 5 — Live Tick Engine Overhaul (paused 8/13/2026)

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