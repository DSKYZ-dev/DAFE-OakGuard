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
   a constrained self-improving verification engine: a fixed LLM proposes
   *declarative* validation rules; an independent evaluator (frozen corpus,
   visible + held-out mutants) promotes only what passes every gate;
   rejections are preserved in an Emeritus archive with counterexamples.
   Promoted rules enforce live in the real OakScript validator.
2. **OakGuard Observatory ("The Crucible")** — a Three.js scene where the
   improvement loop is visible: Playbook Core (one ring per promoted rule),
   mutant swarm, pipeline stages, Emeritus shards. Every visual encodes a
   real evaluator number.
3. **Request-Coverage gate** (`trade-advisor/request-coverage.ts`) — the
   semantic check the syntax validator cannot be: unrequested indicator
   families, explicit user negations, tautological signals, and
   Prefer-3D enforcement now iterate in the coder auto-fix loop.
4. **Universal market-data adapter** (`backend/main.py` DATA_PROVIDERS,
   Settings → Universal Data Providers) — any provider (Polygon, Alpaca,
   Twelve Data, custom REST) converted to one internal bar feed.
5. **Visual system** — gradient-terrain 3D builders, lower-pane manifold
   surfaces, pane-scaled markers, main-chart signals for all 3D studies,
   a Visual Editor module, unified interface-glow theming + brightness.
6. **Meta Model API provider preset** — Trade Advisor and OakScript Coder
   can run Muse Spark / Muse Wonder natively alongside local models.

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
2. **The improvement loop (0:35–1:50)** — Propose candidates → Probation runs
   the mutant swarm → the length rule passes every gate and the Core **gains
   a labelled ring** (`PLAYBOOK v2`); the naive dotted rule false-positives
   on shipped OakRing code and is archived in **Emeritus** with its
   counterexample.
3. **It matters after the demo (1:50–2:30)** — Step 6 scans the live library
   with the promoted playbook; then ask the editor agent for *"session
   highs/lows with divergence signals"* — the request-coverage gate keeps it
   honest, the indicator lands on the chart (CCI Manifold dashboard +
   main-chart signals), and `npm run verify:oakguard` shows the headless
   receipt.
4. **Close (2:30–3:00)** — "A fixed model that improves its own verification
   playbook — and proves every promotion." Settings → Universal Data
   Providers + Meta Model API preset as the final frame.

## 60-second version

Crucible seed failure → propose → probation swarm → ring ignites, one rule
to Emeritus → live scan → one editor-agent indicator → headless receipt.

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
- **Mobile parity** — the Android build shares the core; the 3D and ML surfaces
  should follow.

## Submission checklist

- [ ] Track (Indie Developer) + theme (Push the Frontier) on the submission page
- [ ] Demo video recorded from the 3-minute script above
- [ ] Repository PUBLIC on GitHub; in-event contributions listed (see top)
- [ ] Meta Model API key tested (Settings → Provider API Keys → Meta), credits claimed
- [ ] Third-party licences checked (GGUF model, Three.js, Capacitor, fonts)
- [ ] API keys tested on the demo machine, then rotated afterwards
- [ ] `npm run lint && npm test && npm run verify:oakguard && npm run build` green
