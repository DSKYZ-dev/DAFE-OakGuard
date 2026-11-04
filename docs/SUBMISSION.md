# Submission copy (paste into the Cerebral Valley form)

Replace the bracketed items before submitting.

**Project name:** DAFE OakGuard

**Track:** Startup · **Theme:** Push the Frontier

**Tagline (one line):** Muse Wonder writes the rules that catch bugs in AI-written trading code; a referee it cannot see decides which ones go live.

**Repository:** https://github.com/DSKYZ-dev/DAFE-OakGuard
**Demo video:** [YouTube link, public or unlisted]
**Live demo (no install):** https://dskyz-dev.github.io/DAFE-OakGuard/?oakguard=1&backend=none
**Team:** [name, email, role, for every member]

## Description

AI coders write trading indicators that compile, pass the validator, and are quietly wrong: a
breakout compared with a 20-bar high that includes the current bar can never fire; a moving
average with a zero length computes nothing. Checkers only catch the bugs someone thought of.

OakGuard runs the code and proves when it is broken, using runtime oracles on four synthetic
markets. It then asks Muse Wonder for a rule that would have caught the bug before it ran. The
rule is data, not code: schema-constrained JSON in a fixed rule language. An independent referee
that the model cannot see scores it against broken variants of the same bug (a third held out
from the model) and 46 known-good scripts, including contrast scripts that sit right next to
each bug class. Rejected rules go back to the model with the reason and a counterexample; promoted
rules are enforced in the validator for every script the agent writes from then on.

Results on the live run: Muse Wonder's three rules caught 174 of 174 broken variants, 58 of
58 held out, with zero false alarms, for $0.10–$0.12 a run (live run $0.1005; the recorded run shipped
for replay in the judge build is labelled "(recorded)" and cost $0.115 for the same three rules). The referee rejects all nine deliberately flawed
rules in its self-test. Pointed at our own engine, the oracles found two interpreter bugs that had
been silently killing shipped indicators (a crossover() cache collision and NaN-poisoned
sma/ema), now fixed. On 32 fresh Muse Spark drafts, the learned rules raised no false alarms.

Muse Spark 1.3 is the editor's coder and the trade advisor, and also checks the rendered chart
from an image ("Look"). Muse Voice Transcribe turns a spoken request into text for the agent. If it hears nothing, the chat says so and you can speak again. Every claim
reproduces headlessly without an API key (`npm run verify:proposer`), and the judge build runs in
a browser with no backend.

## How we used Meta's models

- **Muse Wonder (`muse-wonder-1.0`)**: the rule proposer. Structured output constrains it to a
  three-family rule language; it revises on the referee's counterexamples. Every call is recorded
  with prompt hash, tokens and cost.
- **Muse Spark 1.3**: the OakScript coder (agent loop: draft, validate, gate, repair) and the
  trade advisor. 110 of 110 prompts passed live acceptance over 10 consecutive runs; a re-run after
  the engine fixes passed 11 of 11.
- **Muse Spark 1.3 image understanding**: reads a capture of the rendered 2D/3D chart and lists
  what the request asked for that it can and cannot see, and says what is missing when a capture does not match.
- **Muse Voice Transcribe**: push-to-talk requests in the editor, keyword-biased to trading terms. A take that hears nothing is reported in the chat, not hidden.

## What was built during the hackathon

DAFE Charts, the terminal underneath, existed before the event. Its baseline is tagged
`pre-hackathon-baseline` in the repository, pointing at the 2026-09-03 commit. Built during the
event: OakGuard (proposer, referee, oracles, rule language, contrast corpus, Crucible, report),
the Meta Model API integration (structured output, vision, transcription, cost reporting), the
learning-curve harness, the backtest honesty certificate, the generation gates, the engine fixes,
judge mode and CI. The full list with file paths is in `HACKATHON_CONTRIBUTIONS.md`; features
built during the event carry a NEW badge in the app.

## Submission form answers (paste-ready)

### Project Description (limit 3,000)

<!-- DESC -->
AI writes trading indicators for millions of people, and the code compiles, passes the validator, and is quietly wrong. A 20-bar breakout whose window includes the current bar can never fire. A moving average with a zero length computes nothing. A misspelled builtin silently returns zero. The chart looks fine. Existing checkers only catch bug classes somebody already thought of.

OakGuard is a verifiable agent layer for AI-written trading code. It runs each script against runtime oracles on four synthetic markets and proves when it is broken: a marker that fired zero times on 2,400 bars, a series with no finite value on 600 bars. It then asks Muse Wonder for a rule that would have caught that bug before it ran. The rule is data, never code: schema-constrained JSON in a three-family rule language that cannot touch the chart, the engine, or an order.

A referee the model cannot see then decides. It grades the rule against broken variants of the same bug, a third of them held out from the model, plus 46 known-good scripts, including contrast scripts that sit right next to each bug class. A rejected rule goes back to the model with the reason and a counterexample. Only rules that pass every gate are promoted and enforced in the editor for every script the agent writes from then on.

On the first live run, three rules caught 174 of 174 broken variants, 58 of 58 held out, with zero false alarms on the known-good corpus, for $0.10 to $0.12 of model usage. The referee rejected all nine deliberately flawed rules in its self-test. Pointed at our own engine, the same oracles found two interpreter bugs that had been silently killing shipped indicators.

Built on DAFE Charts, my trading terminal, in ten days (Oct 26 to Nov 4, 2026). Every claim reproduces headlessly without an API key, and the judge build runs in a browser with no backend. It certifies the code, not the returns.
<!-- /DESC -->

### Public GitHub Repository

```
https://github.com/DSKYZ-dev/DAFE-OakGuard
```

### 3-Minute Demo Video

```
https://youtube.com/watch?v=PASTE_AFTER_UPLOAD
```

Upload `OakGuard-submission-v5.mp4` (3:00.000, 1920x1080) with `OakGuard-thumbnail-3min.jpg`; the
title, description, tags and chapters are in `docs/YOUTUBE.md`.

### Describe your use of Meta products (limit 3,000)

<!-- METAUSE -->
I used three Meta models, each doing a job the product would not work without.

Muse Wonder 1.0 (muse-wonder-1.0) is the rule proposer. It receives the broken script, the oracle evidence, the three-family rule schema and, on later rounds, the referee's counterexamples, and returns a rule proposal as schema-constrained JSON: family, issue code, parameters. It runs with structured output so the response is machine-usable without parsing heuristics, and with medium reasoning effort. A run makes three calls (one per escape) and produces three rules. Every call is recorded with model id, prompt hash, input and output tokens, latency and cost.

Muse Spark 1.3 is the OakScript coder inside the editor agent. The loop is draft, validate, gate, repair: Spark writes the indicator, the validator checks syntax and the newly learned OakGuard rules, and the agent repairs on a failed gate. It is also the trade advisor. Over ten consecutive live acceptance runs, 110 of 110 prompts passed; a re-run after the engine fixes passed 11 of 11. On 32 fresh drafts, the learned rules raised zero false alarms.

Muse Spark 1.3 with image input powers Look: the app captures the rendered 2D/3D chart, sends it to the model, and gets back what the request asked for that it can and cannot see. When a capture does not match the request, Look says exactly what is missing instead of implying a pass.

Muse Voice Transcribe powers push-to-talk in the editor, transcribing speech with keyword bias toward trading terms so "RSI", "lookback" and "channel" survive. A take that hears nothing is reported in the chat; it is never hidden.

Integration: a small FastAPI backend proxies the model calls, keeps the model ids in one place, and reports tokens and cost to the UI. The judge build ships a recorded run, clearly labelled "(recorded)", so every screen works offline with no API key; replay re-grades the recorded text and never replays a stored verdict. The voice take in the video is real, and the only edit is trimming.
<!-- /METAUSE -->

### Why are Meta's models important to your solution? (limit 3,000)

<!-- WHY -->
The product is a verifier, so the model had to be a proposer that cannot grade itself. Meta's structured output is what makes that safe. The rule language has three families and a fixed parameter set; schema-constrained JSON means the model can only describe a bug, never write code, and a malformed spec is rejected before it reaches the referee. That constrained action space is the reason a model can be allowed anywhere near a trading engine.

The models also had to be good enough that a first proposal generalizes. Muse Wonder's three rules caught 174 of 174 broken variants, including 58 held out from it, in the first round, with zero false alarms on 46 known-good scripts. That result is the whole claim of the project: the model is not graded on plausibility, it is graded on unseen variants.

Cost and speed make the loop usable. Three calls finish in under a minute of model time for $0.10 to $0.12, so OakGuard can verify every escape it finds instead of sampling. Because every call records tokens, latency and cost, the run can be replayed and re-graded exactly, which is what makes the demo reproducible and the judge build offline.

Muse Spark's image understanding closes the loop between what a user asked for and what was actually drawn. A text-only model cannot check a rendered chart; Look can, and it reports misses honestly. Muse Voice Transcribe removes the keyboard from the loop entirely, which matters when the user is looking at a chart rather than at a text box.

Remove any one of the three and the product changes shape: without Wonder there is no rule author, without Spark there is no coder or chart check, without Voice there is no hands-free request. The referee, the corpus and the held-out variants stay outside the model, which is the point: verifiable agents need a proposer that is powerful, constrained, and cheap enough to check everything.
<!-- /WHY -->

### Feedback on partner technologies (limit 150)

<!-- PARTNER -->
Muse held structured JSON across ~40 calls; recorded tokens, latency and cost made exact replay possible. No Fireworks, Modal or Baseten used.
<!-- /PARTNER -->

## Post for X (Most Viral bonus, post Nov 4 with the 30–45 s clip)

> AI wrote me a breakout indicator. It compiled, it validated, and it could never fire.
>
> So I built OakGuard: @AIatMeta's Muse Wonder writes the rule that catches the bug, and a referee it can't see decides if the rule is good enough to go live.
>
> 174/174 broken variants caught · 0 false alarms · $0.10–$0.12 per run
> It even found two bugs in my own engine.
>
> [video] · [repo] #MetaHackathon
