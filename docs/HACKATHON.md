# Hackathon brief

> **Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026) · Track: Startup · Theme: Push the Frontier (verifiable agents)**
> Submission due **Wed Nov 4, 9:00 PM ET** (8:00 PM Central).
> **Repo:** https://github.com/DSKYZ-dev/DAFE-OakGuard ·
> **Judge build:** https://dskyz-dev.github.io/DAFE-OakGuard/?oakguard=1&backend=none

## One line

**Muse Wonder writes the rules that catch bugs in AI-written trading code; a referee it cannot see decides which ones go live.**

## The 30-second pitch

AI coders now write trading indicators for millions of people, and the code compiles, validates
and is quietly wrong: a breakout that can never fire, a moving average that computes nothing.
Checkers only catch the bugs someone thought of. OakGuard runs the code, proves when it is broken,
and asks Muse Wonder for a rule that would have caught it. The rule is data, not code, and an
independent referee scores it on broken variants the model never saw and on known-good scripts
before it is enforced on every script the agent writes. On its first run, Muse Wonder's three
rules caught 174 of 174 broken variants (58 of 58 held out) with zero false alarms, for ten
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

Record at 1920×1080. The cut list below is built from the stills in `video/assets/`; every line
of the voice-over lands on a frame that exists. Before recording: start the backend and the app,
open `http://127.0.0.1:5173/?oakguard=1`, press **Reset playbook**, close the Trading and News
windows. Rehearse the live run once (about 45 seconds of model time; cut the waits in the edit and
label them "sped up").

Music: `Dark Pulse - 45s Cut` runs 0:00–0:45 (opener, cold open, title, escapes); crossfade about
one second into `Quiet Cost - Full Underscore` at 0:45 and run it to 3:00. The bed sits about ten
decibels under the voice and lifts in the 0:00–0:12 gap where there is no narration; it dips under
the cost line at 2:44 and fades out over the last second of the end card.

Picture: every beat is joined by a half-second dissolve rather than a hard cut, and the longer stills
push in slowly (about 1.2 percent a second) so nothing sits dead on screen. The build script is
`recapture/build-v2-xfade.ps1`; the reference file is `OakGuard-submission-v2.mp4`.

Voice-over: the twelve takes are trimmed, level-matched and assembled on `VO Timeline (fixed).wav`
at the timecodes in `timeline.csv`. The opener runs 0:00–0:10 and the first word lands at 0:12 —
two clear seconds after the opener — then each picture cut lands about half a second before its
line, so the frame is always established when the sentence begins.

| Time | Screen (asset) | Voice-over |
|---|---|---|
| 0:00–0:10 | Branded opener (`Obsidian Lux`) — music only, no voice-over | — |
| 0:10.0–0:15.8 | `IMG-01-empty-breakout.png` — rising chart, channel lines, zero markers, editor hidden | "It compiled. It validated. And it can never fire." |
| 0:15.8–0:28.1 | `IMG-14-title-card.png` over `IMG-02-crucible-start.png` (`PLAYBOOK v1 · 0 ACTIVE RULES`, dark sphere) | "I asked an AI for a twenty-bar breakout. This is OakGuard, built on DAFE Charts — my trading terminal — in ten days, October twenty-sixth to November fourth. Everything marked NEW was built inside that window." |
| 0:28.1–0:49.2 | `IMG-03a-dead-length.png` · `IMG-03b-silent-call.png` · `IMG-03c-breakout.png` — cut a→b at ~0:37.9 and b→c at ~0:41.0, on the sentence starts | "OakGuard starts with three scripts. The validator accepts all three. All three are broken. A zero length that never produces a finite number. A misspelled call that silently returns zero. And a breakout that fired zero times on twenty-four hundred bars. The chart looks fine — nobody notices until the signal is trusted." |
| 0:49.2–1:10.5 | `IMG-04-wonder-json.png` — one Muse Wonder rule, its JSON | "So I ran the code, and the runtime oracles proved each one broken. Then Muse Wonder wrote a rule that would have caught it. One rule — declarative JSON in a fixed rule language. Data, never code. It cannot touch the chart. It cannot touch the engine. It can only describe the bug." |
| 1:10.5–1:34.2 | `IMG-05-gate-scores.png` — hold 3–4 s on **Variants 92/92 · held-out 31/31 · false alarms 0/46** | "And then a referee it cannot see decides. Ninety-two of ninety-two broken variants caught. Thirty-one of thirty-one held out — a third the model never saw. Zero false alarms on forty-six known-good scripts. Across all three rules: a hundred and seventy-four of a hundred and seventy-four. Fifty-eight of fifty-eight. Zero false alarms." |
| 1:34.2–1:53.2 | `IMG-06-playbook-rings.png` → `IMG-07-referee-block.png` → `proposer.mp4` (last 3.9 s of the recording, cropped to sections 2–5 so the recorded-cost line never appears; ends on **ALL PROPOSER, REFEREE AND ORACLE CHECKS PASS**) | "The referee has teeth. Give it a rule that is too broad and it flags the legitimate new-high test — and rejects it, with that line as the counterexample. Nine deliberately flawed rules. Nine rejections. Every proposer, referee and oracle check passes, headlessly, without an API key." |
| 1:53.2–2:04.2 | `IMG-09-editor-rejection.png` — paste the breakout → `SELF_INCLUSIVE_WINDOW_BREAKOUT` | "Now watch it touch my own code. I paste the breakout in — and the validator, armed with Wonder's rule, stops it dead: self-inclusive breakout window." |
| 2:04.2–2:13.7 | `IMG-10-fixed-markers.png` — 🔧 Fix → breakout markers firing | "One click of Fix. Muse Spark diagnoses it, repairs both lines — and for the first time, the breakout markers actually fire." |
| 2:13.7–2:29.1 | `IMG-11-voice-request.png` → `IMG-12-look-result.png` | "I do not even have to type it. Add an RSI filter above fifty, show the channel in three D. Muse Voice transcribes it, Muse Spark writes it — and when it does not match, Look tells me exactly what is missing." |
| 2:29.1–2:43.8 | `IMG-08-referee-9of9.png` / `OakGuard-report-2026-11-03_1125.html` — the two engine fixes and the learning curve | "Then I pointed the oracles at my own engine — and they found two interpreter bugs that had been silently killing shipped indicators. On thirty-two fresh Muse Spark drafts, the learned rules raised zero false alarms." |
| 2:43.8–2:50.0 | `IMG-06-playbook-rings.png` again → `IMG-13-cost-chip.png` | "And the whole thing — every rule, every call, every token — cost ten cents." |
| 2:50.0–2:54.6 | `IMG-15-end-card.png` — repo URL, judge URL, the three Meta models (`muse-wonder-1.0`, `muse-spark-1.3`, `muse-voice-transcribe-1.0`) | "Muse Wonder writes the rules. A referee it cannot see decides. It certifies the code, not the returns. OakGuard." |
| 2:54.6–3:00 | `IMG-17-brand-card.png` — DskyzInvestments end card ("Same math. New view.") held under the close | — |

Look is shown honestly. The capture reads **✕ does not match yet** and lists what is missing
(`Upper, Lower, RSI filter above 50`); the voice-over says so. Do not cut it to imply a pass.

Presenter rules: never show an equity curve or a P&L figure as a result; say "rule", not "the
model fixed itself"; keep the NEW badges in frame when showing a feature.

**60-second cut:** escape (0:00–0:08) → Muse Wonder writes it, held-out numbers (0:08–0:25) →
referee 9/9 (0:25–0:35) → voice + Look (0:35–0:45) → engine bugs and ten cents (0:45–1:00).

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
  tagged; the tag `pre-hackathon-baseline` points at the Sep 3 commit.
- **Does it run without a GPU or a key?** The judge build runs in a browser with no backend and
  replays the recorded run; the headless suites need no key. Live mode needs a Meta Model API key.
- **Is this financial advice?** No. The backtest certificate certifies the test procedure, not
  the returns.

## What is next

- More rule families, so more of what the oracles find can be learned (derived-series windows,
  unused inputs, unit mismatches between price and oscillators).
- Mine escapes continuously from every generation in the app, not only from a recorded sample.
- Run the proposer on a smaller Muse Spark variant for cheaper, faster rule learning.
- Production: a shared, signed playbook so one user's proven rule protects every user.
