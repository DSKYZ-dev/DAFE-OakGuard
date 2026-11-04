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

## Post for X (Most Viral bonus, post Nov 4 with the 30–45 s clip)

> AI wrote me a breakout indicator. It compiled, it validated, and it could never fire.
>
> So I built OakGuard: @AIatMeta's Muse Wonder writes the rule that catches the bug, and a referee it can't see decides if the rule is good enough to go live.
>
> 174/174 broken variants caught · 0 false alarms · $0.10–$0.12 per run
> It even found two bugs in my own engine.
>
> [video] · [repo] #MetaHackathon
