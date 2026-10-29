/**
 * OakGuard Lab — overlay UI for the self-improvement loop.
 * Demo stepper: Failure → Candidates → Probation/Duel → Promotion → Re-run.
 */
import { OakGuardObservatory } from './observatory';
import { CANDIDATE_CATALOGUE, failureSignature } from './rules';
import { evaluateCandidate, proveSeedFailure, corpusManifest, SEED_SCRIPT } from './evaluator';
import {
  loadPlaybook, resetPlaybook, promoteRule, archiveRejection,
  validateWithPlaybook, activeRules, findEmeritusBySignature, getRuleById,
} from './store';
import { validate } from '../oakscript/validator';
import { parse } from '../oakscript/parser';
import { executeScript } from '../oakscript/interpreter';
import { syntheticBars } from './mutants';
import type { EvalReport, PlaybookState, RuleSpec } from './types';

let overlay: HTMLDivElement | null = null;
let observatory: OakGuardObservatory | null = null;

const FONT = "ui-monospace, Menlo, Consolas, monospace";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css: Partial<CSSStyleDeclaration>, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node.style, css);
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, primary = false): HTMLButtonElement {
  const b = el('button', {
    padding: '7px 12px', borderRadius: '6px', cursor: 'pointer',
    border: `1px solid ${primary ? 'rgba(110,255,190,0.55)' : 'rgba(140,180,255,0.35)'}`,
    background: primary ? 'rgba(34,204,136,0.16)' : 'rgba(20,28,55,0.85)',
    color: primary ? '#8ff5c0' : '#bcd6ff', fontFamily: FONT, fontSize: '11px', fontWeight: '700',
    letterSpacing: '0.06em',
  }, label);
  return b;
}

export function mountOakGuardLauncher(): void {
  // OakGuard lives in Settings → LLM Configuration (button
  // #set-open-oakguard, wired in main.ts) — no floating launcher on the
  // chart anymore. The deep-link stays for demos/recordings.
  if (window.location.search.includes('oakguard=1')) openOakGuard();
}

export function openOakGuard(): void {
  (window as any).__dafeOakGuardOpen = true;
  if (overlay) { overlay.style.display = 'flex'; observatory?.resize(); return; }
  let state: PlaybookState = loadPlaybook();
  const reports = new Map<string, EvalReport>();
  let proposed = false;

  overlay = el('div', {
    position: 'fixed', inset: '0', zIndex: '200000', display: 'flex', flexDirection: 'column',
    background: '#04040c', color: '#cfe6ff', fontFamily: FONT,
  });

  const manifest = corpusManifest();
  const header = el('div', { display: 'flex', alignItems: 'center', gap: '14px', padding: '10px 16px', borderBottom: '1px solid rgba(120,180,255,0.18)', flexWrap: 'wrap' });
  const title = el('div', { fontSize: '15px', fontWeight: '800', letterSpacing: '0.14em', color: '#aef4ff' }, '⬢ OAKGUARD · THE CRUCIBLE');
  const hud = el('div', { fontSize: '11px', color: '#8fb8e8', letterSpacing: '0.05em' });
  const updateHud = () => {
    const rules = activeRules(state).map(r => r.issueCode).join(', ') || 'none';
    hud.textContent = `PLAYBOOK v${state.version} · ACTIVE RULES: ${rules} · CORPUS ${manifest.corpusCount} · MANIFEST ${manifest.manifestHash}`;
  };
  updateHud();
  const closeBtn = button('✕ CLOSE');
  closeBtn.onclick = () => { if (overlay) overlay.style.display = 'none'; (window as any).__dafeOakGuardOpen = false; };
  header.append(title, hud, closeBtn);
  overlay.appendChild(header);

  const body = el('div', { display: 'flex', flex: '1', minHeight: '0', flexDirection: 'row' });
  const stageWrap = el('div', { position: 'relative', flex: '1.55', minWidth: '0', background: '#04040c' });
  const canvas = el('canvas', { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block' });
  stageWrap.appendChild(canvas);
  const stageCaption = el('div', {
    position: 'absolute', left: '14px', bottom: '10px', fontSize: '10px', color: 'rgba(160,210,255,0.75)',
    letterSpacing: '0.12em', pointerEvents: 'none',
  }, 'DRAG TO ORBIT · SCROLL TO ZOOM · LIVE');
  stageWrap.appendChild(stageCaption);
  body.appendChild(stageWrap);

  const side = el('div', {
    flex: '1', minWidth: '320px', maxWidth: '520px', overflowY: 'auto', padding: '12px 14px',
    borderLeft: '1px solid rgba(120,180,255,0.15)', background: 'rgba(7,10,24,0.97)',
  });
  body.appendChild(side);
  overlay.appendChild(body);
  document.body.appendChild(overlay);

  const logBox = el('div', {
    fontSize: '11px', lineHeight: '1.55', whiteSpace: 'pre-wrap', background: 'rgba(3,6,16,0.9)',
    border: '1px solid rgba(120,180,255,0.16)', borderRadius: '8px', padding: '10px', minHeight: '120px',
  });
  const log = (msg: string) => { logBox.textContent += (logBox.textContent ? '\n' : '') + msg; logBox.scrollTop = logBox.scrollHeight; };

  const candidatesBox = el('div', { display: 'flex', flexDirection: 'column', gap: '8px', margin: '10px 0' });
  const emeritusBox = el('div', { display: 'flex', flexDirection: 'column', gap: '6px', margin: '10px 0' });

  const renderEmeritus = () => {
    emeritusBox.replaceChildren();
    emeritusBox.appendChild(el('div', { fontSize: '11px', fontWeight: '800', letterSpacing: '0.1em', color: '#c9a6ff' }, `EMERITUS ARCHIVE (${state.emeritus.length})`));
    if (!state.emeritus.length) emeritusBox.appendChild(el('div', { fontSize: '11px', color: '#7d94b8' }, 'No rejected rules yet. Rejections are preserved with their counterexamples.'));
    for (const rec of state.emeritus) {
      const card = el('div', { border: '1px solid rgba(180,140,255,0.28)', borderRadius: '8px', padding: '8px 10px', background: 'rgba(40,24,70,0.35)' });
      card.appendChild(el('div', { fontSize: '11px', fontWeight: '700', color: '#d7bdff' }, rec.name));
      card.appendChild(el('div', { fontSize: '10px', color: '#a68fd0' }, rec.reasons.join(' ')));
      if (rec.counterexample) card.appendChild(el('div', { fontSize: '10px', color: '#ff9db1', marginTop: '4px' }, `Counterexample: ${rec.counterexample}`));
      emeritusBox.appendChild(card);
    }
  };

  const renderCandidates = () => {
    candidatesBox.replaceChildren();
    candidatesBox.appendChild(el('div', { fontSize: '11px', fontWeight: '800', letterSpacing: '0.1em', color: '#9be8ff' }, 'CANDIDATES (declarative specs — never code)'));
    for (const rule of CANDIDATE_CATALOGUE) {
      const report = reports.get(rule.id);
      const active = state.activeRuleIds.includes(rule.id);
      const dead = findEmeritusBySignature(state, rule);
      const card = el('div', {
        border: `1px solid ${active ? 'rgba(110,255,190,0.5)' : 'rgba(140,180,255,0.22)'}`,
        borderRadius: '8px', padding: '8px 10px', background: active ? 'rgba(20,70,45,0.3)' : 'rgba(14,20,42,0.6)',
      });
      card.appendChild(el('div', { fontSize: '11px', fontWeight: '700', color: active ? '#8ff5c0' : '#cfe6ff' },
        `${rule.name} → ${rule.issueCode}${active ? ' · ACTIVE' : ''}${dead && !active ? ' · IN EMERITUS (refined successor proposed)' : ''}`));
      card.appendChild(el('div', { fontSize: '10px', color: '#8fb8e8', marginTop: '2px' }, rule.description));
      if (report) {
        card.appendChild(el('div', { fontSize: '10px', color: '#ffd9a0', marginTop: '5px' },
          `Mutants ${report.mutantCaught}/${report.mutantTotal} · held-out ${report.heldOutCaught}/${report.heldOutTotal} · FP ${report.falsePositiveCount}/${report.goodTotal} · exec Δ ${report.candidateExecErrors - report.baselineExecErrors} · ${report.durationMs}ms → ${report.verdict.toUpperCase()}`));
      }
      candidatesBox.appendChild(card);
    }
  };

  const syncScene = () => {
    observatory?.setPlaybook(activeRules(state).map(r => r.issueCode));
    updateHud();
    renderCandidates();
    renderEmeritus();
  };

  // Stepper
  const steps = el('div', { display: 'flex', flexDirection: 'column', gap: '8px' });
  const stepLabel = (t: string) => el('div', { fontSize: '10px', letterSpacing: '0.12em', color: '#7fa8d8', marginTop: '6px' }, t);

  const b1 = button('1 · REPLAY SEED FAILURE');
  b1.onclick = () => {
    observatory?.setStage(0);
    const proof = proveSeedFailure();
    const baseline = validate(SEED_SCRIPT);
    log(`SEED: baseline validator valid=${proof.baselineValid} issues=[${proof.baselineIssueCodes.join(', ') || 'none'}]`);
    log(`SEED: execution proof — SMA series finite values ${(proof.finiteRatio * 100).toFixed(0)}% (${proof.plotCount} plot points). The indicator is dead but "valid".`);
    void baseline;
    observatory?.pulseEscape();
  };

  const b2 = button('2 · PROPOSE CANDIDATES');
  b2.onclick = () => {
    observatory?.setStage(1);
    proposed = true;
    for (const rule of CANDIDATE_CATALOGUE) {
      const dead = findEmeritusBySignature(state, rule);
      log(dead
        ? `CANDIDATE ${rule.id}: signature matches Emeritus (${dead.name}) — proposing refined successor instead of re-running a dead rule.`
        : `CANDIDATE ${rule.id}: ${rule.name} [${rule.family}] → ${rule.issueCode}`);
    }
    renderCandidates();
  };

  const b3 = button('3 · RUN PROBATION + DUEL');
  b3.onclick = () => {
    if (!proposed) { log('Propose candidates first (step 2).'); return; }
    observatory?.setStage(2);
    log('PROBATION: scoring candidates against frozen corpus + visible/held-out mutants…');
    let bestCaught = 0, bestTotal = 1;
    for (const rule of CANDIDATE_CATALOGUE) {
      if (state.activeRuleIds.includes(rule.id)) continue;
      const report = evaluateCandidate(rule);
      reports.set(rule.id, report);
      if (report.mutantTotal > 0) { bestCaught = Math.max(bestCaught, report.mutantCaught); bestTotal = Math.max(bestTotal, report.mutantTotal); }
      log(`[${rule.id}] mutants ${report.mutantCaught}/${report.mutantTotal} (held-out ${report.heldOutCaught}/${report.heldOutTotal}) · FP ${report.falsePositiveCount}/${report.goodTotal} · ${report.durationMs}ms → ${report.verdict.toUpperCase()}`);
      for (const r of report.reasons) log(`  - ${r}`);
    }
    observatory?.launchSwarm(bestTotal, bestCaught);
    observatory?.setStage(3);
    renderCandidates();
  };

  const b4 = button('4 · PROMOTE / ARCHIVE VERDICTS', true);
  b4.onclick = () => {
    observatory?.setStage(4);
    let changed = false;
    for (const rule of CANDIDATE_CATALOGUE) {
      const report = reports.get(rule.id);
      if (!report || state.activeRuleIds.includes(rule.id)) continue;
      if (report.verdict === 'promoted') {
        state = promoteRule(state, {
          ruleId: rule.id, issueCode: rule.issueCode, playbookVersion: state.version + 1,
          manifestHash: report.manifestHash, modelId: 'fixed-model (candidate catalogue)',
          promotedAt: Date.now(), report,
        });
        log(`PROMOTED ${rule.issueCode} — playbook v${state.version}. Core gains a ring.`);
        changed = true;
      } else if (!state.emeritus.some(e => e.failureSignature === failureSignature(rule))) {
        state = archiveRejection(state, {
          ruleId: rule.id, name: rule.name, failureSignature: failureSignature(rule),
          rejectedAt: Date.now(), reasons: report.reasons, counterexample: report.counterexample, report,
        });
        observatory?.rejectToEmeritus(rule.id);
        log(`REJECTED → EMERITUS: ${rule.name}. Preserved with counterexample.`);
        changed = true;
      }
    }
    if (!changed) log('No new verdicts to apply (already promoted/archived).');
    syncScene();
  };

  const b5 = button('5 · RE-RUN ORIGINAL TASK');
  b5.onclick = () => {
    const issues = validateWithPlaybook(state, SEED_SCRIPT);
    if (!issues.length) { log('RE-RUN: no active rule caught the seed — promote a passing candidate first (steps 3–4).'); observatory?.pulseEscape(); return; }
    for (const i of issues) log(`RE-RUN: playbook catches seed — L${i.line} [${i.code}] ${i.message}`);
    const fixed = SEED_SCRIPT.replace('sma(close, 0)', 'sma(close, 14)');
    const recheck = validateWithPlaybook(state, fixed);
    let finiteRatio = 0;
    try {
      const result = executeScript(parse(fixed), syntheticBars(120), new Map());
      let f = 0, t = 0;
      for (const p of result.plots) {
        if (p.name !== 'SMA' || !Array.isArray(p.series)) continue;
        for (const v of p.series) { t++; if (Number.isFinite(v)) f++; }
      }
      finiteRatio = t ? f / t : 0;
    } catch { /* reported below */ }
    log(`RE-RUN: auto-fix sma(close, 0) → sma(close, 14); remaining playbook issues=${recheck.length}; SMA finite values now ${(finiteRatio * 100).toFixed(0)}%.`);
    observatory?.setStage(4);
  };

  const b6 = button('6 · SCAN LIVE SCRIPTS WITH PLAYBOOK');
  b6.onclick = () => {
    const rules = activeRules(state);
    if (!rules.length) { log('SCAN: playbook has no active rules — promote a candidate first (steps 3–4). Baseline validator is unchanged until then.'); return; }
    import('../oakscript/indicators').then(({ getIndicators, getUserIndicators }) => {
      const all = [...getIndicators(), ...getUserIndicators()];
      let catches = 0;
      for (const ind of all) {
        const issues = validateWithPlaybook(state, ind.source);
        if (issues.length) { catches += issues.length; log(`SCAN: ${ind.name} → ${issues.length} catch(es): [${issues[0].code}] ${issues[0].message.slice(0, 110)}`); }
      }
      log(`SCAN: ${all.length} scripts checked with playbook v${state.version} (${rules.map(r => r.issueCode).join(', ')}) — ${catches} catch(es). These same rules now fire inside the editor validator and agent auto-fix loop for every new script.`);
      observatory?.setStage(4);
    }).catch(() => log('SCAN: indicator library unavailable.'));
  };

  const bReset = button('RESET PLAYBOOK');
  bReset.onclick = () => {
    state = resetPlaybook();
    reports.clear();
    proposed = false;
    log('Playbook reset to v1 (baseline validator, no active OakGuard rules). Emeritus cleared.');
    syncScene();
    observatory?.setStage(0);
  };

  steps.append(
    stepLabel('STEP 1 — A REAL FAILURE THE BASELINE MISSES'), b1,
    stepLabel('STEP 2 — FIXED MODEL PROPOSES RULE SPECS'), b2,
    stepLabel('STEP 3 — INDEPENDENT EVALUATOR SCORES THEM'), b3,
    stepLabel('STEP 4 — ONLY EVIDENCE PROMOTES'), b4,
    stepLabel('STEP 5 — SAME TASK, NEW PLAYBOOK'), b5,
    stepLabel('STEP 6 — THE PLAYBOOK IS LIVE AFTER THE DEMO'), b6, bReset,
  );
  side.append(
    el('div', { fontSize: '11px', color: '#8fb8e8', lineHeight: '1.5' },
      'Purpose: a fixed LLM proposes declarative validation rules; an independent evaluator promotes only what passes every gate. Promoted rules then enforce LIVE in the editor validator + agent auto-fix loop for every future script (Step 6 proves it). Rejections are preserved in Emeritus with counterexamples.'),
    steps, candidatesBox, emeritusBox,
    el('div', { fontSize: '11px', fontWeight: '800', letterSpacing: '0.1em', color: '#9be8ff', margin: '10px 0 6px' }, 'EVALUATOR LOG'),
    logBox,
  );
  log(`OakGuard ready. Corpus ${manifest.corpusCount} known-good scripts · manifest ${manifest.manifestHash} · playbook v${state.version}.`);
  log('Receipts: npm run verify:oakguard (headless scorekeeper) · npm test (2,171,421 checks).');

  observatory = new OakGuardObservatory(canvas);
  syncScene();
  requestAnimationFrame(() => observatory?.resize());
}

export function closeOakGuard(): void {
  if (overlay) overlay.style.display = 'none';
  (window as any).__dafeOakGuardOpen = false;
}

export function disposeOakGuard(): void {
  observatory?.dispose();
  observatory = null;
  overlay?.remove();
  overlay = null;
}
