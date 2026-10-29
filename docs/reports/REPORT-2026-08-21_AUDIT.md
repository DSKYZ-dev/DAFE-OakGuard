# DAFECharts — Full Audit & Fix Report (2026-08-21)

Scope: data adapter, tick pipeline, Volume Profile rendering + math, bar-type
mathematics, OakScript runtime math, signal-agent prompt, test suites.
Every fix below is validated by `fix-validation-test.ts` (30/30 PASS) plus the
existing suites (`math-audit-test`, `extreme-test`, `focused-test`,
`backtest-stress`) — all re-run after changes with zero regressions.

---

## 1. CRITICAL — Data adapters were deleting real market bars

**Files:** `apps/mobile/src/massive.ts`, `apps/mobile/src/yahoo.ts`

Two "sanitization" filters silently corrupted every feed:

1. **2% range cap** — any bar whose high−low exceeded 2% of close (5% daily)
   was dropped. Legitimate volatile bars (crypto 1m, futures on news, earnings
   gaps) vanished → chart gaps, wrong VP, wrong indicator math downstream.
2. **3% spike filter** — any bar moving >3% vs both neighbors was dropped,
   which also fabricated false continuity between surviving bars.

**Fix:** structural validation only (finite values, OHLC invariants enforced
via high=max(h,o,c) / low=min(l,o,c), future-timestamp guard), plus ascending
sort and timestamp dedupe. No range/spike heuristics remain.

**Validation:** 5%-range synthetic bar survives; sort+dedupe unit checks pass.

## 2. CRITICAL — Stuck Volume Profile (user-reported)

**Files:** `apps/web/src/chart-renderer.ts` (`drawVolumeProfile`),
`apps/mobile/src/chartscreen.ts`, `apps/web/src/main.ts`

The profile drew at `y = cTop + i * bH` in a fixed panel space — it never used
the chart's live price→Y transform. Panning/zooming moved candles while POC,
VAH/VAL and all bins stayed pinned to the same pixels.

**Fix:** new optional `VPAlign { minP, pRange, view }` parameter. When passed,
every bin maps through `priceToY()` using `getPriceRange()` of the visible
slice — bins land on their true price levels and track pan/zoom 1:1 with the
candles. Legacy layout preserved for callers without align; both callers now
pass align.

Also fixed an off-by-one: VP slice used `bars.slice(start, end)` excluding the
last visible bar → now `slice(start, endIdx)` with `endIdx = end+1`.

## 3. HIGH — MACD signal/histogram were 100% NaN

**File:** `apps/web/src/oakscript/runtime.ts`

`signal = ema(macdLine)`: macdLine is NaN during slow-EMA warmup, so the SMA
seed summed NaN and poisoned every subsequent EMA value → `.signal`/`.hist`
never produced a finite number. Any script using `crossover(m.macd, m.signal)`
silently never fired.

**Fix:** signal EMA seeds from the first bar where BOTH EMAs are valid; result
padded back to full length with NaN. Hist is NaN only where inputs are.

**Validation:** finite counts >200/300 bars, warmup region ≈ slow+signal bars,
signal↔macd correlation >0.9, E2E script fires shapes post-warmup.

## 4. HIGH — linreg() was an SMA alias

**File:** `apps/web/src/oakscript/runtime.ts`

`linreg(source, len, off)` returned `smaImpl(source,len)`. Every linreg-based
script got a lagged mean instead of a fitted line.

**Fix:** true least-squares slope/intercept per window, evaluated at
`(len−1−offset)` bars back (TradingView ta.linreg parity). Interpreter now
passes the offset argument explicitly. regressionChannel.mid upgraded to the
real fit. Builtins summary + docs updated (no more "SMA approximation").

**Validation:** exact recovery of y=2x+100 and descending lines; offset shifts
evaluation correctly; warmup NaN preserved.

## 5. HIGH — Fixed 2-decimal rounding corrupted low-price instruments

**Files:** `apps/web/src/data-generator.ts` (Heikin-Ashi, aggregateTimeframe)

`Math.round(x*100)/100` turned EURUSD 1.08543 into 1.09 (≈44 pip corruption)
in HA bars and timeframe aggregation.

**Fix:** magnitude-aware `roundPrice()`: 2dp ≥1000, 4dp ≥10, 5dp <10, 6dp
below 0.1. Applied in HA transform and aggregateTimeframe.

**Validation:** FX series retains sub-cent precision through both paths; HA
OHLC invariants hold.

## 6. MEDIUM — Volume Profile buy/sell split was a hardcoded 60/40 guess

**File:** `apps/web/src/volume-profile.ts`

Bin-level split used fixed fractions (bull 0.6/bear 0.4); summary Δ was always
±20% of volume regardless of where closes sat in each bar.

**Fix:** close-position-weighted estimate — t=(close−low)/(high−low), buyFrac =
0.25+0.5·t ∈ [0.25,0.75]. Summary Δ recomputed from bin buy/sell so the drawn
split, the Δ readout and the bins agree exactly.

**Validation:** Δ=+50% when closes touch highs, −50% at lows, ≈0 mid-range;
per-bin buy+sell == volume.

## 7. MEDIUM — Live ticks mutated completed fetched bars

**File:** `apps/mobile/src/chartscreen.ts` (`tickLive`)

With live enabled over Yahoo/Massive/backend data, every 300 ms tick rewrote
the last REAL bar's OHLC/volume — corrupting fetched history.

**Fix:** synthetic feeds keep in-place extension (generator output is already
simulated). Real feeds maintain a separate forming bar appended after history;
completed bars are never touched. Broker/UI tick uses the forming-bar close.
Also removed a hidden upward drift bias (−0.48 → symmetric ±0.008 band).

## 8. MEDIUM — Per-frame VP recompute waste (mobile)

**File:** `apps/mobile/src/chartscreen.ts`

`computeVolumeProfileBins` ran every animation frame (500 bars × 24 bins).
Now memoized on `(symbol, tf, start, endIdx, lastTs, lastClose)`; alignment
still maps cached bins through live pan/zoom each frame, so motion stays
smooth while aggregation only reruns when the window or data actually changes.

## 9. MINOR — Imbalance-bar min-volume gate

Arbitrary `bars[0].volume` gate replaced by 0.5× average bar volume, so one
quiet first bar can't instantly satisfy the imbalance trigger.

## 10. Signal-agent prompt upgrade

**File:** `apps/mobile/src/scriptscreen.ts`

- New **ENGINE MATH CONTRACT**: documents today's exact semantics (MACD NaN
  warmup region, true-linreg, Wilder RMA ATR/ADX/RSI, population stdev,
  mean-dev CCI, magnitude-aware rounding, weighted delta convention, NaN
  crossover guardrails) so generated scripts target current engine behavior.
- Mandatory **self-audit loop before presenting**: G1 plots>0/errors==0,
  G2 no non-warmup NaN reaching plots/signals, G3 signals fire in trend/flat/
  spike regimes and never during warmup, G4 zero lookahead, G5 pane coherence;
  max 3 silent revisions, present only after clean passes.
- Stress-thinking step added: every design must survive monotonic-trend,
  flat-noise and single-spike regimes before code is written.

## 11. Known limitations (documented, not defects)

- Renko here reverses after 1 brick (classic renko requires 2). Intentional
  simplification; flagged for a future toggle.
- Dollar bars use close×volume as dollar proxy (not typical-price×volume).
- VWAP is cumulative session-less (no daily reset) — fine for intraday
  synthetic views; session anchors are a future enhancement.
- Backtest Worker unavailable under Node test runner ("Worker is not defined")
  — browser-only API; stress suite handles and reports it gracefully.

---

## Test matrix (all green)

| Suite | Result |
|---|---|
| fix-validation-test.ts (new, 30 checks) | 30/30 PASS |
| math-audit-test.ts | 23/23 PASS |
| extreme-test.ts (NaN/empty/tiny feeds, BarEngine health) | PASS |
| focused-test.ts (safeguards, visual coherence, backtester) | PASS |
| backtest-stress.ts (10k cap, odd cases, 50×20 optimizer grid) | PASS |
| perf-trick runMatrix + highFrequencyHarness(1000) | PASS (469ms, 0 fails) |
| tsc --noEmit web + mobile | 0 errors |
| vite build mobile + web | OK (2.2s / 6.3s) |
