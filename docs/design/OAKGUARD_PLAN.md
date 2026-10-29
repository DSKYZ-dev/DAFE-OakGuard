# DAFE OakGuard — Build Plan

**Status:** building (this document is the plan of record)
**Product:** OakGuard — a constrained, self-improving OakScript development and verification engine.
**Presentation:** OakGuard Observatory ("The Crucible") — a dedicated Three.js scene where the
improvement loop is visible: failure → candidate → probation → duel → promotion / emeritus.
**Fixed LLM:** the model never changes and is never retrained. What evolves is the external
playbook: declarative validation rules, regression evidence, and the archive of rejected rules.

> Claim we can defend: "A fixed model that measurably improves its own external verification
> playbook — and can prove a change earned promotion, or show you why it was rejected."
> Claim we do **not** make: model weight self-improvement, or discovery of a wholly new bug class.

---

## 1. Why this, why now

DAFE already has the ground truth most self-improvement demos lack:

| Existing asset | Role in OakGuard |
|---|---|
| `apps/web/src/oakscript/validator.ts` | Baseline validator; promoted rules join it as new issue codes |
| `apps/web/src/oakscript/interpreter.ts` + `runtime.ts` | Execution oracle (a rule's target failure is execution-provable) |
| `apps/web/src/oakscript/indicators.ts` (40 shipped scripts, 0 validator errors) | Known-good corpus — the false-positive gate |
| `tools/verify/mega-test.ts` (2,171,421 checks, seeded PRNG) | Regression gate + harness patterns |
| `apps/web/src/trade-advisor/oakscript-bridge.ts` | Existing draft → validate → auto-fix → Test/Accept loop the promoted rule plugs into |
| `builtins.ts` registry | Missing arg type/range metadata — OakGuard rules are exactly that layer |

Terminology note: the governing architecture's six mechanisms (Probation, Duel, Promotion,
Emeritus, Resurrection, Re-certification) are used as mechanism names only. We do **not**
brand the system "RSI" — in a trading terminal RSI means Relative Strength Index.

## 2. Verified seed failures (baseline validator returns `valid=true`, zero issues)

Measured against the current tree:

| Case | Runtime effect |
|---|---|
| `sma(close, 0)` | All-NaN series — dead indicator (`runtime.ts:121`) |
| `rsi(close, -5)` | Garbage pinned at 100 |
| `ema(close, 2.5)` | Intermittent NaNs |
| `close[0 - 1]` (computed index) | Silently reads current bar — validator only catches literal `[-1]` (`validator.ts:398`), interpreter clamps negatives (`interpreter.ts:1882`) |
| `array.pushh(...)`, `m.macdd` | Silently 0/null — validator skips dotted/member names (`validator.ts:542,549`), `evaluateMember` returns null (`interpreter.ts:1950`) |

**Hero seed for the demo:** invalid lookback length (`sma(close, 0)` family) — execution-provable,
mutation generation is mechanical, and the false-positive gate is the 40-script corpus.
**Rejection story:** a naive "unknown dotted call" rule false-positives on `OakRing`/`Matrix`
object methods in shipped scripts — probation must visibly reject it to Emeritus.

## 3. Safety architecture (non-negotiable)

1. **The agent proposes declarative rule specs, never arbitrary code.** A candidate is JSON
   from a template family (`positive-int-length`, `unknown-dotted-call`, …). The evaluator
   compiles specs deterministically.
2. **The evaluator is outside the agent's writable scope.** It lives in
   `tools/verify/oakguard-test.ts` (headless, CI-runnable) and `apps/web/src/oakguard/evaluator.ts`
   (same logic for the in-app panel). It holds a frozen manifest (corpus hash + gate thresholds);
   promotion records carry the manifest hash, and promotion is refused if it changed.
3. **Held-out mutants.** Mutants are split deterministically (every 3rd) into visible /
   held-out sets. The agent-facing report shows visible results; promotion requires held-out
   detection too — teaching to the test does not promote.
4. **Every promotion/rejection is ledgered** with evidence (metrics, counterexample for
   rejections, model id, playbook hash, timestamp) — `localStorage` in-app, mirrored in the
   CLI report. Rejected rules are retrievable by failure-signature (Resurrection) so the
   loop cannot re-propose a dead rule unknowingly; promotions record
   `{modelId, validatorHash}` and are marked stale on model change (Re-certification badge).

## 4. Promotion gates (all numeric, all shown on screen)

A candidate is promoted iff **all** hold:

- Mutant detection = 100% of its family (visible **and** held-out)
- False positives = 0 error-severity flags on the 40-script known-good corpus
- Corpus execution probe: no new runtime errors vs baseline across all 40 scripts
- `npm test` (mega-test) still 2,171,421 pass / 0 fail (run headlessly; result recorded)

## 5. Modules to build

| File | Contents |
|---|---|
| `apps/web/src/oakguard/types.ts` | `RuleSpec`, `RuleIssue`, `MutantCase`, `EvalReport`, `PromotionRecord`, `EmeritusRecord`, `PlaybookState` |
| `apps/web/src/oakguard/rules.ts` | Rule engine: spec → per-source issues (token-based, line-numbered); candidate catalogue (2 hero candidates, 1 naive challenger) |
| `apps/web/src/oakguard/mutants.ts` | Deterministic mutant generation from shipped indicators (length-arg corruption, dotted-call typos); visible/held-out split; synthetic bar generator for execution probes |
| `apps/web/src/oakguard/evaluator.ts` | Frozen manifest + gates; evaluates a candidate vs corpus + mutants + execution probe; seed-failure proof (`sma(close,0)` → finite-value ratio) |
| `apps/web/src/oakguard/store.ts` | Playbook persistence (localStorage), promotion/emeritus ledger, failure-signature index, active-rule validation entry point |
| `apps/web/src/oakguard/observatory.ts` | Dedicated Three.js scene: Playbook Core + rings per promoted rule, pipeline stage nodes, mutant swarm, duel readout anchors, starfield, `FogExp2`, selective bloom (hero emissive ≥1.6, structure <0.45, no random emissive), orbit + poster framing |
| `apps/web/src/oakguard/panel.ts` | OakGuard Lab overlay UI: demo stepper, candidate cards, metrics, emeritus archive, log console; wires evaluator + observatory + store |
| `apps/web/src/main.ts` (1 call) | Mount the OakGuard launcher |
| `tools/verify/oakguard-test.ts` | Headless evaluator CLI — the independent scorekeeper (`npm run verify:oakguard`) |
| `package.json` (1 script) | `verify:oakguard` |

Out of scope: Visual Compiler, chart-renderer retuning, arbitrary-code candidates,
resurrection beyond signature lookup, full statistical re-certification (badge + re-run only).

## 6. Observatory visual grammar (fascinating *and* falsifiable)

Dual policy: **instrument honesty** — every dynamic channel binds to a real evaluator number.

| Visual | Encodes |
|---|---|
| Playbook Core (wire sphere + glowing inner core) | Active playbook; one orbital ring per promoted rule, labelled by issue code |
| Mutant swarm points | Each mutant: caught = flash/collapse at the shield, escaped = reaches core, core pulses red |
| Pipeline nodes + arcs | Candidate's actual stage (Failure → Candidate → Probation → Duel → Gate) |
| Duel readout | Challenger vs incumbent detection / false-positive numbers (HUD text, generated from metrics) |
| Emeritus shards | Rejected rules, dim orbit; click → counterexample + rejection reason |
| Regression constellation | Corpus + execution probe status (green when green) |

Renderer discipline (this scene only): `UnrealBloomPass` threshold ~0.25 with hero materials
at emissive 1.6–2.6, `FogExp2(0x05070f, ~0.03)`, in-scene starfield `Points`, grid floor,
canonical camera with orbit-reset, motion bound to events (never the only data carrier).

## 7. Demo script (5 minutes)

1. Observatory opens: Core with 0 rings, HUD `PLAYBOOK v1 · BASELINE VALIDATOR`.
2. Replay seed failure: validator says *valid*, execution proof shows 0% finite values. Escaped mutant pulses the core red.
3. Agent proposes two candidates. Probation: mutant swarm runs; metrics appear live.
4. Duel: length rule passes all gates → gate ignites; naive dotted rule false-positives on shipped `OakRing` code → rejected to Emeritus with counterexample.
5. Promotion: new ring on the Core, `PLAYBOOK v2 · INVALID_LENGTH_ARG ACTIVE`. Headless `npm run verify:oakguard` + mega-test receipts shown.
6. Re-run original task with v2 rules: bad script is caught, auto-fix applies the rule's fix, series renders finite. Close on the Core, one ring brighter.

Reliability: evaluator is deterministic and live; LLM proposal has a cached candidate
fallback (the catalogue); every stage has a poster frame; record a backup video.

## 8. Build sequence

1. Core types + rule engine + mutants + evaluator; headless CLI green. *(scorekeeper first)*
2. Observatory scene with event API (`launchSwarm`, `promote`, `reject`, `pulseEscape`).
3. Panel UI + stepper + store; wire launcher into `main.ts`.
4. Verification: `npm run lint`, `npm run build`, `npm run verify:oakguard`, `npm test`.
5. Demo rehearsal artifacts: seeded failure script, cached candidates, poster frames.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Rule templates too narrow to feel like "learning" | Two families + a refined-challenger path; Emeritus prevents re-proposal loops |
| Observatory scope creep | One scene, fixed layout, event-driven only; no chart-renderer changes |
| Live LLM nondeterminism | Candidates are specs from a catalogue; evaluator (the scored part) is deterministic |
| Overclaiming | §0 claim language; "fixed model, evolving external playbook" in every surface |
