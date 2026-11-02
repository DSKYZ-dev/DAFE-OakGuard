# DAFE Charts + OakGuard — Complete Partner Handoff

**Purpose of this document:** give a partner (or a fresh AI session) full context to finish
this project without re-deriving anything. It covers what exists, what was built during the
hackathon, what is verified, what is broken/known-limited, what remains, and what comes after.

**Last updated:** Oct 31, 2026 · **Deadline: Nov 4, 2026, 9:00 PM ET** · Repo: this directory
(`C:\DAFECharts-META-Hackathon`, git initialized locally, **not yet pushed public**)

---

## 1. The event and where we fit

- **Event:** Meta Global AI Developer Hackathon (Cerebral Valley, virtual, Oct 27 – Nov 4, 2026).
- **Track chosen:** **Indie Developer** ($400k pool; judged on creativity, technical ambition, whether it works).
- **Theme chosen:** **Push the Frontier** — software / verifiable agents. (Supporting narrative:
  "Build for Your World" — the founder is a trader; the Pine indicators in the wild are his.)
- **Rules that shape everything:**
  - Submissions due **Nov 4, 9 PM ET**; **3-minute** demo video; judging starts Stage One
    pass/fail on theme fit + Meta model usage.
  - Repos **must be public**. "New work only": the demo may only highlight features built
    during the event; pre-existing work must be explicitly identified. **This is why the
    submission headlines OakGuard, not the whole terminal.**
  - Team max 4. No financial-advice promises (we carry "analysis software, not financial
    advice" disclaimers everywhere).
- **Meta model usage (Stage One insurance):** development with Muse Code (Muse Wonder);
  the runtime OakScript Coder is **Meta Model API · `muse-spark-1.3`** (Settings → LLM
  Configuration). The $150 participant credits should be claimed (form in the participant
  guide) and the key lives encrypted in the backend vault. The Trade Advisor is OpenCode
  `qwen3.8-flash`; the cross-model acceptance runs use per-request overrides without
  changing either saved role.

## 2. What the product is

**DAFE Charts** — an offline-first AI trading terminal (pre-existing base):
- Desktop web app (`apps/web/`, TypeScript + Vite + Three.js), FastAPI backend (`backend/`),
  optional local llama.cpp LLM, Capacitor Android app (`apps/mobile/`), WebSocket relay (`relay/`).
- 12 bar types, volume profile, drawing tools, live tick simulation, paper trading,
  backtesting (Web Worker) + optimizer, ML lab (sklearn + optional torch), voice, news.
- **OakScript** — a purpose-built indicator language: lexer → parser → validator →
  per-bar interpreter (`apps/web/src/oakscript/`), 91 builtins, 15 `plot3d` styles across
  4 rendering surfaces (2D canvas, Three.js main-scene takeover, Three.js lower pane,
  isometric canvas), 42 shipped indicators, drawing objects, `model.*` backtest
  execution, `ml.predict`/`rl.action`, multi-timeframe `security()`.
- **Trade Advisor + OakScript Coder** — two LLM roles with separate provider/model config;
  chart-context injection; draft → validate → auto-fix → Test/Accept loop with diff view.

**DAFE OakGuard** (built during the event — the submission headline):
- A constrained verification engine. Candidates are **declarative
  rule specs (never code)**; an independent evaluator (frozen 42-script corpus, visible +
  held-out mutants, execution probes) promotes only what passes every gate; rejections are
  preserved in an **Emeritus** archive with counterexamples. Promoted rules enforce live in
  the real validator (`validator.ts`) for every future script. Candidates come from a hand-written catalogue today; a live model as proposer is the next step.
- **Backtest honesty certificate** (`apps/web/src/oakguard/honesty.ts`): every backtest result carries a certificate that checks the procedure behind it. The signals do not change when later bars are removed (no lookahead). Entries fill at the open of the entry bar, not the signal close. Commission and slippage are charged. A later period is reserved for out-of-sample results, with at least 20 trades in it, and parameters are never chosen on it. It certifies the procedure, not the returns, so it says nothing about whether a strategy makes money.
- **Forming-bar check:** a signal on the bar still forming in live trading must not depend on the price that bar will close at. `barstate.isconfirmed` is now real, and four shipped indicators fire live signals only on closed bars (Stochastic, Bollinger Bands, Pivot Constellation, Fibonacci Levels 3D). History is unchanged.
- **Intent checks:** the request-coverage gate requires each indicator a request names (RSI, EMA, MACD, ATR, Stochastic, VWAP) to be computed. Mutation tests remove each one from a working script; the gate catches all six and reports none of the intact scripts.
- **Observatory ("The Crucible")** — a Three.js scene (`?oakguard=1`): Playbook Core gains a
  labelled ring per promoted rule; mutant swarm; pipeline stages; Emeritus shards.
- **Two-role design (adopted Oct 29):** Editor pack (deterministic gates, fully built) +
  Trade Assistant pack (3 rules graded on process compliance + correct abstention over
  point-in-time scenarios), connected by a **dependency graph**: when an Editor tool
  changes, dependent Assistant rules lose certification until re-graded.

## 3. Everything completed during the event (with receipts)

| Workstream | What shipped | Key files |
|---|---|---|
| OakGuard core | Rule specs, token-based rule engine, mutant generation from shipped indicators, evaluator with frozen manifest, promotion/Emeritus store | `apps/web/src/oakguard/{types,rules,mutants,evaluator,store}.ts` |
| OakGuard headless scorekeeper | `npm run verify:oakguard` — seed proof, 3 candidate verdicts, assistant pack | `tools/verify/oakguard-test.ts` |
| Observatory + panel | 3D Crucible scene + 8-step demo panel in Settings → LLM Configuration | `oakguard/{observatory,panel}.ts` |
| Request-Coverage gate | Unrequested families, explicit negations, tautological signals, ungated level signals, duplicate 3D layers, locked input bounds, table duplication, pane law (oscillators → separate pane), decorative-vs-Prefer3D resolution, repair-intent exemption | `apps/web/src/trade-advisor/request-coverage.ts`, wired into `agent.ts` + `oakscript-bridge.ts` + `main.ts` |
| Forming-bar semantics | `barstate.isconfirmed` is real: the forming bar of a live feed is unconfirmed. Four shipped indicators (Stochastic, Bollinger Bands, Pivot Constellation, Fibonacci Levels 3D) fire live signals only on closed bars. Shipped history is unchanged (signal audit marker counts identical) | `oakscript/interpreter.ts`, `oakscript/indicators.ts`, `indicator-manager.ts`, `main.ts` |
| Backtest honesty certificate | Certificate under every backtest result: no-lookahead replay, fills at the entry bar's open, costs charged, a reserved out-of-sample period with at least 20 trades, no parameter selection on it, and the live forming-bar check reported separately. 14 headless controls; PASS on 2,000 SPY bars in the app | `oakguard/honesty.ts`, `oakscript/editor.ts`, `tools/verify/honesty-test.ts` |
| Requested-family coverage | The coverage gate requires each named indicator family (RSI, EMA, MACD, ATR, Stochastic, VWAP) to be computed. Before this, a request for RSI with no RSI passed the gate. Intent mutants: 6 of 6 caught, 0 of 6 intact scripts reported | `trade-advisor/request-coverage.ts`, `tools/verify/intent-mutants-test.ts` |
| Pane law per series | Each `plot3d()` layer on pane `3d` is classified by its own expression (`pane-law.ts`): a price level such as `highest(high, n)` or `low - 2 * atr(...)` stays in the price scene even beside an RSI on the separate pane; oscillator or volatility series (directly or through a variable) are flagged and moved. The coverage gate and the mechanical repair share the classifier. This fixed a false positive that failed acceptance attempt 1, run 3 | `apps/web/src/trade-advisor/pane-law.ts`, `request-coverage.ts`, `mechanical-repair.ts`, `tools/verify/extreme-limit-test.ts` |
| Generation hardening | Shared pipeline used by the app **and** the live harness: gated concept brief (`USES:`/`EXCLUDES:`), few-shot built-in exemplars, best-of-2 drafts with early stop, deterministic table/3D/duplicate-layer/terrain-preserving repair, 220-bar synthetic execution probe inside `gradeCode`, deletion-list escalation in the fix loop, compact design-summary empty-reply failover, and Meta `reasoning_effort` budget pinning (`low` → `minimal` on retry) | `generation-pipeline.ts`, `exemplars.ts`, `mechanical-repair.ts`, `agent.ts`, `oakscript-bridge.ts`, `backend/main.py` |
| Editor fixes from live testing | Fresh-create routing (create ≠ edit), `bar_index[1]` + boolean/assigned variable history (`varHistory` so `bull[1]`/`loaded[1]` work across bars) interpreter fixes, auto-fix 3 rounds, phased generation with coder persona + robust code extraction + retry, Clear button in editor | `main.ts`, `interpreter.ts`, `agent.ts`, `editor.ts` |
| Indicator rework | All 42 indicators audited by execution (`npm run verify:signals`); 15 mini 3D studies rebuilt (2 layers + gated cones + main-chart signals + 2D twins); ATR Trailing Stops rewritten (was mathematically incapable of firing); Stochastic zone-gated (101→31 markers); CCI Manifold flagship (gradient manifold + deviation sheath + dashboard table + main-chart signals); new Session High/Low Divergence model | `oakscript/indicators.ts` |
| Signal engines → 2D/3D | Every library engine audited headless by `npm run verify:signals`: **42 OK · 0 WARN · 0 FAIL**. A 3D layer or marker that a script draws only in 3D gets a per-layer 2D twin (matched by name or latest value; markers deduped by bar), so the same engine reads in both views. AGE LONG/SHORT and Nova rocket/shield icons and billboards fire once per signal (rising edge); Echo Chamber Match σ is a live rolling stdev; new **Wind Velocity Vector 3D** (gust cones with pitch/yaw/roll, velocity ribbon, tail trail, plus two small charts with live readouts) | `plot-twins.ts`, `oakscript/indicators.ts`, `main.ts`, `tools/verify/signal-engine-audit.ts` |
| Window layout | Header bar always visible; draw-tool rail on the screen edge with the Trading panel to its right; no window covers the header bar; first-load windows line up on one row; drag and restore are clamped below the header | `header-band.ts`, `index.html`, `main.ts`, `dashboard-widget.ts`, `age-inputs-panel.ts`, `oakscript/editor.ts` |
| Bar render fixes | Fibonacci and price-level lines sit on the candle plane (aligned to candle centres); the 3D frame follows the visible bars; 3D candle bodies sized to bar pitch; 2D VPI candle bodies no longer overgrow the candle width; iso candle and voxel depth capped | `three-indicators.ts`, `chart-renderer.ts`, `iso3d.ts` |
| 3D renderer | Gradient height-ramp terrains (both Three builders), pane-scaled cones, price-scale mapping for price-denominated series, visible-window series slicing, 98th-percentile robust scaling, fog + in-scene starfield, Shift+drag pan in all 3 orbit handlers, 2D-mode authority over `pane="3d"` | `three-indicators.ts`, `three-lower-pane.ts`, `main.ts` |
| Visual Editor | Bloom/glow/fog/marker/camera controls + Crucible/Professional/Minimal presets, persisted | `apps/web/src/visual-editor.ts` |
| Universal data adapter | Provider registry (Yahoo, Massive, Polygon, Alpaca, Twelve Data, Custom REST with URL template + field map), encrypted keys, Test endpoint fetching real bars | `backend/main.py` (`DATA_PROVIDERS`, `_fetch_via_adapter`), Settings UI |
| Settings/theme | All sections in Provider-API-Keys card treatment; unified interface glow (color + **brightness slider**) across menu, advisor, trading, news, settings, visual editor | `index.html`, `main.ts` |
| Live ticks | Rebuilt anchored: ±0.25% mean-reverting band around the real bar, history never rewritten, exact restore on stop | `main.ts` |
| Background/Live/Suggest fixes | Stars baseline on first load, dropdown applies immediately; single authoritative Live toggle; Suggested = 4 models/regime + cycle button | `main.ts`, `regime-ribbon.ts` |
| Performance | Idle frame caps (20fps 2D / 30fps 3D idle), advisor snapshot only when open, combined-plots once per frame, pixel-ratio 1.5, lower-pane/Observatory pauses | `main.ts`, `three-*.ts` |
| Perf tricks made real | 20 measured (not simulated) tricks, `npm run verify:tricks` (5,000-iteration harness, 0 failures on `b64e0e7`) | `perf-trick-test-engine.ts`, `tools/verify/perf-tricks-test.ts` |
| Platform fixes | Divider drag (both directions), lower-pane Shift-pan, lower-pane generated legend, lower-pane background follows Display setting | `main.ts`, `three-lower-pane.ts` |
| Editor-agent test suite | 20 prompts: bad draft must be flagged, good draft must be clean/valid/executing/aligned. **ALL 20 PASS** | `tools/verify/editor-agent-test.ts` |
| Meta Model API | Provider preset (`meta`, `muse-spark-1.3`), OakScript Coder role set to it and verified with live completions; Trade Advisor is OpenCode `qwen3.8-flash` | `backend/main.py`, Settings |
| Repo | git initialized, secrets verified untracked (`.gitignore` covers `settings.json`, `.vault_key`, `*.gguf`) | `.git` |

## 4. Verified status (run these; all currently green)

```powershell
npm run lint                 # tsc --noEmit — clean
npm run build                # web + mobile production builds — pass
npm test                     # mega-test: 2,171,421 pass / 0 fail
npm run verify:oakguard      # OakGuard evaluator + assistant pack — pass
npx tsx tools/verify/editor-agent-test.ts   # 20 editor-agent tests — pass
npm run verify:pipeline      # generation-pipeline contract tests — pass
npm run verify:tricks        # perf tricks, 5,000 iterations — pass
npm run verify               # focused suite — pass
npm run verify:stress        # 12 bar types × 6 timeframes — pass
npm run verify:backtest      # backtest/optimizer stress — pass
npm run verify:extreme       # extreme-limit deterministic suite (44 checks) — pass
npm run verify:signals       # 42 library engines: validate, execute, 2D/3D twins — 42 OK · 0 WARN · 0 FAIL
npm run verify:honesty       # backtest certificate and forming-bar controls — 14 of 14
npm run verify:intent        # requested-family mutants — 6 of 6 caught, 0 false positives
```

**Model comparison** (`tools/verify/final-limit-results-*.json`). The other providers were run on the earlier 5-prompt set; the Meta row is the final 11-prompt run:

| Model | Score | Notes |
|---|---|---|
| **Meta · Muse Spark 1.3 (final pipeline, `b64e0e7`)** | **10/10 runs (110/110 prompts)** | **10 consecutive runs of the 11-prompt set (`currentStreak: 10, bestStreak: 10`)**; every prompt passed in all 10 runs (`#1–#11 10/10`). Saved in `tools/verify/final-limit-results-acceptance-attempt6-run-1..10.json` and `final-limit-results-acceptance-attempt6-summary.json` |
| Meta · Muse Spark 1.3 (pre-hardening baseline) | 1/5 | Pre-pipeline baseline (`final-limit-results-meta.json`): 1 of 5 prompts passed (the broken-script repair). The failure reasons are recorded in that file |
| NVIDIA · Nemotron 3.5 Lightning 30B | 0/5 | Reflexive ATR additions, request drift; **every failure caught by the gates** |
| NVIDIA · Nemotron 3 Super 120B | — | 404: in catalogue, not callable on this account |
| NVIDIA · DeepSeek V4.1 Flash | — | NVIDIA endpoint 500s/timeouts (verified provider-side with a direct minimal call) |
| OpenCode · DeepSeek V4 Pro (editor, 5-prompt final set) | 1/5 | Prompt 1, the hardest case, passed every editor check (valid, coverage-clean, executes) in both the 440s run (4,971 chars) and the 600s-timeout rerun (3,442 chars, 2 briefs, 2 drafts, 2 repairs). Prompt 2's Qwen brief and DeepSeek replies completed (8,210, 7,561 and 6,319 chars) with backend HTTP 200, but the local harness lost every 5+ minute response to `read ECONNRESET`; prompt 2 is therefore **ungraded, not a code failure**. See `docs/reports/CROSS_MODEL_ACCEPTANCE.md` |
| OpenCode · Qwen 3.8 Flash (editor, 11-prompt set) | 0/1 | The Qwen coder call exceeded the old 300s provider timeout; the advisor briefs themselves completed (155s and 167s, 3,019 and 2,865 chars). The 600s backend timeout was added after this run |
| OpenCode · Qwen 3.8 Flash (editor, prompt 2 only, 600s timeout) | 0/1 (no code) | Faster-coder test on the prompt the DeepSeek resets made ungradeable. The advisor brief completed (2,433 chars, 229s), but the coder call returned the backend's `OpenCode timed out — try again.` error **sub-second** with no provider call logged, so it was neither a 600s timeout nor a code-quality failure. A direct Qwen coder probe right after answered in 2.4s. **Indeterminate for code quality: no code produced, not a gate failure.** Evidence: `tools/verify/final-limit-results-qwen-p2-600-run-1.json` |
| OpenCode · Flint 40B | untested | The OpenCode key is saved and DeepSeek/Qwen run through it; Flint was not part of the acceptance |

The **10/10 (110/110)** acceptance pass on the final 11-prompt set was achieved with `npx tsx tools/verify/final-limit-run.ts acceptance --set all --repeat 10 --fail-fast` on commit `b64e0e7`. The run drives the shared pipeline the app uses (`generateIndicatorWithGates` and `editScriptWithGates`) and checks every output with the validator, the request-coverage gate, the signal-clustering probe, and interpreter execution. The attempts before it, and what failed in each, are in §5 item 6.

Cross-model standing: the honest headline is **DeepSeek V4 Pro passed prompt 1, the hardest prompt in the 5-prompt final set, twice** (4,971 chars in 440.2s; 3,442 chars, 2 briefs, 2 drafts, 2 repair rounds, 935.9s). Prompt 2 is **ungraded**: its replies completed at the provider with HTTP 200 (8,210 / 7,561 / 6,319 chars) but were lost to a local `read ECONNRESET` at the 5+ minute mark, and the faster-coder retry with Qwen produced no code because of a sub-second provider error. Both are verification-client facts, not code failures. The remaining cross-model candidate not yet tried is NVIDIA MiniMax-M3.1-Flash.

Current role config: **Trade Advisor = OpenCode · `qwen3.8-flash`; OakScript Coder = Meta · `muse-spark-1.3`** (Stage One keeps Meta on the coder). The cross-model acceptance run uses per-request overrides, so the harness never changes either saved role. Cross-model commands, results, and failure analysis: `docs/reports/CROSS_MODEL_ACCEPTANCE.md`.

## 5. Still needs to be completed (priority order)

1. **Push the repo public on GitHub** (judging requirement). Local git history is ready;
   GitHub CLI is authenticated as `DSKYZ-dev` and no remote is configured yet. Then put
   the URL in `docs/HACKATHON.md` + submission form.
2. **Claim the $150 Meta Model API credits** (participant-guide form) if not done; confirm
   the Meta key in Settings is the credited account's key.
3. **Record the 3-minute demo video** from the script in `docs/HACKATHON.md`
   (Crucible stepper, `http://127.0.0.1:5173/?oakguard=1`). Record a backup take.
   Rehearse once with **Reset Playbook** so the demo starts at v1.
4. **Fill the submission form**: track = Indie Developer, theme = Push the Frontier,
   contributions list = §3 of this doc / top of `docs/HACKATHON.md`, team members, video link.
5. **No key material in the repository.** The only 23-character literal in the old
   `apps/mobile/src/state.ts` history was the localStorage key name
   `dafe_mobile_massive_key`, not a credential. Runtime provider keys are stored only in
   the encrypted backend vault (`backend/.vault_key` + vault blob), which is gitignored.
   Any provider key shared in chat during development (the OpenCode key was) should be
   revoked and re-issued at the provider before publishing, then pasted in
   Settings → Provider API Keys.
6. **Live acceptance — COMPLETED on the final 11-prompt set (10/10 runs, 110/110 prompts):**
   `npx tsx tools/verify/final-limit-run.ts acceptance --set all --repeat 10 --fail-fast` on
   commit `b64e0e7`: 10 consecutive runs, all 11 prompts passing in each. Records:
   `final-limit-results-acceptance-attempt6-run-1..10.json` and
   `final-limit-results-acceptance-attempt6-summary.json`.
   Earlier attempts are kept as evidence, failures included:
   - Attempt 1 (38ff354-era code): runs 1–2 passed; run 3 failed on prompt 5 (a pane-law false positive, fixed).
   - Attempt 2 (38ff354): runs 1–5 passed; stopped on purpose during run 6, after interpreter changes.
   - Attempt 3 (a696349): run 1 failed on prompt 5 (repair rounds removed the 3D layer; fixed deterministically in 82275ae).
   - Dry run (82275ae): all 11 prompts passed once. Diagnostic only, not counted.
   - Attempt 4 (cf095eb): runs 1–5 passed; run 6 failed on prompt 10 (`atan2` was not an OakScript builtin; fixed in 398f25a).
   - Attempt 5 (398f25a): runs 1–4 passed; run 5 failed on prompt 11 (a marker on the separate pane inside a 3D scene, and state-keyed markers; fixed in b64e0e7).
   Records: `final-limit-results-acceptance-attempt1` to `attempt5` and `final-limit-results-dryrun-*`, all in `tools/verify/`.
7. Optional if time: **cross-model depth.** The provider-neutrality evidence is already
   sufficient (DeepSeek V4 Pro passed the hardest final prompt twice; see §4). Two things
   would strengthen it, in this order:
   - Give the harness a job/poll or streaming-keepalive transport so it can receive a
     reply that takes more than about five minutes. That is the only reason prompt 2 is
     ungraded; the backend logged HTTP 200 for every long DeepSeek reply.
   - Run the next faster coder on prompt 2 with `--only 2`. Qwen 3.8 Flash was tried and
     produced no code (sub-second provider error, not a gate failure); NVIDIA
     MiniMax-M3.1-Flash is the untried candidate:
     `npx tsx tools/verify/final-limit-run.ts minimax-p2-600 --set final --only 2 --repeat 1 --fail-fast --base http://127.0.0.1:8788 --coder-provider nvidia --coder-model minimaxai/minimax-m3.1-flash --advisor-provider opencode --advisor-model qwen3.8-flash`.
     Neither run changes the saved roles; both use per-request overrides.
8. Optional if time: **Flint test** via
   `npx tsx tools/verify/final-limit-run.ts flint` using the saved OpenCode key
   and per-request overrides; it is not needed for the cross-model claim.
9. Optional: sync or retire the older `C:\DAFECharts` copy so nobody launches the wrong tree
   (it lacks OakGuard entirely — several "not working" reports traced to mixed processes).

## 6. Known issues and honest limitations

- **Muse Spark reasoning budget**: `muse-spark-1.3` shares `max_tokens` between hidden reasoning
  and visible output; at default effort it could burn the entire budget on hard prompts (KNN)
  and return an empty reply. Pinning `reasoning_effort="low"` (with `"minimal"` on retry and
  8,192 advisor tokens) plus the 6-stage hardened pipeline brought live convergence from
  1 of 5 prompts in the recorded baseline to **10/10 runs on the final 11-prompt set (110/110 prompts)**.
- **Duplicate backend process**: if port 8788 is already bound, a second `start.bat` backend
  fails with `Errno 10048` and the *first* backend keeps serving (this confused testing
  twice). `start.bat -reset` clears stale processes.
- **No local model window** when roles are on hosted providers — expected; llama.cpp only
  runs when a role is set to Local. The RTX 5050 (8GB) runs the bundled GGUF fine if switched back.
- **OakGuard manifest changed**: four shipped scripts were gated with `barstate.isconfirmed`, so the corpus hash became `8eee75b7` (it was `e1b5c0f4`). Removing the background dashboards from the library changed it again, to `a97f439e`, the current hash (`npm run verify:oakguard` prints it). Promotions made against an older manifest need re-certification before they count.
- **The certificate certifies the procedure, not the returns.** A strategy can pass every historical check and still lose money. It does not model queue position, partial fills or market impact.
- **The requested-family check is a presence check.** It accepts the family's builtin and the operation that defines it (`highest`/`lowest` for %K, `cum` for VWAP). A hand-written form that matches neither is flagged for review, which can cost a fix round. Moving-average and Bollinger families are not checked, since each has several equivalent forms.
- **Pane law is a static heuristic**: `pane-law.ts` reads each 3D series expression and the
  variables it uses; it does not run the script. An oscillator routed through unusual indirection
  (a value passed through a loop or a helper) can still slip past the gate. The editor-agent suite
  and the live acceptance run are the checks on that.
- **Per-engine visual redesign is partial**: all 42 library engines are audited for validity,
  execution, signal discipline and 2D/3D twins (`npm run verify:signals`), and the changed
  engines (Wind Velocity Vector 3D, AGE, Nova, Echo Chamber) were spot-checked in the app. Each
  engine's own visual design was not individually redesigned; that is the next pass.
- **Mobile covers the desktop feature list.** The Android app imports the OakScript core and the OakGuard pipeline from the web code and sends AI calls through the PC backend, so keys stay on the PC. It has the agent review flow (View Diff, Test Run, Accept and Decline, and auto-accept, which applies at once), the OakGuard sheet, the honesty certificate under backtests, a regime strip, Active Signal Models (enabled models only), news, a ledger sealed at fill time, a storyboard, paper auto-trade arming, the Widgets menu, touch drawing tools, voice input, a background particle field, and PC hardware telemetry. The live tick simulator stays removed on mobile by design.
  Caveats: auto-trade is paper-only on mobile. Drawing has no keyboard shortcuts or hover preview. A debug APK builds successfully at `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk` (5.4 MB) with the synced web assets and `RECORD_AUDIO` in the manifest, but voice still needs a device check. Not confirmed on a device: voice, the 3D observatory, the honesty certificate render, and the regime strip on a long history.
  Tested live in a browser: AI routing through the backend to Qwen 3.8 Flash (Trade Advisor reply in 5.0s) and previously to MiniMax-M3.1-Flash, the OakGuard sheet, news, the storyboard, the Widgets sheet, the draw toolbar, and PC hardware telemetry (RTX 5050 Laptop, 8 GB VRAM, 12 cores, 15.3 GB RAM). The particle field paints behind the chart after the resize-start fix. Not tested live: a Scripts generation on the phone (a MiniMax generation did not return within about six minutes in one test, so it needs a visible timeout), the review dialog's generation path, the honesty certificate render, the regime strip on a long history, and the 3D observatory on a device.
- **LAN pairing token.** The backend trusts loopback (the desktop app) with no token. Any other client, including the phone on the LAN, needs the `X-DAFE-Token` header set to the value in `backend/.lan_token`. The file is created on first start and is gitignored. `GET /api/ping` stays open for discovery. The running backend must be restarted to apply this. Phones are paired in Settings → PC Backend Pairing.
- **Per-request editor override.** `POST /api/chat` accepts `coder_provider` and `coder_model` for `oakscript_coder`, and `advisor_provider` and `advisor_model` for `trade_advisor`. These apply to one request and never change the saved roles. The acceptance harness uses them through `--coder-provider`, `--coder-model`, `--advisor-provider` and `--advisor-model`.
- **The verification client loses very long replies.** `tools/verify/final-limit-run.ts` posts with `node:http` and a 20-minute cap, but a single reply that takes more than about five minutes still fails locally as `read ECONNRESET` while the backend logs HTTP 200 and holds the full text. Every DeepSeek reply over 6,000 characters hit this. It is the reason prompt 2 is recorded as ungraded instead of scored, and the reason a faster coder was tried on that prompt. Fix: a job/poll transport or a streaming keepalive in the harness.
- **A sub-second provider failure reports as a timeout.** `backend/main.py` maps every `httpx.TimeoutException` (including connect and pool timeouts) to the same detail, `OpenCode timed out — try again.`, regardless of how long the caller waited. The Qwen coder call returned that detail in under a second with no provider request in the log, so the message read like a 600s timeout when nothing had waited. Two improvements: report the exception class in the detail, and retry once in the harness before grading `NO_CODE`. Until then, treat a `NO_CODE` whose backend log shows no provider call as an ungraded run, not a model failure.
- **3D legibility is improved, not solved**: oscillator terrain in the lower pane now has a
  generated legend; a full visual-compiler (deterministic appearance from metric roles) is
  designed in `docs/design/VISUAL_COMPILER_PLAN.md` but not implemented.
- **Provider capability probing doesn't exist yet**: NVIDIA's catalogue lists models the
  account can't call (120B 404). Roadmap item; the provider "Test" button is the manual probe.
- **OakGuard Assistant pack is a thin slice by design**: 3 rules, deterministic replay
  grading, no structured advisor-call logging or calibration scoring yet (see §7).

## 7. Future roadmap (post-hackathon, in order)

1. **Visual Compiler** (`docs/design/VISUAL_COMPILER_PLAN.md`) — compile appearance from
   metric roles (`viz()`), with authored 2D twins; Phase 0 spike is specced.
2. **Assistant depth**: structured advisor calls (`{side, confidence, abstain}`) logged to
   the Glass Ledger; calibration scoring (Brier) on replay; one shadow-portfolio chart.
3. **Provider capability probing**: probe once per provider, cache, hide unreachable slugs.
4. **OakGuard growth**: more rule families (computed future-index, Pine-signature traps as
   specs), live LLM proposal hookup (the catalogue becomes model-proposed specs through
   the same evaluator), re-certification badges on model/DSL change.
5. **Mobile parity, remaining**: device checks for voice, the 3D observatory, the honesty certificate render, and the regime strip on long history; a visible timeout with a faster path for long hosted generations; 3D + ML surfaces.
6. **Ops**: code-split the 1.3MB web bundle (lazy Three.js/OakGuard), render-on-demand mode.

## 8. Partner quickstart

```powershell
cd C:\DAFECharts-META-Hackathon
npm install
pip install -r backend/requirements.txt
npm run backend          # http://127.0.0.1:8788  (or start.bat)
npm run dev              # http://127.0.0.1:5173
```

- Open the app → the chart works with no keys (Yahoo/synthetic data, synthetic always labelled).
- AI roles: Settings → Provider API Keys (Meta key saved) → LLM Configuration (both = Meta).
- OakGuard: Settings → LLM Configuration → **⬢ OAKGUARD** button, or `?oakguard=1`.
  Steps 1–8 in the panel; **Reset Playbook** to rehearse from v1.
- Editor tests live: OakScript Editor (bottom bar) → Agent Chat; the 10 user prompts +
  5 limit prompts are in `tools/verify/editor-agent-test.ts` (`FINAL_LIMIT_PROMPTS`).
- Generation contract tests: `npm run verify:pipeline`. Extreme-limit suite: `npm run verify:extreme`. Live acceptance (11 prompts × 10 runs):
  `npx tsx tools/verify/final-limit-run.ts acceptance --set all --repeat 10 --fail-fast` (writes per-run
  JSON + summary; a failed run resets the streak).
- Deep links: `?oakguard=1`, `?settings=1`, `?indicator=CCI%20Manifold%20Sheet`.
- Architecture map: `docs/ARCHITECTURE.md` · User guide: `docs/USER_GUIDE.md` ·
  OakGuard plan: `docs/design/OAKGUARD_PLAN.md` · Audits: `docs/reports/`.

## 9. Draft submission copy (ready to paste, edit freely)

**Title:** DAFE OakGuard: an evidence-gated verification playbook for AI trading indicators

**One-liner:** A deterministic referee promotes or rejects validation rules for AI-written
trading indicators, records the evidence behind every decision, and certifies the procedure
behind every backtest.

**Description (short):** DAFE Charts is a pre-existing, offline-first trading terminal with its
own indicator language (OakScript), rendered in 2D and 3D, with an AI editor and trade advisor
running on Meta's muse-spark-1.3. During the hackathon we built OakGuard, the verification layer
for the AI's indicator code. A rule enters the playbook only if it catches planted bugs, held-out
ones included, and wrongly flags none of 42 known-good scripts; rejected rules are archived with
counterexamples. The same checks certify the procedure behind every backtest: no lookahead, fills
at the next open, costs charged, and a reserved out-of-sample period. Each claim can be checked
headlessly (`npm run verify:oakguard`, `verify:honesty`, `verify:intent`), and the live Meta
acceptance runs are in the repository. Current limit: candidate rules come from a hand-written
catalogue, and the live model as proposer is the next step. It certifies procedure, not returns,
and it is not financial advice.

## 10. Judge FAQ (anticipated)

- *"Is the model retraining itself?"* No — the model is fixed (Muse Spark). What evolves is
  its external playbook: declarative rules, tests, and the archive. That's the claim, and it's provable.
- *"Can the agent game its own tests?"* No — candidates are data (specs), the evaluator and
  its manifest live outside the agent's reach, and held-out mutants are never shown to it.
- *"Why two agent roles?"* Because the Assistant's judgment is only as trustworthy as the
  Editor's tools. The dependency graph makes that literal: upgrade a tool, and dependent
  advice rules return to probation automatically.
- *"Does it work without a GPU/cloud?"* Yes — local GGUF via llama.cpp with per-machine
  hardware sizing, or any hosted provider; keys are Fernet-encrypted and never reach the browser.
- *"Does the backtest certificate mean the strategy makes money?"* No. It certifies the procedure:
  no lookahead, fills at the next open, costs charged, a reserved out-of-sample period with enough
  trades, and no parameter selection on that period. The strategy's result is not certified.
- *"Is the playbook self-improving?"* It improves only through evidence: a deterministic referee
  promotes or rejects each rule. Today the candidates come from a hand-written catalogue, and the
  live model as proposer is the next step. The referee is the part that is proven.
- *"What is new compared with the terminal you already had?"* Everything under "What we built during
  the hackathon" in `docs/HACKATHON.md`. The terminal is the pre-existing base.
- *"Does the live path work?"* The live test is the 10-run acceptance against Meta's muse-spark-1.3
  (11 prompts per run). Final result: 10 of 10 runs, 110 of 110 prompts, on commit `b64e0e7`
  (`tools/verify/final-limit-results-acceptance-attempt6-*`). Earlier failures and their fixes are in §5.
