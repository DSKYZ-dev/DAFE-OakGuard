# DAFECharts — Production Testing Registry & Hardening Record

**Final verification:** MEGA harness **2,171,421 assertions / 0 failures (100.0000%)**
+ legacy suites (30/23/extreme/focused/backtest-stress all PASS) + `tsc` clean (web & mobile).

---

## The 20 audited improvements (verified before shipping)

### Engine hardening
1. **Infinite-loop violations are now FATAL** (`interpreter.ts:419`) — previously
   `while true` was caught per-bar, softened into `errors[]`, then re-burned
   200k iterations on EVERY remaining bar (100M+ ops = frozen UI). Now any
   resource-limit throw aborts the entire run instantly. *Found by MEGA fuzz,
   verified fixed by E.infiniteLoopFatal assertion.*
2. **Infinite-loop abort is fast** — aborts in <1 bar of loop work (<200ms),
   asserted under 5s hard bound (previously: minutes of burn on real charts).
3. **MACD signal/hist NaN-poisoning fix** (verified: corr > 0.9 with macd line,
   finite past slow+sig warmup) — shipped earlier, re-verified each run.
4. **True least-squares linreg** replacing SMA alias (exact recovery of linear
   series asserted at 1e-6).
5. **ROC zero-baseline safety** — typed output asserted on zero/negative baselines.
6. **Precision-preserving price rounding** — FX sub-cent precision survives
   HA + aggregation (asserted).
7. **Hull-MA warmup contract documented + asserted** — first finite at
   len-1+√len (matches TradingView semantics), test harness now models
   per-function warmup exactly.
8. **Momentum warmup contract** — first finite at len (asserted).

### Trading engine integrity
9. **Broker cash-conservation invariant proven** across 600 fuzzed order
   lifecycles: `cash = start + realized − commission` to the cent, with
   slippage correctly modeled as embedded in fill price (not double-counted).
10. **Equity/cash identity when flat** asserted every scenario.
11. **Order lifecycle truth table** — cancel-once true, cancel-twice false,
    ghost-id false, cancelled order never fills (600 fuzz cases).
12. **Zero-price tick safety** — broker stays finite with price=0 fills.
13. **tickBar intrabar model re-verified** — conservation holds under
    replay discipline (60 full 300-bar replays).

### Data pipeline
14. **All 8 bar-type transforms** property-tested (900 fuzz series): OHLC
    invariants, sorted timestamps, finite outputs, non-negative volume.
15. **Aggregation (8 timeframes)** — strict ascending keys, OHLC invariants,
    volume conservation.
16. **Volume-profile conservation** — Σ(bins) = totalVolume at 1e-6,
    buy+sell = volume per bin, POC-is-max, VAH≥VAL, |delta| ≤ total.
17. **Generator + RuntimeBarData shape** — length/count identity over 400 runs.
18. **Adversarial inputs** — NaN/±Infinity/0/negative/1e308/1e-300 series
    through 15 StdLib functions: no throws, no spurious Infinity propagation
    (asserted: Infinities only ever trace to Infinity-containing inputs).

### Interpreter execution
19. **10 canonical script shapes × 500 fuzz runs** — no throws, no errors,
    time-bounded (<5s), plots present, series lengths sane.
20. **Loop-cap enforcement** — `for`/`while` both capped at 200k steps/bar
    with the fatal-abort semantics of #1.

---

## Final production test matrix (run from scratch, in order)

| Suite | Scope | Result |
|---|---|---|
| `mega-test.ts` | 2,171,421 property/fuzz/extreme assertions over StdLib, transforms, VP, broker, interpreter, generator, replay | **0 fail — 100.0000%** |
| `fix-validation-test.ts` | 30 targeted regression checks (MACD/linreg/FX/VP/E2E) | 30/30 |
| `math-audit-test.ts` | 23 engine-math spot audits | 23/23 |
| `extreme-test.ts` | NaN/empty/tiny feeds through BarEngine | PASS |
| `focused-test.ts` | safeguards, visual coherence, backtester wiring, VPI | PASS |
| `backtest-stress.ts` | 10k-bar cap, odd cases, 50×20 optimizer grid | PASS |
| `tsc --noEmit` (web + mobile) | type integrity | 0 errors |

## Regression policy
Any engine change → re-run the full matrix above. `mega-test.ts` is seeded
(deterministic PRNG) — the same run is bit-for-bit reproducible; new categories
append seeds, never reuse them.

## Known open items (tracked, not blockers)
- OST lower-40% sheet + on-chart hold-order trading flow (feature, not defect)
- Web `drawTimeAxis` missing `timeframe` arg at 3 call sites (web-only cosmetic)
- `backend/main.py:1215` spike-filter zero-close guard
- Indicator corpus + docs terminology sweep (agent-reference parity)
