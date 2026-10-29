# Tools

Everything in here is diagnostic or verification tooling — nothing in this folder
ships with the app.

## `verify/` — the OakScript verification harness

Ten scripts that drive the **real** lexer, parser, validator and interpreter
against synthetic bars with known properties. They are how claims about the
engine get checked. See [verify/README.md](verify/README.md) for the full list
and what each one proves.

```bash
npm test                  # full harness            → tools/verify/mega-test.ts
npm run verify            # focused ATR-storm run   → tools/verify/focused-test.ts
npm run verify:stress     # 12 bar types × 6 TFs    → tools/verify/bar-stress.ts
npm run verify:backtest   # backtest + optimizer    → tools/verify/backtest-stress.ts

npx tsx tools/verify/<script>.ts     # anything else, from the repo root
```

## Probes

| Script | Purpose |
|---|---|
| `probe-llm.py` | Reachability check for OpenCode endpoints (no key needed) |
| `probe-llm-endpoints.py` | Keyed probe across OpenCode / OrcaRouter / OpenRouter / OpenAI — reads the key from the environment, never commits it |
| `test-massive.py` | Market-data smoke test: bars and quotes across futures, crypto and equities, plus the provider list |

```bash
python tools/probe-llm.py
OPENCODE_API_KEY=... python tools/probe-llm-endpoints.py
python tools/test-massive.py          # needs the backend running on :8788
```

## Notes

- OakScript is **not** Pine. There is no `ta.sma`, no `input.int`, no
  `color.red`, no `strategy.entry` — the harness exists partly to keep that
  distinction honest while the coder model is asked to write either language.
- Harness scripts import the app through `../../apps/web/src/...`, so they must
  be run from the repository root (or with the repo root as the working
  directory).
- Output of a harness run is a pass/fail summary on stdout plus details for any
  failing assertion. The written-up findings live in
  [`../docs/reports/`](../docs/reports/).
