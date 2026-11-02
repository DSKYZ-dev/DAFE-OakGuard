# Hackathon brief

Everything a judge (or a teammate) needs: the pitch, what is actually novel, a
demo script that cannot fail, and what comes next.

> **Track: Indie Developer · Theme: Push the Frontier (software — verifiable agents)**
> **Event: Meta Global AI Developer Hackathon (Oct 27 – Nov 4, 2026) · Submission due Nov 4, 9 PM ET**
> Team name / representative / repo URL / video URL: _fill on the submission page._

## What we built during the hackathon (original contributions)

DAFE Charts (the terminal below) pre-exists. Everything in this list was
built during the event window (Oct 27 – Nov 4, 2026):

1. **DAFE OakGuard** (`apps/web/src/oakguard/`, `tools/verify/oakguard-test.ts`) —
   a constrained verification engine: candidate *declarative* validation rules
   come from a hand-written catalogue today (a live model as proposer is the next
   step); an independent evaluator (frozen corpus,
   visible + held-out mutants) promotes only what passes every gate;
   rejections are preserved in an Emeritus archive with counterexamples.
   Promoted rules enforce live in the real OakScript validator.
2. **OakGuard Observatory ("The Crucible")** — a Three.js scene where the
   improvement loop is visible: Playbook Core (one ring per promoted rule),
   mutant swarm, pipeline stages, Emeritus shards. Every visual encodes a
   real evaluator number.
3. **Request-Coverage gate + shared generation pipeline**
   (`trade-advisor/request-coverage.ts`, `generation-pipeline.ts`) — the
   semantic check the syntax validator cannot be: unrequested indicator
   families, explicit user negations, tautological signals, and
   Prefer-3D enforcement. The same gate now backs a shared pipeline used by
   the app and the live test harness: gated concept brief (`USES:` /
   `EXCLUDES:`), built-in exemplar injection, best-of-2 drafts, deterministic
   table/3D/layer repair, and deletion-list escalation in the fix loop.
4. **Universal market-data adapter** (`backend/main.py` DATA_PROVIDERS,
   Settings → Universal Data Providers) — any provider (Polygon, Alpaca,
   Twelve Data, custom REST) converted to one internal bar feed.
5. **Visual system** — gradient-terrain 3D builders, lower-pane manifold
   surfaces, pane-scaled markers, main-chart signals for all 3D studies,
   a Visual Editor module, unified interface-glow theming + brightness.
6. **Meta Model API provider preset** — Trade Advisor and OakScript Coder
   can run Muse Spark / Muse Wonder natively alongside local models.
7. **Signal engines that read in both views** (`tools/verify/signal-engine-audit.ts`,
   `apps/web/src/plot-twins.ts`) — all 42 library engines are validated, executed and
   classified headlessly (`npm run verify:signals`: 42 OK, 0 WARN, 0 FAIL). A 3D layer or
   marker that a script draws only in 3D gets a 2D twin, so the same engine reads in both
   views. New **Wind Velocity Vector 3D**: gust cones with pitch/yaw/roll, a velocity ribbon,
   a tail trail, and two small charts with live readouts. Windows lay out below the header
   bar on first load.
8. **Backtest honesty certificate and forming-bar checks** (`apps/web/src/oakguard/honesty.ts`,
   `tools/verify/honesty-test.ts`). Every backtest result shows a certificate for the procedure
   behind it: no lookahead on replay, fills at the next open, costs, a reserved out-of-sample
   period, and no selection on it. Live signals on the forming bar are checked the same way, and
   four shipped indicators were gated to fire only on closed bars. The certificate certifies the
   procedure, not the returns. The coverage gate also checks that each indicator a request names
   is computed (`tools/verify/intent-mutants-test.ts`: 6 of 6 caught).

## One-liner

**DAFE Charts is an offline-first trading terminal with its own indicator
language and an AI advisor that runs on your GPU — write an indicator in plain
English, and it comes back validated, backtested, and rendered as a 3D scene.
OakGuard (new) makes the system improve its own verification playbook —
visibly, and only on evidence.**

## The 60-second pitch

Charting platforms are closed: you rent your indicators, your data and now your
AI from someone else's cloud. DAFE Charts inverts that. It runs on the machine
in front of you — a FastAPI backend for data and model routing, a TypeScript
engine that renders twelve bar types and 3D indicator scenes, its own OakScript
language with a real validator, and a Trade Advisor powered by a local GGUF
model that is sized to your hardware automatically.

The interesting part is not that it draws candles. It is that the semantic layer
is *authored*: an indicator you describe in English is drafted by the coder
model, validated against the language grammar line by line, executed against
your loaded bars for a test run, and only then applied — and the same script can
promote the whole chart into a Three.js scene where the indicator's geometry
lives beside the price bars. When there is no GPU, the same advisor runs on a
hosted model with keys encrypted at rest and completions proxied server-side,
so no credential ever reaches the browser.

## What's genuinely new here

1. **A visual language, not a plotting library.** OakScript introduces
   `plot3d()` with 15 style classes and three pane modes (`main`, `separate`,
   `3d`). `pane="3d"` promotes the chart itself into the Three.js scene, so
   indicator geometry and price bars share one coordinate space and one camera.
   Most platforms treat 3D as a widget; here it is part of the language.
2. **Validation as a first-class loop.** The validator returns line-numbered
   issues (`PINE_DECLARATION`, `NAMED_ARGS`, `VAR_DYNAMIC_INIT`,
   `UNKNOWN_SHAPE_STYLE`, `FN_TOO_MANY_ARGS`, …) and the advisor's auto-fix loop
   repairs the draft before the user sees it. The coder is grounded by a
   retrieval endpoint over the language reference, not by prompt folklore alone.
3. **Hardware-aware local inference.** `model_manager.py` reads each GGUF's real
   architecture out of its header and measures free VRAM to derive context size,
   GPU layer offload, batch and threads per model *per machine* — the same code
   path drives startup and hot-swapping, so they can never disagree.
4. **Provider-agnostic advisor with a real secret boundary.** Eight provider
   families (llama.cpp, Ollama local, Ollama Cloud, OpenCode, OpenRouter,
   OpenAI, Anthropic, OrcaRouter, NVIDIA NIM, custom OpenAI-compatible) behind
   one routing endpoint. Keys are Fernet-encrypted in a per-machine vault; the
   settings API returns masks only; the "Test" action proves a key by running a
   real completion, not by pinging a URL.
5. **A published verification culture.** Ten harness scripts execute real
   OakScript through the real interpreter — 12 bar types × 6 timeframes at 5k
   bars, extreme prices (0.0005 → 1e6), zero volume, NaNs, ATR storms, adapter
   movement classes G1–G9 — with the findings written up in `docs/reports/`
   (math audit, backtest/optimizer addendum, focused testing report).
6. **The editor is not tied to one model vendor.** The saved coder is Meta
   `muse-spark-1.3`; the same pipeline also ran DeepSeek V4 Pro through OpenCode.
   DeepSeek passed the hardest prompt twice with valid, coverage-clean, executing
   code (4,971 chars in 440s, then 3,442 chars under the 600s limit). The next
   prompt's long DeepSeek replies completed with backend HTTP 200 but were lost
   to a local harness connection reset, so it is recorded as **ungraded, not a
   code failure**. A faster-coder retry on that prompt (Qwen 3.8 Flash) produced
   no code because of a sub-second provider error, not a gate failure — recorded
   as indeterminate. Commands, evidence and the honest limits are in
   `docs/reports/CROSS_MODEL_ACCEPTANCE.md`.

## By the numbers

- ≈50,000 lines of TypeScript and Python across app, backend and tooling.
- 30+ modules in `apps/web/src`, 12 in the OakScript engine alone.
- 12 bar types, 15 `plot3d` styles, 4 rendering surfaces (2 canvas + 2 Three.js).
- 95 built-in symbols; Yahoo, Massive and a hybrid correction engine.
- 8 hosted provider families + local llama.cpp + Ollama.
- 10 verification scripts, 8 archived audit/test reports. The full harness run
  asserts 2,171,421 checks with zero failures.
- Ships as a web app and as a Capacitor Android build from the same core.

## Demo video script (3 minutes — event requirement)

1. **The failure (0:00–0:35)** — `?oakguard=1` opens the Crucible. Replay the
   seed failure: the baseline validator calls `sma(close, 0)` *valid*; the
   execution proof shows 0% finite values. The escaped mutant pulses the
   Playbook Core red.
2. **The improvement loop (0:35–1:50)** — candidate rules → probation runs
   the mutant swarm → the length rule passes every gate and the Core **gains
   a labelled ring** (`PLAYBOOK v2`); the naive dotted rule false-positives
   on shipped OakRing code and is archived in **Emeritus** with its
   counterexample.
3. **It matters in the editor (1:40–2:05)** — ask the editor agent, live, for *"an RSI
   breakout with a 3D breakout level."* The coverage gate checks that RSI is actually
   computed, and the Prefer-3D repair restores the 3D layer if the model drops it. The
   indicator lands on the chart, and `npm run verify:intent` shows the headless receipt.
4. **The honest backtest (2:05–2:35)** — run the same EMA cross on 500 bars: the
   certificate says FAIL, because the out-of-sample period has too few trades to vouch
   for. Run it on 2,000 bars: PASS, with fills at the entry bar's open and a reserved
   holdout. Say it plainly: it certifies the procedure, not the returns.
5. **Close (2:35–3:00)** — "Candidate rules, from a catalogue today and a model next, are only as good as the referee.
   This one records every promotion and rejection, and it certifies procedure, not
   profit." End on Settings: the OakScript Coder is on the Meta Model API preset
   (`muse-spark-1.3`), part of Stage One; the Trade Advisor is on OpenCode
   `qwen3.8-flash`, showing the same pipeline is provider-agnostic.

Presenter notes: say "candidate rules," not "the model proposed them" — the catalogue
supplies candidates today, and the live proposer is the next step. Never show an equity
curve or a P&L figure as a result. Record a backup take, because a live model call can
be slow.

## 60-second version

Crucible seed failure → candidates → probation swarm → ring ignites, one rule to
Emeritus → editor agent builds a requested indicator → honest backtest certificate
(FAIL on thin data, PASS on enough) → headless receipts.

## How it was built

Agent-assisted throughout, and deliberately so: the in-app OakScript coder is
itself an agent loop (draft → validate → auto-fix → test), while the wider
codebase was built with coding agents driving the same verification harness.
The reports in `docs/reports/` are the receipts — including the flattering
numbers and the uncomfortable ones.

## What's next

- **Visual compiler** — the design note in `docs/design/VISUAL_COMPILER_PLAN.md`
  proposes compiling the *appearance* decision instead of leaving it to the
  model's prose: metrics in, geometry class out, deterministic style, with an
  authored 2D twin for every 3D scene.
- **Provider capability probing** — model catalogues are global; access is not.
  Probe once, cache per provider, and stop offering slugs a key cannot reach.
- **More 2D twins, fewer dead ends** — every `plot3d` style should degrade to a
  designed 2D form rather than disappearing when 3D is off.
- **Mobile parity** - the Android build now covers the desktop feature list, with AI
  routed through the PC backend and paired with a token. The particle field is verified
  in the browser; voice and the 3D view still need a check on a device. The 3D and ML
  surfaces should follow.

## Submission checklist

- [ ] Track (Indie Developer) + theme (Push the Frontier) on the submission page
- [ ] Demo video recorded from the 3-minute script above
- [ ] Repository PUBLIC on GitHub; in-event contributions listed (see top)
- [ ] Meta Model API key tested (Settings → Provider API Keys → Meta), credits claimed
- [ ] Third-party licences checked (GGUF model, Three.js, Capacitor, fonts)
- [ ] Revoke/re-issue the OpenCode key shared in chat; no key material is in the repo (runtime keys are encrypted and gitignored)
- [x] Android debug APK builds successfully: `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk` (5.4 MB, `RECORD_AUDIO`, synced assets)
- [x] `npm run lint && npm test && npm run verify:oakguard && npm run verify:pipeline && npm run build` green
- [x] Live generation acceptance: `npx tsx tools/verify/final-limit-run.ts acceptance --set all --repeat 10 --fail-fast`
      — **10/10 consecutive runs, 11 of 11 prompts in each (110/110)**, on Meta `muse-spark-1.3`, commit `b64e0e7` (`tools/verify/final-limit-results-acceptance-attempt6-summary.json`)
