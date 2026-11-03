# Architecture

This document describes how DAFE Charts is put together: the processes, the
modules, the data flow, where secrets live, and where to add things.

## 1. Process topology

The desktop experience is three local processes plus a browser:

```
┌───────────────────┐    ┌───────────────────────┐    ┌──────────────────────┐
│  llama.cpp        │    │  FastAPI backend      │    │  Vite dev / static   │
│  llama-server     │◄───│  127.0.0.1:8788       │◄───│  127.0.0.1:5173      │
│  127.0.0.1:8081   │    │  main.py              │    │  apps/web            │
│  (optional)       │    │  model_manager.py     │    │  2D canvas renderers │
│  GGUF weights     │    │  ml_engine.py         │    │  Three.js scenes     │
└───────────────────┘    │  vault.py             │    │  OakScript VM        │
                         │  oak_kb.py            │    │  Trade Advisor UI    │
                         └───────────┬───────────┘    └──────────────────────┘
                                     │
                    ┌────────────────┴─────────────────┐
                    │ upstream: Yahoo / Massive /      │
                    │ DuckDuckGo / SerpAPI / hosted    │
                    │ model providers (proxied)        │
                    └──────────────────────────────────┘
```

Optional extras:

- **`relay/`** — a standalone FastAPI WebSocket service that subscribes to Binance
  (crypto) and Polygon/Massive (futures) and broadcasts 10-second OHLCV ticks.
  Ships with a `Dockerfile` and `render.yaml` for one-click deployment.
- **`apps/mobile/`** — a Capacitor Android app that bundles the same TypeScript
  core with a native HTTP bridge; it can talk to a backend on the LAN or run
  against hosted providers directly.

`start.bat` orchestrates the three desktop processes: it kills stale instances,
asks `model_manager.py` which model and parameters fit this machine, launches
llama.cpp, waits for health, starts the backend, starts Vite, and opens the
browser. Every path is relative to the script, so the repo is portable.

## 2. Module map

### Frontend — `apps/web/src/`

| Area | Modules |
|---|---|
| Orchestration | `main.ts` (state, wiring, dispatch), `perf-governor.ts`, `widget-registry.ts`, `storyboard.ts` |
| 2D rendering | `chart-renderer.ts`, `drawings.ts`, `volume-profile.ts`, `regime-ribbon.ts`, `dashboard-widget.ts` |
| Bar engines | `bar-engine.ts` (12 bar types), `data-generator.ts` (synthetic + aggregation) |
| 3D rendering | `three-indicators.ts` (main-scene takeover), `three-lower-pane.ts`, `iso3d.ts` (isometric canvas), `gpu-particles.ts` |
| Visual system | `theme-engine.ts`, `rendering-matrix.ts` (bar type × engine strategy), `age-3d-visuals.ts`, `age-inputs-panel.ts`, `lower-manifold-adapter.ts` |
| OakScript | `oakscript/` — see §3 |
| Advisor | `trade-advisor/` — see §4 |
| Trading | `trading/paper-broker.ts`, `broker-port.ts`, `currency.ts`, `ledger.ts` |
| Backtest | `backtest/engine.ts`, `optimizer.ts`, `stats.ts`, `worker.ts`, `chart.ts`, `data.ts` |
| Data | `data-stream/live-data.ts`, `market-hours.ts`, `ml-client.ts` |
| Platform | `accessibility.ts`, `image-cache.ts`, `crypto-utils.ts`, `webgl-renderer.ts` |

### Backend — `backend/`

| Module | Responsibility |
|---|---|
| `main.py` | Every HTTP endpoint, chat routing, market-data fetching, settings + key vault integration, media/cache helpers |
| `model_manager.py` | GGUF header parsing, VRAM/RAM detection, per-model launch parameter selection, process lifecycle |
| `ml_engine.py` | Classical scikit-learn models and optional torch LSTM/DQN; train/predict/persist in `ml_models/` and `rl_policies/` |
| `oak_kb.py` | OakScript knowledge base: search, retrieval and section lookup used to ground the coder |
| `vault.py` | Fernet encryption for secrets at rest; per-machine key file; transparent migration of legacy plaintext |

## 3. OakScript — the indicator pipeline

```
source ─► lexer.ts ─► parser.ts ─► validator.ts ─► interpreter.ts ─► runtime.ts
                                                                       │
                        ┌──────────────────────────────────────────────┤
                        ▼                        ▼                     ▼
                 chart overlay            lower pane            full 3D scene
                 (canvas 2D)         (Three.js lower pane)   (Three.js main scene)
                        │                        │                     │
                        └──────── plot() ────────┴── plot3d() ─────────┘
                                    plotshape() / drawing objects
```

- **Lexer → parser** produce an AST (`ast.ts`).
- **Validator** enforces the language's rules (argument counts, positional-only
  arguments, valid style names, `plotshape_3d`/`plot3d` pane pairing, risk-free
  history indices) and returns line-numbered issues. Nothing executes unvalidated.
- **Interpreter** runs per bar and emits plots (`runtime.ts` types). Arrays,
  `OakRing` circular buffers and `Matrix` grids are first-class.
- **Builtins** (`builtins.ts`) define the standard library and the 15 `plot3d`
  styles; `indicators.ts` ships example indicators; `docs.ts` is the in-app
  language reference, mirrored by the retrieval endpoints in `oak_kb.py`.
- **Editor bridge** (`trade-advisor/oakscript-bridge.ts`) lets the advisor draft a
  script, shows validation errors, and offers Test Run → Accept / Decline.

Rendering surfaces are chosen by the script: `plot()` draws on the chart or in
the lower pane, `plot3d(..., "separate")` draws in the Three.js lower pane, and
`plot3d(..., "3d")` promotes the whole chart into the unified Three.js scene
(bars + indicator geometry + orbit controls).

## 4. Trade Advisor

```
user turn ─► visual-adapter.ts (bars, indicators, VP, regime, symbol)
           ─► memory.ts (conversation)   ─► token-optimizer.ts (budget)
           ─► agent.ts  ──► POST /api/chat ──► routing:
                                                local llama.cpp (:8081)
                                                ollama / ollama-cloud
                                                opencode · openrouter · openai
                                                anthropic · orcarouter · nvidia · custom
```

- The chart context is assembled **before** the model is called — the advisor does
  not need to be told what is on screen.
- `web-search.ts` adds news/search context; `voice.ts` handles speech recognition
  and playback (synthesis via the backend so voices are consistent).
- The OakScript coder is the same routing path with a different system prompt and
  the `oak_kb` retrieval endpoints attached.
- `api/chat` decides where a request goes; hosted providers are called from the
  backend with decrypted keys, so the page never holds a credential and provider
  CORS is irrelevant.

## 5. Backend endpoints (grouped)

| Group | Endpoints |
|---|---|
| Health / infra | `GET /api/ping`, `GET /api/cache/stats` |
| Model lifecycle | `GET /api/model/status`, `POST /api/model/reload`, `GET /api/models`, `GET /api/ollama/models`, `GET /api/hardware` |
| Chat | `POST /api/chat` (advisor + OakScript coder routing) |
| OakScript knowledge | `GET /api/oak/search`, `/api/oak/retrieve`, `/api/oak/function`, `/api/oak/section` |
| Search / voice | `POST /api/web-search/search`, `POST /api/voice/synthesize` |
| Settings / keys | `GET|POST /api/settings`, `GET /api/llm/providers`, `PUT|DELETE /api/llm/providers/{id}`, `GET /api/llm/models`, `POST /api/llm/providers/{id}/test` |
| Market data | `GET /api/market-data/securities`, `/api/market-data/providers`, `/api/market-data/{symbol}`, `/api/quote/{symbol}` |
| ML lab | `POST /api/ml/train`, `POST /api/ml/predict`, `GET /api/ml/models`, `DELETE /api/ml/models/{id}`, `POST /api/rl/train`, `POST /api/rl/action`, `GET /api/rl/policies`, `DELETE /api/rl/policies/{id}`, `GET /api/ml/device` |

`POST /api/llm/providers/{id}/test` lists the provider's models *and* performs a
real one-shot completion, so "connected" means the key can actually answer —
not merely that a URL resolved.

## 6. Data pipeline

1. `data-stream/live-data.ts` requests bars from the backend for the current
   symbol and timeframe.
2. The backend serves the provider selected in Settings (Yahoo, Massive, or any
   added adapter). The Auto button re-fetches the newest bars from it every 30 s
   while on; no bars are synthesized.
3. `market-hours.ts` gates live behaviour per instrument class (equities,
   futures, forex, crypto, foreign sessions), so the live engine refuses to tick
   a closed market and stops itself at the close.
4. If every provider fails, synthetic data is generated and the status bar says so.
5. The optional relay service can replace step 1–2 with true push ticks over a
   WebSocket for crypto and futures.

## 7. Security and privacy model

| Concern | Approach |
|---|---|
| API keys / broker password | Encrypted at rest in `backend/settings.json` with Fernet (`enc:v1:` prefix). The key file (`backend/.vault_key`) is machine-local, owner-only, and gitignored. Legacy plaintext values are migrated on read. |
| Hosted model credentials | Stored as a single encrypted blob keyed by provider; the API only ever returns masked values (`nvap****…I8-X`), and completions are proxied by the backend. |
| Browser exposure | No key is ever sent to the page; the settings endpoint omits secrets entirely. |
| Local LLM | Talks over loopback only. |
| Telemetry | None. Outbound traffic is limited to the providers you configure. |

## 8. Extension points

| Want to… | Touch |
|---|---|
| Add a bar type | `bar-engine.ts` + `rendering-matrix.ts` (strategy) + the type list in the UI |
| Add a `plot3d` style | `builtins.ts` (style list + validation) and the builders in `three-indicators.ts` / `three-lower-pane.ts` |
| Add a hosted provider | `LLM_PROVIDERS` in `backend/main.py` + the shared provider registry the UI reads |
| Add an endpoint | `backend/main.py` (single-file by design: no router boilerplate) |
| Add an indicator example | `oakscript/indicators.ts` + a section in `oakscript/docs.ts` |
| Add a symbol | `SECURITIES` in `backend/main.py` and the frontend list in `apps/web/src/main.ts` |

## 9. Known constraints

- The one-click launchers (`start.bat`, `scripts/*.bat`) are Windows-first. Every
  component runs elsewhere; only the orchestration scripts assume `cmd.exe`.
- `backend/main.py` is intentionally a single file. It is large but has no hidden
  dependencies between routers; splitting it is a mechanical refactor nobody has
  needed yet.
- 3D scenes need WebGL; the GPU particle paths prefer WebGPU and fall back.
- Model weights are not distributed with the repo — bring your own GGUF and check
  its licence before shipping it.
