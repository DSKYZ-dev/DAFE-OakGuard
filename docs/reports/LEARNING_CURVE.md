# OakGuard learning curve

Generated 2026-11-02T01:31:44.914Z by `npx tsx tools/verify/learning-curve.ts curve`.

- Drafts: 32 first drafts from `meta/muse-spark-1.3`, recorded 2026-11-02T01:27:37.285Z. One coder call per request through the app's own route and system prompt; no brief, no repair, no gates (`tools/verify/learning-curve-drafts.json`).
- Playbook: 3 rule(s) written by `muse-wonder-1.0` (recorded 2026-11-02T01:30:46.297Z) and re-graded by today's referee.
- Split: rules may only be learned from the mining half (even-numbered prompts) and the seed escapes. The held-out half (odd-numbered prompts) is measurement only.

## First-draft validity

22 of 32 drafts pass the baseline validator. All 32 drafts, graded by the current validator. Before scientific notation (1e-9) was added to the lexer, 20 of the same 32 drafts parsed as valid.

| Validator error on an invalid draft | Drafts |
|---|---|
| `INPUT_NO_ASSIGN` | 7 |
| `FN_TOO_FEW_ARGS` | 3 |
| `UNDEFINED_VAR` | 1 |

Every invalid draft is caught before it runs; the app's generation pipeline repairs these in its fix loop.

## Silent runtime defects (escapes)

| | Mining half | Held-out half |
|---|---|---|
| Requests | 16 | 16 |
| Accepted by the baseline validator | 10 | 12 |
| …of which the runtime oracles prove broken (escapes) | 0 | 0 |
| Escapes flagged before running, learned playbook | 0 | 0 |
| Learned-rule flags on drafts the oracles found nothing wrong with (false alarms) | 0 | 0 |

## What this shows

- With the app's hardened coder prompt, Muse Spark's first drafts rarely contain a silent runtime defect: when a draft is wrong, the validator usually says so. The playbook's value on these drafts is precision: the learned rules raise no false alarms on real model output they never saw.
- Generalisation is measured by the referee on every promotion: each learned rule catches held-out broken variants the proposer never saw (see the verdicts in `npm run verify:proposer`).

## Limits

- The oracles run each draft on four synthetic markets (2,400 bars). A signal that never fires there is reported as dead; a legitimately rare signal could be reported too.
- Escapes of a class the rule language cannot express yet stay uncaught. They are the next rule families to add.
- Muse Spark is sampled, so a new `mine` run produces different drafts and different counts.
