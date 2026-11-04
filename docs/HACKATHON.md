# Hackathon brief

> **Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026) · Track: Startup · Theme: Push the Frontier (verifiable agents)**
> Submission due **Wed Nov 4, 9:00 PM ET** (8:00 PM Central).

## One line

**Muse Wonder writes the rules that catch bugs in AI-written trading code; a referee it cannot see decides which ones go live.**

## The 30-second pitch

AI coders now write trading indicators for millions of people, and the code compiles, validates
and is quietly wrong: a breakout that can never fire, a moving average that computes nothing.
Checkers only catch the bugs someone thought of. OakGuard runs the code, proves when it is broken,
and asks Muse Wonder for a rule that would have caught it. The rule is data, not code, and an
independent referee scores it on broken variants the model never saw and on known-good scripts
before it is enforced on every script the agent writes. On its first run, Muse Wonder's three
rules caught 174 of 174 broken variants (58 of 58 held out) with zero false alarms, for twelve
cents. Pointed at our own engine, the same oracles found two interpreter bugs that had been
silently killing shipped indicators.

## Why this fits "Push the Frontier · verifiable agents"

Meta's Agents 102 session was about verifiable agents. OakGuard is one, end to end:

| Principle | In OakGuard |
|---|---|
| The agent cannot grade itself | The proposer only writes specs. The referee, its corpus and its held-out variants live outside the model's reach; a fingerprint pins the corpus. |
| Evidence before trust | A rule is promoted only if it catches every variant, held-out ones included, with zero false alarms. Rejections are archived with counterexamples. |
| Constrained action space | Structured output limits the model to three rule families and their parameters. A malformed spec is rejected before testing. |
| Generalisation is measured, not assumed | A third of the variants are held out and reported to the model as a count only. |
| Everything is recorded | Model, prompt hash, tokens, latency and cost for every call; replays re-grade the text and never replay verdicts. |
| Dependencies re-certify | When the playbook changes, advice rules that depend on a re-checked tool return to probation and are re-graded. |

## Meta models used

| Model | Role |
|---|---|
| Muse Wonder (`muse-wonder-1.0`) | Proposes and revises OakGuard rules (structured output, medium reasoning effort) |
| Muse Spark 1.3 | OakScript coder (editor agent) and trade advisor |
| Muse Spark 1.3 with image input | 👁 Look: checks the rendered chart against the request |
| Muse Voice Transcribe | 🎤 push-to-talk requests in the editor, keyword-biased to trading terms |

## Demo video script (3:00)

Record at 1920×1080. Before recording: start the backend and the app, open
`http://127.0.0.1:5173/?oakguard=1`, press **Reset playbook**, close the Trading and News windows.
Rehearse the live run once (about 45 seconds of model time; cut the waits in the edit and label
them "sped up").

| Time | Screen | Voice-over |
|---|---|---|
| 0:00–0:15 | The impossible-breakout escape in the editor: valid, applied, no markers on a trending chart. | "I asked an AI for a 20-bar breakout. It compiled. It validated. In a strong uptrend it never fires once, because the 20-bar high includes the bar that is breaking out." |
| 0:15–0:25 | Title card: *DAFE Charts existed before the event. Everything marked NEW was built Oct 26 – Nov 4.* | "DAFE Charts is my trading terminal. Everything in this video was built during the hackathon." |
| 0:25–0:45 | Crucible, step 1: the three escapes and their runtime evidence. | "OakGuard runs the code. These three scripts all pass the validator, and running them proves each one broken." |
| 0:45–1:25 | Press **▶ Run live · Muse Wonder**. The proposal feed fills; zoom on one rule's JSON, then on "variants 92/92 · held-out 31/31 · false alarms 0/46". The core gains a ring per rule. | "Muse Wonder writes a rule for each one: a declarative spec, not code. A referee it can't see tests it against broken variants, a third held back from the model, and 46 scripts that must not be flagged. Only rules that pass every gate join the playbook." |
| 1:25–1:45 | Show details → the referee self-test numbers (or run `npm run verify:proposer` in a terminal and scroll the rejections). | "The referee has teeth: a rule that's too broad flags the legitimate new-high test and is rejected with that line as the counterexample. Nine flawed rules, nine rejections." |
| 1:45–2:15 | Editor: paste the breakout escape (docs/demo/breakout-escape.oak) → **✓** validate: it is rejected with Wonder's rule `SELF_INCLUSIVE_WINDOW_BREAKOUT` → **🔧 Fix** → Muse Spark diagnoses it and repairs both lines; the preview shows breakout markers for the first time → **✓ Accept & Apply**. Then **🎤** "Add an RSI filter above 50 and show the channel in 3D" → Muse Spark edits it → **👁 Look**: Muse Spark lists what it sees. | "That breakout from the start? The rule Wonder wrote now stops it before it reaches my chart, and the fix is one click. And I can just say what I want: Muse Voice Transcribe hears it, Muse Spark writes it, and Muse Spark looks at the chart, and when it doesn't match, it tells me exactly what's missing." |
| 2:15–2:40 | Split: terminal with `verify:proposer` all PASS · the two engine fixes in the report · the learning-curve table. | "Pointed at our own engine, the oracles found two interpreter bugs that had been silently killing shipped indicators. On 32 fresh Muse Spark drafts, the learned rules raised zero false alarms. All of it reproduces headlessly, without an API key." |
| 2:40–3:00 | Crucible, the cost chip ($0.100) and the playbook core; end card with the repo URL and the four Meta models. | "Ten cents of Muse Wonder on this run, and every AI-written script is checked by rules that were proven before they were trusted. It certifies the code, not the returns. OakGuard." |

Presenter rules: never show an equity curve or a P&L figure as a result; say "rule", not "the
model fixed itself"; keep the NEW badges in frame when showing a feature.

**60-second cut:** escape (0:00–0:10) → live run with the feed and held-out numbers (0:10–0:35) →
voice → caught → Look (0:35–0:50) → engine bugs found and the cost (0:50–1:00).

## Judge FAQ

- **Is the model retraining itself?** No. The model is fixed. What changes is the playbook of
  rules it writes, and only through the referee.
- **Can the model game its tests?** It writes data, not code; it never sees the corpus, the
  held-out variants or the referee's code; the corpus fingerprint is pinned; malformed specs are
  rejected before testing.
- **Why did every rule pass on the first try?** Muse Wonder was right this time. The referee's
  value is that it would have said no: `verify:proposer` feeds it nine flawed rules (too narrow,
  too broad, wrong family, malformed) and it rejects all nine. An earlier Muse Spark proposal that
  flagged `>=` was exactly the too-broad case; the contrast scripts were added so the referee
  catches it.
- **Does it work on real model output?** On 32 fresh Muse Spark first drafts, 22 pass the
  validator and the learned rules raise no false alarm on them. The silent defects we found were
  in our own engine, and they are fixed.
- **What did you build versus what existed?** See `HACKATHON_CONTRIBUTIONS.md`; the baseline is
  tagged and was pushed to GitHub on Sep 3.
- **Does it run without a GPU or a key?** The judge build runs in a browser with no backend and
  replays the recorded run; the headless suites need no key. Live mode needs a Meta Model API key.
- **Is this financial advice?** No. The backtest certificate certifies the test procedure, not
  the returns.

## What is next

- More rule families, so more of what the oracles find can be learned (derived-series windows,
  unused inputs, unit mismatches between price and oscillators).
- Mine escapes continuously from every generation in the app, not only from a recorded sample.
- Run the proposer on Muse Glimmer for fully offline rule learning.
- Production: a shared, signed playbook so one user's proven rule protects every user.
