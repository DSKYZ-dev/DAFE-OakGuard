# What was built during the Meta Global AI Developer Hackathon

**Event window:** Oct 26 – Nov 4, 2026 · **Track:** Startup · **Theme:** Push the Frontier (verifiable agents)

DAFE Charts, the trading terminal, existed before the event. This file separates what was built during the event from what already existed, and shows how to check it.

## Proof of the baseline

| | |
|---|---|
| Baseline commit | `53e6a04` "Restore the signature VPI iso-bars", tagged **`pre-hackathon-baseline`** |
| Pushed to GitHub | `DSKYZ-dev/DAFECharts`, branch `claude/regime-ribbon-addon-8taubu`, **2026-09-03 12:40:32 UTC** (GitHub's server-side activity log, `GET /repos/DSKYZ-dev/DAFECharts/activity`) |
| Full history before the event | branch **`pre-hackathon`** in this repository (35 commits, June 26 – Sep 3, 2026) |

Everything in the baseline is pre-existing work. Compare it with the submission:

```bash
git diff --stat pre-hackathon-baseline main              # every file that changed
git diff --stat pre-hackathon-baseline main -- apps/web/src/oakguard   # OakGuard (entirely new)
```

Totals against the baseline: 304 files changed, +35,808 / −8,168 lines, 164 new files. Some of the new files under `tools/verify/` are scripts that existed untracked before the event and were first committed on Oct 27 (listed under "Pre-existing" below); they are not claimed as new.

## Built during the event (the demo shows only these)

| Feature | What it does | Where |
|---|---|---|
| **OakGuard rule learning with Muse Wonder** | When a script passes the validator but is broken at runtime, Muse Wonder writes a declarative rule (schema-constrained JSON, never code) that would have caught it. Rejected rules go back with the reason and a counterexample. | `apps/web/src/oakguard/proposer.ts`, `backend/main.py` (`/api/meta/structured`) |
| **The referee** | Scores each rule against broken variants of the bug (a third held out from the model), 42 shipped scripts plus 4 contrast scripts, and execution checks. Promotes only rules that pass every gate; archives the rest with counterexamples. Malformed specs are rejected before testing. | `oakguard/evaluator.ts`, `rules.ts`, `mutants.ts`, `contrast.ts`, `store.ts` |
| **Runtime oracles** | Prove a bug by running the script on four synthetic markets: dead output, signals that never fire, runtime errors. | `oakguard/oracles.ts` |
| **Rule language** | Three parameterised rule families, including `self-inclusive-window` (a breakout compared with a `highest()` that includes the current bar can never fire). | `oakguard/rules.ts` |
| **The Crucible** | Three.js scene and panel: live Muse Wonder run or a replay of a recorded run (re-graded, never replayed), proposal feed with cost and latency, playbook rings, report. | `oakguard/observatory.ts`, `panel.ts`, `pipeline.ts`, `report.ts` |
| **Learning curve on real Muse Spark drafts** | 32 first drafts measured with a mining / held-out split: validity, silent defects, false alarms. | `tools/verify/learning-curve.ts`, `docs/reports/LEARNING_CURVE.md` |
| **Muse Voice Transcribe** | Push-to-talk in the editor's agent chat, biased toward trading vocabulary. | `apps/web/src/meta-voice.ts`, `/api/meta/transcribe` |
| **Muse Spark visual check** | 👁 Look: Muse Spark reads a capture of the rendered chart and lists what it can and cannot see from the request. | `apps/web/src/visual-check.ts` |
| **Engine fixes found by OakGuard** | `crossover()` calls shared one cached result; `sma()`/`ema()` stayed NaN forever after a leading NaN (a shipped indicator's %D line was dead); scientific notation (`1e-9`) did not parse (5 of 32 Muse Spark drafts failed on it); the editor's 🔧 Fix ignored validator-only errors, so playbook findings were never repaired. | `oakscript/interpreter.ts`, `runtime.ts`, `lexer.ts`, `trade-advisor/oakscript-bridge.ts` |
| **Backtest honesty certificate** | Certifies the procedure behind a backtest: no lookahead, fills at the open, costs, reserved out-of-sample period. Not the returns. | `oakguard/honesty.ts` |
| **Generation gates** | Request-coverage gate, pane law, mechanical repair, gated generation pipeline used by the app and the live harness. | `apps/web/src/trade-advisor/{request-coverage,pane-law,mechanical-repair,generation-pipeline,exemplars}.ts` |
| **Meta Model API integration** | Meta provider, structured output, image input, transcription, cost reporting; every AI role on Meta models. | `backend/main.py` |
| **Judge mode and CI** | `?backend=none` runs everything in the browser; GitHub Pages deploy; CI runs every headless suite. | `apps/web/index.html`, `.github/workflows/` |
| **Verification suites** | `verify:oakguard`, `verify:proposer`, `verify:honesty`, `verify:intent`, `verify:pipeline`, `verify:signals`, `verify:extreme`, editor-agent and live acceptance harnesses. | `tools/verify/` |

Smaller in-event work on existing parts of the terminal (signal-engine audit and 2D twins for 3D layers, Wind Velocity Vector 3D, window layout, Visual Editor, universal data adapter, mobile parity) is recorded in `docs/development/PROGRESS.md` and is not shown in the demo.

## Pre-existing (not part of the demo)

- The DAFE Charts terminal: chart renderers, 12 bar types, volume profile, drawing tools, paper trading, backtester, ML lab.
- The OakScript language core (lexer, parser, validator, interpreter) and the 42-indicator library, apart from the fixes listed above.
- The AI advisor UI, local llama.cpp model manager, provider vault, market-data backend.
- The Capacitor mobile app base and the WebSocket relay.
- The verification harness that existed untracked before the event: `mega-test.ts` (2.17M checks), `focused-test.ts`, `bar-stress.ts`, `backtest-stress.ts`, `extreme-test.ts`, `fix-validation-test.ts`, `math-audit-test.ts`, `adapter-agent-test.ts`, `adapter-math-audit.ts`, `llm-dual-test.ts`, and the audit reports `MATH_AUDIT_REPORT.md` and `BACKTEST_AUDIT_ADDENDUM.md`.
