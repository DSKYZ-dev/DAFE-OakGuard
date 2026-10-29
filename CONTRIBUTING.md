# Contributing

Thanks for taking a look. This page covers the local setup, the checks a change
must pass, and the layout rules that keep the repository navigable.

## Setup

```bash
# 1. Dependencies
npm install
pip install -r backend/requirements.txt

# 2. Optional local LLM: drop a .gguf into models/ and install llama.cpp
#    (the app measures your VRAM and sizes the model itself — see models/README.md)

# 3. Run
start.bat            # LLM + backend + frontend (Windows)
start.bat -no-llm    # skip the local model
npm run backend      # backend only  → http://127.0.0.1:8788
npm run dev          # frontend only → http://127.0.0.1:5173
```

The frontend hot-reloads through Vite. The backend reloads itself when started
with `npm run backend` (uvicorn `--reload`).

## Checks before you push

```bash
npm run lint           # tsc --noEmit — must be clean
npm run build          # production builds for web and mobile
npm test               # OakScript verification harness
python -m compileall -q backend tools   # Python syntax
```

Type-checking is not optional in this repo: `tsc --noEmit` is the gate that keeps
the OakScript runtime, the renderers and the shared types honest. If a change
makes the harness fail, the harness is right more often than the change is.

## Layout rules

The tree is organised deliberately — please keep it that way:

| Path | Belongs here |
|---|---|
| `apps/web/src/` | The web application. New feature modules get a descriptive file name, not `utils2.ts`. |
| `apps/mobile/` | Capacitor app and the Android project. Shared logic belongs in the core, not a fork. |
| `backend/` | Python services. `main.py` is intentionally one file — add an endpoint, don't add a router layer. |
| `packages/types/` | Types shared by both apps. |
| `tools/verify/` | Verification harness scripts. Root stays clean: harness files do **not** live at the top level. |
| `tools/` | Probes and one-off diagnostics (`probe-llm*.py`, `test-massive.py`). |
| `docs/` | Guides, architecture, design notes, reports. |
| `scripts/` | Windows helpers (`start-*.bat`, `reset.bat`, deploy, archive). |
| repo root | Only `start.bat`, package manifests, tsconfig, README, LICENSE, CONTRIBUTING, .editorconfig, .gitignore. |

New harness scripts should import from the app through the relative path
`../../apps/web/src/...` so they run from the repository root:

```bash
npx tsx tools/verify/<script>.ts
```

## Code standards

- **TypeScript**: strict mode is on; no `any` without a comment explaining why;
  prefer explicit types at module boundaries.
- **OakScript**: changes to the language touch `lexer.ts`, `parser.ts`,
  `validator.ts`, `interpreter.ts`, `runtime.ts` **and** the in-app reference in
  `docs.ts`. A language feature without docs and validator coverage is not done.
- **Python**: standard library + the pinned requirements; no new dependency
  without a note in `requirements.txt` explaining the trade-off.
- **Secrets**: never commit `backend/settings.json`, `backend/.vault_key`, or a
  key of any kind. Use the Settings panel — it encrypts on the way in.
- **Comments** explain *why*. The code explains what.

## Commits and PRs

- One logical change per commit; the message says what changed and why.
- A PR should state: what it does, how it was tested (which harness script, which
  check), and any known limitation.
- If a change touches rendering or the interpreter, include the command you ran
  and its outcome in the PR description. "Looks fine locally" is not a test.

## Where to look next

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — module map and extension points.
- [docs/reports/](docs/reports/) — what has been audited and what was found.
- [docs/design/](docs/design/) — proposals, including the visual compiler.
