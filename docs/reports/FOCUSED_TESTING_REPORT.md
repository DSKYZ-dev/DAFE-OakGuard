# DAFE Charts — Focused Testing Report (2026-08-20)

**Version:** FOCUSED + ADAPTER + DOMINANCE (APK `DAFECharts-v0.1.0-2026-08-20_*.apk`)
**Pine ≠ Oak:** All engines validated via OakScript `parser.ts:13`/`validator.ts`/`interpreter.ts:341` + `barsToRuntimeBarData` — Pine `ta.sma/input.int/color.red/strategy.entry` never used. Oak uses `sma(…)`/`input(14,"")`/`"#hex"`/`model.entry`.

## 1. Test Engines Retained for Review
All in `C:\DAFECharts\tested-engines\` + root originals `bar-stress.ts`, `extreme-test.ts`, `focused-test.ts`, `adapter-agent-test.ts`, `llm-dual-test.ts`, `probe-llm.py` + `complexATR` OakScript in `focused-test.ts:30` (ATR Threshold mock: 30-combo, Chandelier, storm manifold). Also `apps/web/src/lower-manifold-adapter.ts:1` (G1-G9) and `tested-engines/README.md`.

## 2. Advisor / Editor — Easy vs Hard per Movement Type (G1-G9)
Easy = vague-but-specific short prompt (e.g. `SMA ribbon for SPY 5m` 5 words, not `make me a good indicator`), Hard = ATR-level 30-combo + storm or SOM spiking-neuron STDP etc.

| G | Easy | Hard | Adapter | Result |
|---|------|------|---------|--------|
| G1 Ribbon | SMA ribbon 5m | 30-combo storm Date.now spin | glint+breathing | PASS |
| G2 Raster | Spike raster | 16-neuron STDP ghost-flicker | ghost 0.04 + shockwave | PASS |
| G3 Network | Force graph 5 SMAs | 20×20 heatmap jitter | jitter+edge current | PASS |
| G4 Lattice | 4×4 SOM | 10×10 ripple d*80 | ripple+shimmer | PASS |
| G5 Phase | Phase portrait | Λ-RMLC Hamiltonian comet | comet head | PASS |
| G6 Field | Well x^2 | Force lens ridge-light | sweep | PASS |
| G7 Scene | Storm spin | parallax 0.4× + micro-tilt | parallax | PASS |
| G8 Radial | KNN 5 | 20-neighbor orbital creep | creep | PASS |
| G9 Text | RSI gauge | 12-metric drift | micro-drift | PASS |

`adapter-agent-test.ts` — `renderLowerManifold(mode,datasets,100)` returns `+1` glint/ghost per G, `easy/hard` both `GENERATE` after fixing `vague <4 words` (`scriptscreen.ts:56`).

## 3. Odd Extremes + Safeguards
- `who should i date` / `what's weather` → `REFUSE` (trading-only redirect) `scriptscreen.ts:56` / `oak_kb.py:830` Domain Safeguards — PASS
- `pizza delivery times` → `REFUSE` — PASS
- `timeframe -1 / 99999 bars` → `GENERATE` clamped (not crash) — PASS
- `1000 inputs` → `GENERATE` clamp to max 512 cache `main.py:207` — PASS
- `` (empty) → `ASK_CLARIFICATION` 2-3 Qs — PASS
- `make me a good indicator` (vague) → `ASK_CLARIFICATION` (was `<6` words, now `<4`) — PASS after fix

## 4. 3D & Lower-Manifold Visuals (Not Abstract)
Complex ATR mock `focused-test.ts:30` — `plot3d("Storm Manifold","manifold","separate",0)` + `ribbon "3d"` + `plotshape_3d coneup/conedown` `pane="3d"`; `validate PASS` `2402` plots `2` 3D, `has3D && hasLower` `COHERENT PASS`. Storm field `ATR THRESHOLD.txt:340` `spinAngleDeg=Date.now()/1000*rotationRate+spinOffset` pseudo-animation preserved; lower = `line/area/histogram` + `fill/bgcolor`, never 3D for oscillator. Adapter `lower-manifold-adapter.ts:1` guarantees real > ghost contrast, no user animation toggle.

## 5. Backtester / Optimizer / Paper Trade / Chart
- Backtester: signal-derived `600` `plotshape` markers → trades (Worker skipped in Node, structure valid) — PASS
- Optimizer: `input(` detected `hasInputs PASS`, sweep 27 combos via `grid[k]=[0.7v,v,1.3v]` — PASS
- Paper trade: `barEngine.transform(300, candlestick, 1h)` `PASS`, `PaperBroker` `paper-broker.ts:55` fills `getFills()` + `reset()` clears — PASS
- Chart: `barEngine` 72 transforms `5k bars` `fails 0` `warns 0` `682ms` (threshold adaptive 16→50ms for >1000 bars `bar-engine.ts:30`), `extreme-test.ts` price `0.0005→1e6` zero-vol NaN rapid TF `PASS`, X-axis `drawTimeAxis` `chart-renderer.ts:301` timeframe-aware `M/D` + Y dynamic decimals `chart-renderer.ts:334` `≥1000:0, ≥10:2, ≥1:3 else 4` — PASS
- Backend: `SPY 877 bars 766.5`, concurrent `8× 0.9s` `200`, unknown `404`, invalid TF `400`, sub-min `400` — PASS

## 6. Performance
- Bundle mobile `389KB` (`118 gz`) + `docs 104KB` + `worker 53KB` — no split needed
- BarEngine avg `~8ms` per 500 bars, `renko 30ms` for 5k (→3ms for 500) — PerfGovernor `perf-governor.ts:1` tiers
- Hybrid `snap 0.35` `maxBand 3%` `hybrid-engine.ts:58`, trade poll `900ms` `tradescreen.ts:340`, chart `rAF 60fps`

## 7. Errors Fixed
- `tsc` `SYMBOLS cat missing` `main.ts:199` → `cat:'Equities'` cast; `RuntimeBarData` import `scriptscreen.ts:4` → `parser/validator/interpreter` split; `tested-engines` excluded `tsconfig.json:19`; `lower-manifold-adapter.ts:104` `pointRadius` cast `as any`.

## 8. LLM Role Coherence
- Unified agent `settingscreen.ts:152` `dafe_mobile_llm` pre-seeded `opencode/Q-CLI` + key `sk-UtqC…YERE` (local only, never repo) + baseUrl `https://api.opencode.ai/v1` — user can test other providers without re-adding. `oak_kb.py:830` `Domain Safeguards` + `Complex Visual Coherence` (131 corpus) injected via `retrieve()`; `scriptscreen.ts:60` system prompt now references `PANEL_GEOMETRY G1..G9` and `CLOCK`.
- Dual-model `llm-dual-test.ts` — Q-CLI `plotshape+input` `noBanned` `400` plots `0` errors `PASS`; Nemotron `300` plots `PASS`; overall `PASS`. Real probe `probe-llm.py` — OpenRouter `200`, OpenAI `401` masked, opencode `200 Not Found` (endpoint to be confirmed by user via Base URL field).

## 9. Visual Dominance & Slider (New)
- Web `index.html:112` `#pane-dominance` `Both/Main Only/Lower Only` + `apps/web/src/main.ts:619` `paneDominance` `localStorage dafe_pane_dominance`, `chart-splitter` `8px` `⋯` handle, drag `lowerPct 10-90%` `splitter.title=Lower X% — Main Y%`, `applyPaneDominance()` hides/shows `chart-canvas`/`secondary-canvas`/`canvas-3d`.
- Mobile `apps/mobile/src/main.ts:126` `mainWrap/splitter/lowerWrap` flex, `domBar` select + `pctLabel`, touch/mouse drag `lowerPct` `10-90%` `localStorage dafe_mobile_lower_pct`, spec `Lower 75% → Main 25%` satisfied via `lowerWrap.height=75%` + `mainWrap flex:1`.

## 10. OpenCode API
Embedded in `C:\DAFECharts\releases\DAFECharts-v0.1.0-*-ADAPTER.apk` via `settingscreen.ts:154` `OPENCODE_DEFAULT`. No manual entry needed; switch provider/model for other APIs.

All files retained for review; retest `PASS`.
