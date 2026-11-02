# Cross-model editor acceptance

**Date:** 10/31/2026
**Purpose:** show that the OakScript editor pipeline is provider-agnostic, not tied to Meta. The acceptance harness drives the same `generateIndicatorWithGates` pipeline the app uses (concept brief -> best-of-2 drafts -> mechanical repair -> gated fix loop) and re-grades every result with the validator, request-coverage gate, signal-clustering probe, and interpreter.

**Environment**

- Backend `http://127.0.0.1:8788`, bound to `0.0.0.0:8788` for LAN pairing.
- Saved roles: OakScript Coder = Meta `muse-spark-1.3`; Trade Advisor = OpenCode `qwen3.8-flash`.
- Every run below uses per-request overrides. The harness never changes the saved roles.
- No Meta model is in the cross-model loop.

## Runs

| Run | Models | Set | Result | Notes |
|---|---|---|---|---|
| `deepseek-qwen` | DeepSeek V4 Pro (coder) + Qwen 3.8 Flash (advisor) | 11 prompts | 0/1 (prompt 1) | `NO_CODE` after 514.7s. Backend log: 16K attempt returned 16,384 reasoning / 0 visible chars; the 32K escalation returned 32,768 reasoning / 0 visible chars; the final 32K retry produced 5,730 chars at 11:33:23, after the harness's Node `fetch` had already failed at 154s. The model did produce text, but not inside the old harness window. Evidence: `tools/verify/final-limit-results-deepseek-qwen-run-1.json` and `...-summary.json`. |
| `qwen-crossmodel` | Qwen 3.8 Flash (coder + advisor) | 11 prompts | 0/1 (prompt 1) | `NO_CODE` after 622.1s. The advisor briefs completed (155s and 167s, 3,019 and 2,865 chars). The coder call exceeded the backend's 300s provider timeout (`httpx.AsyncClient(timeout=300.0)`), so the backend returned `OpenCode timed out - try again.` Evidence: `tools/verify/final-limit-results-qwen-crossmodel-run-1.json` and `...-summary.json`. |
| `deepseek-crossmodel-final` | DeepSeek V4 Pro (coder) + Qwen 3.8 Flash (advisor) | 5 prompts (final set) | **1/5** | Rerun after the harness transport was fixed to use `node:http` with a 20-minute cap instead of Node `fetch`. Prompt 1 (the hardest case) **PASSED every check** (`hasCode`, `validAndCoverageClean`, `clusterFree`, `twoIndependentReadings`, `hasMainSignals`, `layersSane`, `noTable`, `releaseGated`, `executesClean`, `shapesSparse`, `shapesAligned`) with one draft, no repair rounds, and 4,971 chars of code in 440.2s. Prompt 2 was stopped by the Qwen advisor brief hitting the backend's old 300s provider timeout (`OpenCode timed out - try again.`), not by DeepSeek code generation. Evidence: `tools/verify/final-limit-results-deepseek-crossmodel-final-run-1.json` and `...-summary.json`. |
| `deepseek-qwen-final-600` | DeepSeek V4 Pro (coder) + Qwen 3.8 Flash (advisor) | 5 prompts (final set) | **1/5** | Same 5-prompt set after raising the backend hosted-provider timeout from 300s to 600s. Prompt 1 **PASSED again** with every editor check green (3,442 chars, 2 briefs, 2 drafts, 2 repair rounds, 935.9s). Prompt 2's Qwen brief completed (4,057 chars at 12:13:58) and DeepSeek returned **8,210 chars** at 12:19:37 with HTTP 200 in the backend log, but the harness recorded `read ECONNRESET` and lost the response body, so it graded `NO_CODE`. That is a local verification-client reset after 5m39s, not a model timeout: the 600s limit was not reached. Evidence: `tools/verify/final-limit-results-deepseek-qwen-final-600-run-1.json` and `...-summary.json`. |
| `deepseek-qwen-p2-600` | DeepSeek V4 Pro (coder) + Qwen 3.8 Flash (advisor) | Prompt 2 only | 0/1 (ungraded) | Focused rerun after adding `--only` to the harness. Qwen's brief completed (2,875 chars at 12:25:43). DeepSeek's first draft burned 16K and 32K on hidden reasoning, then produced **7,561 chars** at 12:34:44; its second draft produced **6,319 chars** at 12:40:45. Both backend calls logged HTTP 200, but the harness again recorded `read ECONNRESET`, so no code reached the grader. This reproduces a local client/connection limit at 5+ minutes, not a model timeout or a code failure. Evidence: `tools/verify/final-limit-results-deepseek-qwen-p2-600-run-1.json` and `...-summary.json`. |
| `qwen-p2-600` | Qwen 3.8 Flash (coder) + Qwen 3.8 Flash (advisor) | Prompt 2 only | 0/1 (no code) | Faster-coder test for prompt 2, chosen after the DeepSeek resets showed the local client cannot hold a 5+ minute response. The Qwen advisor brief completed (2,433 chars at 12:51:55, 229s). The coder call then returned the backend's own error, `OpenCode timed out — try again.`, **sub-second** at 12:51:55, and the backend log shows no provider call for it — so this was neither a 600s generation timeout nor a graded code failure. A direct Qwen coder probe run immediately after the batch answered "OK" in 2.4s, so the OpenCode/Qwen path was live. Recorded as **indeterminate for code quality**: no code was produced, and the run does not prove the model cannot do it. The 829.1s wall clock also exceeds the sum of its logged backend calls (~229s) by about 10 minutes; that gap is unexplained and must not be charged to the model. Evidence: `tools/verify/final-limit-results-qwen-p2-600-run-1.json` and `...-summary.json`. |

## Commands

```powershell
# Qwen editor + Qwen advisor, 11 prompts
npx tsx tools/verify/final-limit-run.ts qwen-crossmodel --set all --repeat 1 --fail-fast `
  --base http://127.0.0.1:8788 `
  --coder-provider opencode --coder-model qwen3.8-flash `
  --advisor-provider opencode --advisor-model qwen3.8-flash

# DeepSeek editor + Qwen advisor, 5-prompt final set (pre-600s evidence)
npx tsx tools/verify/final-limit-run.ts deepseek-crossmodel-final --set final --repeat 1 --fail-fast `
  --base http://127.0.0.1:8788 `
  --coder-provider opencode --coder-model deepseek-v4-pro `
  --advisor-provider opencode --advisor-model qwen3.8-flash

# Same set after the backend timeout was raised to 600s
npx tsx tools/verify/final-limit-run.ts deepseek-qwen-final-600 --set final --repeat 1 --fail-fast `
  --base http://127.0.0.1:8788 `
  --coder-provider opencode --coder-model deepseek-v4-pro `
  --advisor-provider opencode --advisor-model qwen3.8-flash

# Isolate one prompt after a verification-client reset
npx tsx tools/verify/final-limit-run.ts deepseek-qwen-p2-600 --set final --only 2 --repeat 1 --fail-fast `
  --base http://127.0.0.1:8788 `
  --coder-provider opencode --coder-model deepseek-v4-pro `
  --advisor-provider opencode --advisor-model qwen3.8-flash

# Faster-coder test on the same prompt (Qwen coder + Qwen advisor)
npx tsx tools/verify/final-limit-run.ts qwen-p2-600 --set final --only 2 --repeat 1 --fail-fast `
  --base http://127.0.0.1:8788 `
  --coder-provider opencode --coder-model qwen3.8-flash `
  --advisor-provider opencode --advisor-model qwen3.8-flash
```

## What the failures mean

- The routing, prompt construction, overrides, and grading path are model-agnostic: the same backend endpoint and pipeline handled both models.
- The 5-prompt and 11-prompt limit sets are adversarial. They are designed to stress the gates, not to be a typical user request. A model can be useful for ordinary generation and still miss these cases.
- The failures were caught by the gates. `NO_CODE` was never accepted as a valid indicator, and no invalid or off-request script was promoted.
- Non-Meta models on this OpenCode plan are slower than the Meta path: DeepSeek needs more than 16K reasoning tokens on prompt 1, and Qwen's coder call exceeded the old 300s provider timeout. DeepSeek's prompt-1 pass required a 16K attempt that emitted no visible text, then a 32K retry that produced the code. The backend hosted-provider timeout has since been raised from 300s to 600s.
- Under the 600s limit, prompt 2's Qwen brief finished and DeepSeek produced an 8,210-character reply, so the old 300s timeout was no longer the blocker. The harness lost that reply to a local `read ECONNRESET` after 5m39s while the backend logged HTTP 200. The focused `--only 2` rerun reproduced the same reset on two longer DeepSeek replies (7,561 and 6,319 characters), each served with HTTP 200. The 5-prompt score therefore remains 1/5: prompt 2 is **ungraded**, not a graded code failure.
- The clean cross-model conclusion is prompt 1: DeepSeek passed the hardest prompt twice, with full validator, coverage, clustering, release-gate and interpreter checks. Prompt 2 demonstrates that the provider path can generate long replies, but the local verification client cannot reliably receive a single response that takes more than about five minutes. That is a harness/connection limitation to fix before claiming a full 5-prompt score.
- `qwen-p2-600` was the faster-coder attempt on prompt 2 and it did not produce a gradeable result either, for a different reason: the Qwen advisor brief finished, but the coder call came back as a sub-second provider error (`OpenCode timed out — try again.`) with no provider call logged, so there was no code to grade. Because a direct Qwen coder probe succeeded 2.4s later, this is a transient provider-side failure, not evidence that Qwen cannot code. The honest record is "no code produced", not "failed the gates".
- The Stage One saved coder remains Meta `muse-spark-1.3` for the model-usage criterion and for the 10/10 (110/110) acceptance record. The non-Meta runs are additional evidence of provider neutrality, not a replacement for that record.

## Harness fix

`tools/verify/final-limit-run.ts` previously used Node `fetch` for `/api/chat`. Its default headers timeout expired at about 154s, before the backend's own 300s provider timeout, and reported `fetch failed` for a model that was still generating. The harness now uses `node:http`/`node:https` with a 20-minute request cap. This changes only the verification client; it does not change the app or the backend.

The backend's hosted-provider timeout was also raised from 300s to 600s in `backend/main.py`. Qwen advisor briefs of 155–178s were already close to the old limit, and one brief on prompt 2 exceeded it. Under 600s that brief completed; the remaining prompt-2 failure was a client-side connection reset, not a provider timeout.

`tools/verify/final-limit-run.ts` now also accepts `--only <ids>` so a single prompt can be rerun without repeating the whole set. The focused run is verification-only; it does not change the app or the saved roles. It also showed that the Node `http` transport can still lose a response that takes more than about five minutes, even though the backend returns 200. A job/poll transport (or a streaming keepalive) is the next reliability fix for the harness; the app's own UI timeout remains the user-facing safeguard.

Two observed harness artefacts are worth naming so a future reader does not misread them as model results:

- A response that takes more than about five minutes is lost locally as `read ECONNRESET` while the backend logs HTTP 200 (prompt 2, `deepseek-qwen-final-600` and `deepseek-qwen-p2-600`).
- A provider call can fail sub-second and the backend answers with its 600s-timeout message, `OpenCode timed out — try again.`, with no provider request in the log (`qwen-p2-600`). The message is selected from the exception type, not from the elapsed time, so it reads like a timeout even when nothing waited. Distinguishing the two needs the backend to report the exception class (connect/read/pool) alongside that detail, and the harness to retry once before grading a prompt as `NO_CODE`.
