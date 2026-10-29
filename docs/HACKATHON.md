# Hackathon brief

Everything a judge (or a teammate) needs: the pitch, what is actually novel, a
demo script that cannot fail, and what comes next.

> Fill in the placeholders at the bottom (team, track, video, submission URL)
> before submitting.

## One-liner

**DAFE Charts is an offline-first trading terminal with its own indicator
language and an AI advisor that runs on your GPU — write an indicator in plain
English, and it comes back validated, backtested, and rendered as a 3D scene.**

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

## Demo script (5 minutes)

1. **Launch** — `start.bat -no-llm` if the demo machine has no GPU headroom
   (say why: the app is fully usable without the local model). The browser opens
   on the chart.
2. **Chart surface** — load `SPY`, point out the bar-type menu (12 types), the
   volume profile iso-bars, the regime ribbon, and the live tick engine animating
   the forming bar. Mention the hybrid data path and that synthetic data is
   always labelled.
3. **Ask the advisor** — open the diamond panel and ask something chart-specific
   ("where is the risk if I go long here?"). No setup step: the advisor already
   has the visible bars, indicators and volume profile in context.
4. **Write an indicator by asking** — in the OakScript editor, request:
   *"EMA 9 crossing EMA 21, Fibonacci retracement from the last swing, and mark
   the cross."* Watch the validation pass, hit **Test Run** on the loaded bars,
   then **Accept**.
5. **Go 3D** — flip the 3D toggle with a `pane="3d"` indicator loaded: the chart
   becomes a Three.js scene with the indicator geometry beside the bars; orbit
   with the mouse. Point out the 2D twin when 3D is off.
6. **Backtest** — open the Backtest panel, run it, and show the in/out-of-sample
   split and optimizer grid (log-spaced sweeps, bracket fills validated against
   gaps).
7. **No GPU? Any model** — Settings → Provider API Keys: paste a hosted key, hit
   Test (it runs a real completion), assign the advisor and coder to it. Keys are
   encrypted server-side; the page never sees them.
8. **Close on evidence** — `docs/reports/` and `tools/verify/`: the harness and
   the audits, including the bugs they found and the fixes that shipped.

## 60-second version

Launch → ask the advisor one chart question → ask for one indicator → Test Run
→ Accept → toggle 3D → open Backtest → show Settings → Provider API Keys.

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

- [ ] Team name and track filled in above / on the submission page
- [ ] Demo video recorded from the script above (≤ 5 min)
- [ ] Repository URL and `README` screenshots refreshed on the demo machine
- [ ] Third-party licences checked (GGUF model, Three.js, Capacitor, fonts)
- [ ] API keys tested on the demo machine, then rotated afterwards
- [ ] `npm run lint && npm test && npm run build` green on a clean clone
