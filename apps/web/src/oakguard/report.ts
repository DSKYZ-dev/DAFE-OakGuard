/**
 * OakGuard report — one self-contained HTML document built from a single run.
 *
 * Every dynamic value passes through escapeHtml, so rule names, script names
 * and log lines can never inject markup into the report.
 */
import { getRuleById } from './store';
import { DEMO_TOOL, type CandidateStatus, type OakGuardRun } from './pipeline';
import { escapeHtml } from '../escape-html';

export { escapeHtml };

const STATUS_PILL: Record<CandidateStatus, { label: string; tone: 'ok' | 'warn' }> = {
  active: { label: 'Active', tone: 'ok' },
  promoted: { label: 'Promoted', tone: 'ok' },
  rejected: { label: 'Archived', tone: 'warn' },
  archived: { label: 'Archived earlier', tone: 'warn' },
};

const pct = (v: number): string => `${Math.round(v * 100)}%`;

const CSS = `
* { box-sizing: border-box; }
body { margin: 0; background: #eef1f6; color: #141829; font: 14px/1.55 'Segoe UI', Inter, system-ui, sans-serif; }
.page { max-width: 900px; margin: 32px auto; background: #fff; border-radius: 14px; overflow: hidden; box-shadow: 0 10px 40px rgba(20,24,41,.12); }
.masthead { background: #0b0c1d; color: #e8e2ff; padding: 28px 36px; }
.brand { color: #2dffb3; font-weight: 700; letter-spacing: .14em; font-size: 12px; text-transform: uppercase; }
.masthead h1 { margin: 6px 0 6px; font-size: 26px; font-weight: 700; }
.meta { color: #a9a3cf; font-size: 12px; margin: 0; }
.body { padding: 24px 36px 32px; }
h2 { font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: #5a4aa0; margin: 28px 0 10px; border-bottom: 1px solid #e3e6ef; padding-bottom: 6px; }
.lede { font-size: 15px; margin: 0 0 6px; }
ul.summary { padding-left: 18px; margin: 8px 0 0; }
ul.summary li { margin: 5px 0; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #eceef5; vertical-align: top; }
th { color: #5b607a; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
td.num { white-space: nowrap; font-variant-numeric: tabular-nums; }
.pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; }
.ok { background: #e3f8ef; color: #0c7a51; }
.warn { background: #fff4df; color: #8a5a00; }
.muted { color: #6b7088; }
code { font: 12px ui-monospace, Consolas, monospace; background: #f1f2f8; padding: 1px 5px; border-radius: 4px; }
pre { background: #0b0c1d; color: #d9d4ff; border-radius: 10px; padding: 14px 16px; font: 12px/1.5 ui-monospace, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0 0; }
ol.limits li, ul.limits li { margin: 6px 0; }
footer { padding: 16px 36px; border-top: 1px solid #e3e6ef; color: #6b7088; font-size: 12px; }
@media print {
  body { background: #fff; }
  .page { box-shadow: none; margin: 0; max-width: none; border-radius: 0; }
  .masthead, .pill { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  h2 { break-after: avoid; }
}
`;

export function buildOakGuardReport(run: OakGuardRun, generatedAt: Date): string {
  const e = escapeHtml;
  const cands = run.candidates;
  const promoted = cands.filter(c => c.outcome === 'promoted').length;
  const archived = cands.filter(c => c.outcome === 'rejected' || c.outcome === 'archived').length;
  const totals = cands.reduce(
    (t, c) => ({
      variants: t.variants + c.report.mutantTotal,
      caught: t.caught + c.report.mutantCaught,
      held: t.held + c.report.heldOutTotal,
      heldCaught: t.heldCaught + c.report.heldOutCaught,
    }),
    { variants: 0, caught: 0, held: 0, heldCaught: 0 },
  );
  const playbookFalseAlarms = cands
    .filter(c => c.outcome === 'promoted' || c.outcome === 'active')
    .reduce((n, c) => n + c.report.falsePositiveCount, 0);
  const blockedFalseAlarms = cands
    .filter(c => c.outcome === 'rejected' || c.outcome === 'archived')
    .reduce((n, c) => n + c.report.falsePositiveCount, 0);
  const corpus = run.manifest.corpusCount;
  const flagged = run.library.flagged.length;
  const certified = run.assistant.certified;
  const assistantTotal = run.assistant.grades.length;
  const invalidated = run.assistant.invalidated.length;
  const p = run.proposer;
  const caughtAfter = run.escapes.filter(x => x.caughtAfter.length > 0).length;
  const proposerLabel = p.mode === 'live' ? `${p.model}, called live`
    : p.mode === 'replay' ? `${p.model}, recorded ${p.recordedAt ?? ''} and re-graded now`
      : 'the hand-written catalogue (no model)';

  const summary = [
    `${run.escapes.length} escape(s): scripts the baseline validator accepted that the runtime oracles proved broken.`,
    `Candidate rules came from ${proposerLabel}: ${p.calls} call(s), ${p.inputTokens + p.outputTokens} tokens, $${p.costUsd.toFixed(4)}.`,
    `${promoted} rule(s) promoted into the playbook and ${archived} archived with counterexamples.`,
    `Candidate rules caught ${totals.caught} of ${totals.variants} broken variants (held-out: ${totals.heldCaught} of ${totals.held}).`,
    `Rules in the playbook raise ${playbookFalseAlarms} false alarms across ${corpus} known-good scripts.`,
    ...(blockedFalseAlarms ? [`The gate blocked ${blockedFalseAlarms} false alarms from archived candidates.`] : []),
    `After the run, ${caughtAfter} of ${run.escapes.length} escape(s) are flagged before they run.`,
    ...(run.curve ? [`Unseen ${run.curve.draftModel} drafts: ${run.curve.validatorClean} of ${run.curve.drafts} pass the validator, ${run.curve.escapes} carry a runtime defect, and the playbook raises ${run.curve.falseFlagsNow} false alarm(s) on them.`] : []),
    `Dependent advice: ${certified} of ${assistantTotal} rules certified${invalidated ? `, after ${invalidated} returned to probation when the playbook changed` : ''}.`,
    `Script library: ${run.library.scanned} scripts scanned, ${flagged} flagged.`,
  ];

  const stepRows = run.steps.map((s, i) => `
    <tr><td class="num">${i + 1}</td><td><strong>${e(s.title)}</strong></td>
    <td><span class="pill ${s.status === 'done' ? 'ok' : 'warn'}">${s.status === 'done' ? 'Done' : e(s.status)}</span></td>
    <td class="muted">${e(s.summary)}</td></tr>`).join('');

  const candidateRows = cands.map(c => {
    const pill = STATUS_PILL[c.outcome];
    const meta = c.rule.proposal;
    const by = meta ? `${meta.model}, round ${meta.round}${meta.costUsd ? `, $${meta.costUsd.toFixed(4)}` : ''}` : c.rule.proposedBy;
    return `
    <tr><td><strong>${e(c.rule.name)}</strong><div class="muted">${e(c.rule.description)}</div><div class="muted">Proposed by ${e(by)} for ${e(c.escapeId ?? '—')}</div></td>
    <td><code>${e(c.rule.issueCode)}</code><div class="muted">${e(c.rule.family)}</div></td>
    <td class="num">${c.report.mutantCaught} / ${c.report.mutantTotal}</td>
    <td class="num">${c.report.heldOutCaught} / ${c.report.heldOutTotal}</td>
    <td class="num">${c.report.falsePositiveCount} / ${c.report.goodTotal}</td>
    <td><span class="pill ${pill.tone}">${e(pill.label)}</span></td>
    <td class="muted">${e(c.report.reasons[0] ?? '')}</td></tr>`;
  }).join('');

  const playbookRows = run.playbook.activeRuleIds.map(id => {
    const rule = getRuleById(id, run.playbook);
    const promo = run.playbook.promotions.find(pr => pr.ruleId === id);
    return `
    <tr><td><strong>${e(rule?.name ?? id)}</strong><div class="muted">${e(rule?.fixHint ?? '')}</div></td>
    <td><code>${e(rule?.issueCode ?? '')}</code></td>
    <td class="muted">${e(promo?.modelId ?? '')}</td>
    <td class="num">v${promo?.playbookVersion ?? '—'}</td>
    <td class="muted">${promo ? e(new Date(promo.promotedAt).toLocaleString()) : '—'}</td></tr>`;
  }).join('');

  const escapeBlocks = run.escapes.map(x => `
    <h3 style="font-size:14px;margin:16px 0 4px">${e(x.escape.title)} <span class="muted">· ${e(x.escape.origin === 'model-draft' ? `${x.escape.model ?? 'model'} draft` : 'seed')}</span></h3>
    <table><tbody>
      <tr><td>Baseline validator</td><td>${x.validatorValid ? '<span class="pill ok">Accepts</span>' : '<span class="pill warn">Rejects</span>'}</td></tr>
      <tr><td>Runtime evidence</td><td>${e(x.evidence)}</td></tr>
      <tr><td>After the run</td><td>${x.caughtAfter.length ? `Flagged before running by ${x.caughtAfter.map(c => `<code>${e(c)}</code>`).join(' ')}` : '<span class="muted">Not caught</span>'}</td></tr>
    </tbody></table>
    <pre>${e(x.escape.source)}</pre>`).join('');

  const curve = run.curve;

  const archiveItems = run.playbook.emeritus.map(rec => `
    <li><strong>${e(rec.name)}</strong> — ${e(rec.reasons.join(' '))}${rec.counterexample ? `<div class="muted">Counterexample: ${e(rec.counterexample)}</div>` : ''}</li>`).join('');

  const flaggedRows = run.library.flagged.map(f => `
    <tr><td>${e(f.name)}</td><td><code>${e(f.code)}</code></td><td class="muted">${e(f.message.slice(0, 160))}</td></tr>`).join('');

  const assistantRows = run.assistant.grades.map(({ rule, grade }) => `
    <tr><td><strong>${e(rule.name)}</strong><div class="muted">${e(rule.description)}</div></td>
    <td class="muted">${e(rule.dependsOn.join(', '))}</td>
    <td class="num">${grade.compliant} / ${grade.scenarios}</td>
    <td><span class="pill ${grade.verdict === 'promoted' ? 'ok' : 'warn'}">${grade.verdict === 'promoted' ? 'Certified' : 'Probation'}</span></td></tr>`).join('');

  const scenarioRows = run.assistant.scenarios.map(s => `
    <tr><td>${e(s.label)}</td><td>${e(s.classified)}</td><td class="num">${s.atrRatio.toFixed(2)}×</td></tr>`).join('');

  const limits = [
    'Candidates are declarative rule specs in a fixed rule language of three families. The model chooses a family and its parameters; it never writes executable code, and a malformed spec is rejected before testing.',
    'A replayed run re-grades the model\'s recorded text with the current referee. Verdicts are never replayed.',
    `The known-good corpus is the scripts shipped with the app plus contrast scripts that sit next to each bug class (${corpus} in total). "No false alarms" means none on this corpus, not a guarantee for every script a user could write.`,
    'Broken variants are generated by deterministic mutation of known-good scripts and split into visible and held-out sets. Held-out variants are never shown to the proposer; it sees only counts.',
    'Runtime oracles run each script on four synthetic markets (2,400 bars). They prove that output is dead or a signal never fires there. They are not a backtest and say nothing about profitability.',
    'Dependent advice rules are graded on process compliance and correct abstention over synthetic point-in-time regime scenarios, never on profit.',
    'The playbook and archive are stored in this browser. They are not a server authority.',
    'Reproduce the checks with npm run verify:oakguard and npm run verify:proposer (headless, no API key).',
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OakGuard verification report</title>
<style>${CSS}</style>
</head>
<body>
<main class="page">
  <header class="masthead">
    <div class="brand">⬢ OakGuard · DAFE Charts</div>
    <h1>Verification report</h1>
    <p class="meta">Generated ${e(generatedAt.toLocaleString())} · Corpus ${corpus} known-good scripts · Fingerprint ${e(run.manifest.manifestHash)} · Playbook v${run.playbookVersionBefore} → v${run.playbook.version} · Run time ${run.durationMs} ms</p>
  </header>
  <div class="body">
    <h2>Summary</h2>
    <p class="lede">OakGuard turns runtime evidence into permanent checks. A Meta model writes a declarative rule for each bug the validator missed; an independent referee keeps only rules that catch every broken variant, held-out ones included, without a false alarm. Kept rules are enforced in the editor.</p>
    <ul class="summary">${summary.map(line => `<li>${e(line)}</li>`).join('')}</ul>

    <h2>How the run went</h2>
    <table>
      <thead><tr><th>#</th><th>Step</th><th>Status</th><th>Result</th></tr></thead>
      <tbody>${stepRows}</tbody>
    </table>

    <h2>1 · The escapes</h2>
    <p class="muted">Each script below passes the baseline validator, and running it proves it broken.</p>
    ${escapeBlocks || '<p class="muted">No escapes in this run.</p>'}

    <h2>2 · Candidate rules and their scores</h2>
    <table>
      <thead><tr><th>Rule</th><th>Targets</th><th>Broken variants</th><th>Held-out</th><th>False alarms</th><th>Outcome</th><th>Why</th></tr></thead>
      <tbody>${candidateRows || '<tr><td colspan="7" class="muted">No candidates were scored.</td></tr>'}</tbody>
    </table>

    <h2>3 · The playbook</h2>
    ${playbookRows
      ? `<table><thead><tr><th>Rule</th><th>Enforces</th><th>Written by</th><th>Added in</th><th>Promoted</th></tr></thead><tbody>${playbookRows}</tbody></table>`
      : '<p class="muted">No rules are active yet. Run OakGuard to promote proven rules.</p>'}
    <p class="muted">Promoted rules now run inside the editor validator and the agent auto-fix loop for every script.</p>

    <h2>4 · Emeritus archive</h2>
    ${archiveItems ? `<ul class="limits">${archiveItems}</ul>` : '<p class="muted">Nothing archived. Rejected rules are kept here with their counterexamples.</p>'}

    <h2>5 · Unseen model drafts</h2>
    ${curve ? `<table><tbody>
      <tr><td>Drafts</td><td>${curve.drafts} held-out first drafts from <code>${e(curve.draftModel)}</code>, recorded ${e(curve.recordedAt)}</td></tr>
      <tr><td>Accepted by the baseline validator</td><td>${curve.validatorClean}</td></tr>
      <tr><td>Runtime defects among them</td><td>${curve.escapes} (flagged before running: v1 ${curve.caughtV1}, now ${curve.caughtNow})</td></tr>
      <tr><td>False alarms on clean drafts</td><td>${curve.falseFlagsNow}</td></tr>
      <tr><td>First-draft validity (all drafts)</td><td>${curve.firstDraftValidity.validatorClean} of ${curve.firstDraftValidity.drafts}. ${e(curve.firstDraftValidity.note)}</td></tr>
    </tbody></table>` : '<p class="muted">No recorded drafts in this build.</p>'}

    <h2>6 · Script library scan</h2>
    <p class="muted">${run.library.scanned} scripts checked against ${run.library.activeRuleCount} active rule(s). ${flagged} flagged.</p>
    ${flaggedRows ? `<table><thead><tr><th>Script</th><th>Rule</th><th>Message</th></tr></thead><tbody>${flaggedRows}</tbody></table>` : ''}

    <h2>7 · Dependent advice</h2>
    <p class="muted">Rules depending on <strong>${e(DEMO_TOOL)}</strong>: ${run.assistant.dependents}. Returned to probation because the playbook changed: ${invalidated}. Re-graded afterwards.</p>
    <table>
      <thead><tr><th>Rule</th><th>Depends on</th><th>Compliant scenarios</th><th>Status</th></tr></thead>
      <tbody>${assistantRows}</tbody>
    </table>
    <table style="margin-top:12px">
      <thead><tr><th>Point-in-time regime</th><th>Classified as</th><th>ATR ratio</th></tr></thead>
      <tbody>${scenarioRows}</tbody>
    </table>

    <h2>Method and limits</h2>
    <ul class="limits">${limits.map(line => `<li>${e(line)}</li>`).join('')}</ul>

    <h2>Evaluator log</h2>
    <pre>${e(run.log.join('\n') || 'No log lines were recorded.')}</pre>
  </div>
  <footer>DAFE Charts · OakGuard · Analysis software, not financial advice. Market data and results can be incomplete.</footer>
</main>
</body>
</html>`;
}
