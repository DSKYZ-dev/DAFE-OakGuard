# DAFE Charts + OakGuard — Complete Partner Handoff

**Purpose of this document:** give a partner (or a fresh AI session) full context to finish
this project without re-deriving anything. It covers what exists, what was built during the
hackathon, what is verified, what is broken/known-limited, what remains, and what comes after.

**Last updated:** Oct 29, 2026 · **Deadline: Nov 4, 2026, 9:00 PM ET** · Repo: this directory
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
  runtime roles set to **Meta Model API · `muse-spark-1.3`** for both Trade Advisor and
  OakScript Coder (Settings → LLM Configuration). The $150 participant credits should be
  claimed (form in the participant guide) and the key lives encrypted in the backend vault.

## 2. What the product is

**DAFE Charts** — an offline-first AI trading terminal (pre-existing base):
- Desktop web app (`apps/web/`, TypeScript + Vite + Three.js), FastAPI backend (`backend/`),
  optional local llama.cpp LLM, Capacitor Android app (`apps/mobile/`), WebSocket relay (`relay/`).
- 12 bar types, volume profile, drawing tools, live tick simulation, paper trading,
  backtesting (Web Worker) + optimizer, ML lab (sklearn + optional torch), voice, news.
- **OakScript** — a purpose-built indicator language: lexer → parser → validator →
  per-bar interpreter (`apps/web/src/oakscript/`), 91 builtins, 15 `plot3d` styles across
  4 rendering surfaces (2D canvas, Three.js main-scene takeover, Three.js lower pane,
  isometric canvas), ~41 shipped indicators, drawing objects, `model.*` backtest
  execution, `ml.predict`/`rl.action`, multi-timeframe `security()`.
- **Trade Advisor + OakScript Coder** — two LLM roles with separate provider/model config;
  chart-context injection; draft → validate → auto-fix → Test/Accept loop with diff view.

**DAFE OakGuard** (built during the event — the submission headline):
- A constrained, self-improving verification engine. A fixed LLM proposes **declarative
  rule specs (never code)**; an independent evaluator (frozen 41-script corpus, visible +
  held-out mutants, execution probes) promotes only what passes every gate; rejections are
  preserved in an **Emeritus** archive with counterexamples. Promoted rules enforce live in
  the real validator (`validator.ts`) for every future script.
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
| Editor fixes from live testing | Fresh-create routing (create ≠ edit), `bar_index[1]` interpreter fix, auto-fix 3 rounds, phased generation with coder persona + robust code extraction + retry, Clear button in editor | `main.ts`, `interpreter.ts`, `agent.ts`, `editor.ts` |
| Indicator rework | All 41 indicators audited by execution; 15 mini 3D studies rebuilt (2 layers + gated cones + main-chart signals + 2D twins); ATR Trailing Stops rewritten (was mathematically incapable of firing); Stochastic zone-gated (101→31 markers); CCI Manifold flagship (gradient manifold + deviation sheath + dashboard table + main-chart signals); new Session High/Low Divergence model | `oakscript/indicators.ts` |
| 3D renderer | Gradient height-ramp terrains (both Three builders), pane-scaled cones, price-scale mapping for price-denominated series, visible-window series slicing, 98th-percentile robust scaling, fog + in-scene starfield, Shift+drag pan in all 3 orbit handlers, 2D-mode authority over `pane="3d"` | `three-indicators.ts`, `three-lower-pane.ts`, `main.ts` |
| Visual Editor | Bloom/glow/fog/marker/camera controls + Crucible/Professional/Minimal presets, persisted | `apps/web/src/visual-editor.ts` |
| Universal data adapter | Provider registry (Yahoo, Massive, Polygon, Alpaca, Twelve Data, Custom REST with URL template + field map), encrypted keys, Test endpoint fetching real bars | `backend/main.py` (`DATA_PROVIDERS`, `_fetch_via_adapter`), Settings UI |
| Settings/theme | All sections in Provider-API-Keys card treatment; unified interface glow (color + **brightness slider**) across menu, advisor, trading, news, settings, visual editor | `index.html`, `main.ts` |
| Live ticks | Rebuilt anchored: ±0.25% mean-reverting band around the real bar, history never rewritten, exact restore on stop | `main.ts` |
| Background/Live/Suggest fixes | Stars baseline on first load, dropdown applies immediately; single authoritative Live toggle; Suggested = 4 models/regime + cycle button | `main.ts`, `regime-ribbon.ts` |
| Performance | Idle frame caps (20fps 2D / 30fps 3D idle), advisor snapshot only when open, combined-plots once per frame, pixel-ratio 1.5, lower-pane/Observatory pauses | `main.ts`, `three-*.ts` |
| Perf tricks made real | 20 measured (not simulated) tricks, `npm run verify:tricks` (5,000-iteration harness, 0.41ms/iter) | `perf-trick-test-engine.ts`, `tools/verify/perf-tricks-test.ts` |
| Platform fixes | Divider drag (both directions), lower-pane Shift-pan, lower-pane generated legend, lower-pane background follows Display setting | `main.ts`, `three-lower-pane.ts` |
| Editor-agent test suite | 20 prompts: bad draft must be flagged, good draft must be clean/valid/executing/aligned. **ALL 20 PASS** | `tools/verify/editor-agent-test.ts` |
| Meta Model API | Provider preset (`meta`, `muse-spark-1.3`), both roles set to it and verified with live completions | `backend/main.py`, Settings |
| Repo | git initialized, secrets verified untracked (`.gitignore` covers `settings.json`, `.vault_key`, `*.gguf`) | `.git` |

## 4. Verified status (run these; all currently green)

```powershell
npm run lint                 # tsc --noEmit — clean
npm run build                # web + mobile production builds — pass
npm test                     # mega-test: 2,171,421 pass / 0 fail
npm run verify:oakguard      # OakGuard evaluator + assistant pack — pass
npx tsx tools/verify/editor-agent-test.ts   # 20 editor-agent tests — pass
npm run verify:tricks        # perf tricks, 5,000 iterations — pass
npm run verify               # focused suite — pass
npm run verify:stress        # 12 bar types × 6 timeframes — pass
npm run verify:backtest      # backtest/optimizer stress — pass
```

**Model comparison on the final 5 limit prompts** (`tools/verify/final-limit-results-*.json`):

| Model | Score | Notes |
|---|---|---|
| Meta · Muse Spark 1.3 | **2/5** | Passes siege (`model.*`) + broken-script repair; inconsistent on the two hardest generative prompts (empty replies, EMA substitution) |
| NVIDIA · Nemotron 3.5 Lightning 30B | 0/5 | Reflexive ATR additions, request drift; **every failure caught by the gates** |
| NVIDIA · Nemotron 3 Super 120B | — | 404: in catalogue, not callable on this account |
| NVIDIA · DeepSeek V4.1 Flash | — | NVIDIA endpoint 500s/timeouts (verified provider-side with a direct minimal call) |
| OpenCode · Flint 40B | untested | Needs an OpenCode API key (none saved) |

Current role config: **both roles = Meta · `muse-spark-1.3`** (verified live).

## 5. Still needs to be completed (priority order)

1. **Push the repo public on GitHub** (judging requirement). Local git history is ready;
   needs the owner's GitHub account. Then put the URL in `docs/HACKATHON.md` + submission form.
2. **Claim the $150 Meta Model API credits** (participant-guide form) if not done; confirm
   the Meta key in Settings is the credited account's key.
3. **Record the 3-minute demo video** from the script in `docs/HACKATHON.md`
   (Crucible stepper, `http://127.0.0.1:5173/?oakguard=1`). Record a backup take.
   Rehearse once with **Reset Playbook** so the demo starts at v1.
4. **Fill the submission form**: track = Indie Developer, theme = Push the Frontier,
   contributions list = §3 of this doc / top of `docs/HACKATHON.md`, team members, video link.
5. **Rotate both pasted API keys after the event** (Meta + NVIDIA keys were pasted in chat
   during development). They're stored encrypted (`backend/.vault_key` + vault blob), but
   rotation is one paste in Settings → Provider API Keys / Universal Data Providers.
6. Optional if time: **Flint test** (needs OpenCode key) via
   `npx tsx tools/verify/final-limit-run.ts flint` after setting the coder role.
7. Optional: sync or retire the older `C:\DAFECharts` copy so nobody launches the wrong tree
   (it lacks OakGuard entirely — several "not working" reports traced to mixed processes).

## 6. Known issues and honest limitations

- **Muse Spark variance**: on the two hardest generative prompts it sometimes returns empty
  replies or substitutes EMA templates. The gates catch 100% of these (nothing bad ships
  silently), but generation may need a re-ask. Stronger coder models are the fix; the
  harness measures them comparably.
- **Duplicate backend process**: if port 8788 is already bound, a second `start.bat` backend
  fails with `Errno 10048` and the *first* backend keeps serving (this confused testing
  twice). `start.bat -reset` clears stale processes.
- **No local model window** when roles are on hosted providers — expected; llama.cpp only
  runs when a role is set to Local. The RTX 5050 (8GB) runs the bundled GGUF fine if switched back.
- **Mobile is not the same core**: it shares `@dafe/types` only and reimplements screens.
  Keep it in the repo as evidence; do not demo it live. Its build is green.
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
5. **Mobile parity**: shared OakScript core into mobile; 3D + ML surfaces.
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
- Deep links: `?oakguard=1`, `?settings=1`, `?indicator=CCI%20Manifold%20Sheet`.
- Architecture map: `docs/ARCHITECTURE.md` · User guide: `docs/USER_GUIDE.md` ·
  OakGuard plan: `docs/design/OAKGUARD_PLAN.md` · Audits: `docs/reports/`.

## 9. Draft submission copy (ready to paste, edit freely)

**Title:** DAFE OakGuard — the self-improving verification playbook for AI trading agents

**One-liner:** A fixed LLM proposes validation rules for AI-generated trading indicators;
an independent evaluator promotes only what passes frozen-corpus, mutant, and execution
gates — and you can watch it earn every improvement in the Crucible.

**Description (short):** DAFE Charts is an offline-first trading terminal with its own
indicator language (OakScript) rendered in 2D and 3D, an AI trade advisor, and a backtester.
During this hackathon we built OakGuard: the system that makes the AI's own toolchain
trustworthy. The Editor agent's rules are graded deterministically; the Trade Assistant's
rules are graded on process compliance and correct abstention; when an Editor tool changes,
dependent Assistant rules automatically lose certification. Every promotion is proven by
2,171,421 harness checks and a headless evaluator anyone can run (`npm run verify:oakguard`).

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
