/**
 * OakGuard sheet — the desktop Crucible window as a mobile bottom sheet.
 *
 * Same pipeline (runOakGuard), same step wording, same playbook store and the
 * same report as the desktop panel. The 3D observatory is mounted only when
 * WebGL can start; the rest of the sheet does not depend on it.
 */
import { OakGuardObservatory } from '../../web/src/oakguard/observatory';
import {
  runOakGuard, STEP_GROUPS, STEP_HINTS, STEP_TITLES,
  type CandidateOutcome, type OakGuardRun, type StepRecord, type StepStatus,
} from '../../web/src/oakguard/pipeline';
import { buildOakGuardReport } from '../../web/src/oakguard/report';
import { CANDIDATE_CATALOGUE } from '../../web/src/oakguard/rules';
import { activeRules, loadPlaybook, resetPlaybook } from '../../web/src/oakguard/store';
import type { PlaybookState, RuleSpec } from '../../web/src/oakguard/types';
import { replayTransport, type RecordedRun } from '../../web/src/oakguard/proposer';
import recorded from '../../web/src/oakguard/recorded-run.json';

/** The phone replays the recorded Muse Wonder run; the referee re-grades it on the device. */
const RECORDED = recorded as unknown as RecordedRun;
import { getIndicators, getUserIndicators } from '../../web/src/oakscript';
import { openSheet, onSheetClosed, sectionTitle } from './sheets';
import { submitReport } from './reports';

const ACCENT = '#2dffb3';
const BORDER = 'border:1px solid rgba(180,140,255,0.12);border-radius:8px;padding:9px 11px;background:rgba(255,255,255,0.02);';

let state: PlaybookState = loadPlaybook();
let lastRun: OakGuardRun | null = null;
let running = false;
let content: HTMLDivElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let observatory: OakGuardObservatory | null = null;
let observatoryFailed = false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.style.cssText = css;
  if (text !== undefined) node.textContent = text;
  return node;
}

function column(gap = 8): HTMLDivElement {
  return el('div', `display:flex;flex-direction:column;gap:${gap}px;`);
}

function showToast(msg: string, kind: 'ok' | 'err' = 'ok'): void {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function actionButton(label: string, kind: 'primary' | 'outline' | 'ghost', disabled: boolean, onClick: () => void): HTMLButtonElement {
  const look = kind === 'primary'
    ? `background:rgba(45,255,179,0.16);border:1px solid rgba(45,255,179,0.6);color:${ACCENT};`
    : kind === 'outline'
      ? `background:transparent;border:1px solid rgba(45,255,179,0.45);color:${ACCENT};`
      : 'background:transparent;border:1px solid rgba(255,255,255,0.14);color:rgba(255,255,255,0.7);';
  const b = el('button', `${look}border-radius:8px;padding:10px 14px;font-size:12px;font-weight:600;font-family:inherit;min-height:40px;flex:1;cursor:pointer;`, label);
  b.disabled = disabled;
  if (disabled) b.style.opacity = '0.4';
  b.addEventListener('click', onClick);
  return b;
}

function pill(text: string, tone: 'ok' | 'warn' | 'muted'): HTMLSpanElement {
  const color = tone === 'ok' ? '#22cc88' : tone === 'warn' ? '#FFB800' : 'rgba(255,255,255,0.45)';
  return el('span', `display:inline-block;padding:1px 8px;border-radius:999px;font-size:10px;font-weight:600;color:${color};border:1px solid ${color}66;white-space:nowrap;`, text);
}

function ensureStyles(): void {
  if (document.getElementById('oakguard-sheet-styles')) return;
  const style = document.createElement('style');
  style.id = 'oakguard-sheet-styles';
  style.textContent = '@keyframes og-spin { to { transform: rotate(360deg); } }';
  document.head.appendChild(style);
}

function mountObservatory(host: HTMLElement): void {
  if (observatoryFailed) return;
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:100%;height:220px;display:block;border-radius:10px;background:#04040c;border:1px solid rgba(180,140,255,0.12);touch-action:none;';
  }
  host.appendChild(canvas);
  if (!observatory) {
    try {
      observatory = new OakGuardObservatory(canvas);
    } catch {
      observatoryFailed = true;
      canvas.remove();
      canvas = null;
      return;
    }
  }
  observatory.resize();
  requestAnimationFrame(() => observatory?.resize());
  syncScene();
}

function syncScene(): void {
  observatory?.setPlaybook(activeRules(state).map(r => r.issueCode));
}

function introBlock(): HTMLElement {
  return el('div', 'font-size:11px;line-height:1.55;color:rgba(255,255,255,0.7);',
    'When code passes the validator but breaks at runtime, Muse Wonder writes a rule that would have caught it. A referee the model cannot see keeps only rules that catch every broken variant without a false alarm. The phone replays a recorded Muse Wonder run and re-grades it here.');
}

function runBlock(): HTMLElement {
  const wrap = column(6);
  const run = actionButton(running ? 'Running…' : lastRun ? '↻ Run again' : '▶ Run OakGuard', 'primary', running, () => { void runNow(); });
  run.style.flex = 'none';
  run.style.width = '100%';
  run.style.fontSize = '13px';
  wrap.append(run, el('div', 'font-size:10px;color:rgba(255,255,255,0.4);text-align:center;',
    running ? 'Working through all 8 steps…' : 'Runs all 8 steps automatically. Takes a few seconds.'));
  return wrap;
}

function stepRow(index: number, step: StepRecord): HTMLElement {
  const tone = step.status === 'done' ? '#22cc88'
    : step.status === 'failed' ? '#ff4477'
      : step.status === 'running' ? ACCENT
        : 'rgba(255,255,255,0.3)';
  const live = step.status === 'running';
  const row = el('div', `display:grid;grid-template-columns:26px 1fr 18px;gap:10px;align-items:start;padding:9px 10px;border-radius:8px;border:1px solid ${live ? 'rgba(45,255,179,0.45)' : 'rgba(180,140,255,0.12)'};background:${live ? 'rgba(45,255,179,0.06)' : 'rgba(255,255,255,0.02)'};`);
  const badge = el('div', `width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:${tone};border:1px solid ${tone};`, String(index + 1));
  const text = el('div', 'min-width:0;');
  text.append(
    el('div', 'font-size:12px;font-weight:600;color:#ece8ff;', step.title),
    el('div', 'font-size:10.5px;line-height:1.45;color:rgba(255,255,255,0.5);margin-top:2px;', step.summary || STEP_HINTS[index]),
  );
  const icon = el('div', `font-size:13px;color:${tone};text-align:center;line-height:26px;`,
    step.status === 'done' ? '✓' : step.status === 'failed' ? '✕' : live ? '◌' : '');
  if (live) icon.style.animation = 'og-spin 1.1s linear infinite';
  row.append(badge, text, icon);
  return row;
}

function stepsBlock(): HTMLElement {
  const wrap = column(6);
  const steps: StepRecord[] = lastRun
    ? lastRun.steps
    : STEP_TITLES.map((title, i): StepRecord => ({ title, status: 'pending', summary: STEP_HINTS[i] }));
  for (const group of STEP_GROUPS) {
    wrap.appendChild(sectionTitle(group.label));
    for (let i = group.from; i <= group.to; i++) wrap.appendChild(stepRow(i, steps[i]));
  }
  return wrap;
}

function verdictCard(c: CandidateOutcome): HTMLElement {
  const promoted = c.outcome === 'promoted' || c.outcome === 'active';
  const label = c.outcome === 'promoted' ? 'PROMOTED'
    : c.outcome === 'active' ? 'PROMOTED · ACTIVE'
      : c.outcome === 'archived' ? 'REJECTED · EARLIER'
        : 'REJECTED';
  const r = c.report;
  const card = column(5);
  card.style.cssText += BORDER;
  const head = el('div', 'display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap;');
  head.append(el('div', 'font-size:12px;font-weight:600;color:#e8e2ff;', c.rule.name), pill(label, promoted ? 'ok' : 'warn'));
  card.append(
    head,
    el('div', 'font-size:11px;color:rgba(255,255,255,0.5);', c.rule.description),
    el('div', 'font-size:11px;color:#ffd9a0;', `Broken variants ${r.mutantCaught}/${r.mutantTotal} · held-out ${r.heldOutCaught}/${r.heldOutTotal} · false alarms ${r.falsePositiveCount}/${r.goodTotal}`),
  );
  for (const reason of r.reasons) card.appendChild(el('div', 'font-size:11px;line-height:1.45;color:rgba(255,255,255,0.6);', reason));
  return card;
}

function pendingCard(rule: RuleSpec): HTMLElement {
  const card = column(4);
  card.style.cssText += BORDER;
  const head = el('div', 'display:flex;justify-content:space-between;gap:8px;align-items:center;');
  head.append(el('div', 'font-size:12px;font-weight:600;color:#e8e2ff;', rule.name), pill('NOT TESTED', 'muted'));
  card.append(head, el('div', 'font-size:11px;color:rgba(255,255,255,0.5);', rule.description));
  return card;
}

function verdictsBlock(): HTMLElement {
  const wrap = column(8);
  wrap.appendChild(sectionTitle('Candidate verdicts'));
  if (lastRun) {
    if (lastRun.candidates.length === 0) wrap.appendChild(el('div', 'font-size:11px;color:rgba(255,255,255,0.45);', 'Testing candidate rules…'));
    for (const c of lastRun.candidates) wrap.appendChild(verdictCard(c));
  } else {
    for (const rule of CANDIDATE_CATALOGUE) wrap.appendChild(pendingCard(rule));
  }
  return wrap;
}

function playbookBlock(): HTMLElement {
  const wrap = column(8);
  const rules = activeRules(state);
  wrap.appendChild(sectionTitle(`Active playbook · ${rules.length}`));
  if (rules.length === 0) {
    wrap.appendChild(el('div', 'font-size:11px;color:rgba(255,255,255,0.45);', 'No rules enforced yet. Run OakGuard to promote proven rules into your editor.'));
  }
  for (const rule of rules) {
    const card = column(3);
    card.style.cssText += BORDER;
    const head = el('div', 'display:flex;justify-content:space-between;gap:8px;align-items:center;');
    head.append(el('div', 'font-size:12px;font-weight:600;color:#e8e2ff;', rule.name), pill(rule.issueCode, 'ok'));
    card.append(head, el('div', 'font-size:11px;color:rgba(255,255,255,0.5);', rule.description));
    wrap.appendChild(card);
  }
  if (state.emeritus.length > 0) {
    wrap.appendChild(el('div', 'font-size:10.5px;color:rgba(255,255,255,0.45);', `${state.emeritus.length} archived rule(s) kept with their counterexamples.`));
  }
  return wrap;
}

function actionsBlock(): HTMLElement {
  const row = el('div', 'display:flex;gap:8px;flex-wrap:wrap;');
  row.append(
    actionButton('Download report', 'outline', running, () => { void downloadReport(); }),
    actionButton('Reset playbook', 'ghost', running, resetAll),
  );
  return row;
}

function render(): void {
  if (!content) return;
  const body = content.parentElement;
  const scroll = body?.scrollTop ?? 0;
  content.replaceChildren(
    introBlock(),
    runBlock(),
    stepsBlock(),
    verdictsBlock(),
    playbookBlock(),
    actionsBlock(),
  );
  if (body) body.scrollTop = scroll;
}

function onStep(index: number, status: StepStatus, run: OakGuardRun): void {
  lastRun = run;
  if (observatory) {
    if (status === 'running') {
      observatory.setStage(Math.min(index, 4));
    } else if (status === 'done') {
      if (index === 0) observatory.pulseEscape();
      if (index === 2) {
        const best = run.candidates.reduce(
          (b, c) => (c.report.mutantTotal > b.total ? { total: c.report.mutantTotal, caught: c.report.mutantCaught } : b),
          { total: 1, caught: 0 },
        );
        observatory.launchSwarm(best.total, best.caught);
        observatory.setStage(3);
      }
      if (index === 3) {
        for (const c of run.candidates) if (c.outcome === 'rejected') observatory.rejectToEmeritus(c.rule.name);
        observatory.setPlaybook(activeRules(run.playbook).map(r => r.issueCode));
        observatory.setStage(4);
      }
      if (index === 6 && run.assistant.invalidated.length) observatory.pulseEscape();
    }
  }
  render();
}

function collectScripts(): { name: string; source: string }[] {
  return [...getIndicators(), ...getUserIndicators()].map(ind => ({ name: ind.name, source: ind.source }));
}

async function runNow(): Promise<OakGuardRun | null> {
  if (running) return null;
  running = true;
  lastRun = null;
  render();
  try {
    const run = await runOakGuard({
      state,
      scripts: collectScripts(),
      mode: 'replay',
      transport: replayTransport(RECORDED),
      model: RECORDED.model,
      recordedAt: RECORDED.recordedAt,
      onStep,
      pause: () => new Promise<void>(resolve => setTimeout(resolve, 300)),
    });
    lastRun = run;
    state = run.playbook;
    return run;
  } catch (err) {
    console.error('OakGuard run failed', err);
    showToast('OakGuard run failed', 'err');
    return null;
  } finally {
    running = false;
    syncScene();
    render();
  }
}

function fileStamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

async function downloadReport(): Promise<void> {
  if (running) return;
  const run = lastRun && lastRun.steps.every(s => s.status === 'done') ? lastRun : await runNow();
  if (!run) return;
  const now = new Date();
  try {
    const html = buildOakGuardReport(run, now);
    const promoted = run.candidates.filter(c => c.outcome === 'promoted').length;
    const archived = run.candidates.filter(c => c.outcome === 'rejected').length;
    await submitReport({
      subject: 'OakGuard report',
      filename: `OakGuard-report-${fileStamp(now)}.html`,
      html,
      text: `OakGuard: ${promoted} rule(s) promoted, ${archived} archived, ${run.library.flagged.length} script(s) flagged.`,
      onDone: (m) => showToast(m),
    });
  } catch (err) {
    console.error('OakGuard report failed', err);
    showToast('Could not export report', 'err');
  }
}

function resetAll(): void {
  if (running) return;
  state = resetPlaybook();
  lastRun = null;
  observatory?.setStage(0);
  syncScene();
  render();
}

export function openOakGuardSheet(): void {
  ensureStyles();
  if (!running) state = loadPlaybook();
  openSheet((body) => {
    const root = column(10);
    root.style.cssText += 'padding-top:6px;';
    const stage = el('div', 'position:relative;');
    content = column(10);
    root.append(stage, content);
    body.appendChild(root);
    mountObservatory(stage);
    onSheetClosed(() => canvas?.remove());
    render();
  }, { title: '⬢ OakGuard', height: '88vh' });
}
