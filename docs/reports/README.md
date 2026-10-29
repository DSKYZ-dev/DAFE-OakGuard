# Verification reports

These documents are the audit trail for the engine, the OakScript library and
the release process. They are kept **as written at the time** — version numbers,
absolute paths and dates inside them describe the project layout of that day,
not the current tree. The harness they reference now lives in
[`tools/verify/`](../../tools/verify/).

| Report | Contents |
|---|---|
| [MATH_AUDIT_REPORT.md](MATH_AUDIT_REPORT.md) | Mathematics audit: data/rendering integrity, 12 bar types, 30+ stdlib functions, agent prompts — findings by severity with the fixes applied |
| [MATH_AUDIT_REPORT_ENGINE_HARNESS.md](MATH_AUDIT_REPORT_ENGINE_HARNESS.md) | The harness-side copy of the same audit, kept for the record |
| [BACKTEST_AUDIT_ADDENDUM.md](BACKTEST_AUDIT_ADDENDUM.md) | Backtest and optimizer corrections: historical-data preservation, bracket fills and gap handling, in/out-of-sample split, log-spaced parameter sweeps |
| [FOCUSED_TESTING_REPORT.md](FOCUSED_TESTING_REPORT.md) | Focused + adapter + dominance runs: easy/hard prompts per movement type (G1–G9), safeguards, hard visuals |
| [AUDIT-FINALIZATION-REPORT.md](AUDIT-FINALIZATION-REPORT.md) | Release audit finalisation |
| [PRODUCTION-TESTING-REGISTRY.md](PRODUCTION-TESTING-REGISTRY.md) | Registry of production test passes |
| [REPORT-2026-08-20_163314.md](REPORT-2026-08-20_163314.md) | Dated test report |
| [REPORT-2026-08-21_AUDIT.md](REPORT-2026-08-21_AUDIT.md) | Dated audit report |

## How these were produced

Every claim in these reports comes from running the harness in
[`tools/verify/`](../../tools/verify/) against real interpreter output — not from
reading the code and hoping. The scripts generate synthetic bars with known
properties (extreme prices, zero volume, NaNs, rapid timeframe changes, ATR
storms) and assert the engine's behaviour on them.

Reproduce the headline checks yourself:

```bash
npm test                  # full mega-test
npm run verify            # focused ATR-storm / 3D coherence run
npm run verify:stress     # 12 bar types × 6 timeframes × 5k bars
npm run verify:backtest   # backtest + optimizer stress
```
