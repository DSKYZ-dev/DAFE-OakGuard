/**
 * OakGuard window — the Crucible as a floating window, like the rest of the app.
 *
 * One action runs the whole loop (pipeline.ts). The 3D stage, the step list,
 * the results and the report all read the same run.
 */
import { OakGuardObservatory } from './observatory';
import {
  runOakGuard, STEP_GROUPS, STEP_HINTS, STEP_TITLES,
  type CandidateStatus, type OakGuardRun, type ScriptRef, type StepRecord, type StepStatus,
} from './pipeline';
import { buildOakGuardReport } from './report';
import { ASSISTANT_RULES } from './assistant';
import { CANDIDATE_CATALOGUE } from './rules';
import { activeRules, loadPlaybook, resetPlaybook, validateWithPlaybook } from './store';
import { corpusManifest } from './evaluator';
import { validate } from '../oakscript/validator';
import { getIndicators, getUserIndicators } from '../oakscript/indicators';
import { WINDOW_TOP_MIN, clearOfHeaderTop } from '../header-band';
import type { PlaybookState } from './types';

const ACCENT = 'var(--dafe-glow, #2dffb3)';
const SUBTLE_BORDER = 'rgba(180,140,255,0.12)';

interface CheckIssue { line: number; code: string; message: string; }
interface CheckResult { empty: boolean; issues: CheckIssue[]; }

let win: HTMLDivElement | null = null;
let bodyEl: HTMLDivElement | null = null;
let side: HTMLDivElement | null = null;
let chips: HTMLDivElement | null = null;
let observatory: OakGuardObservatory | null = null;
let manifest: ReturnType<typeof corpusManifest> | null = null;
let state: PlaybookState = loadPlaybook();
let lastRun: OakGuardRun | null = null;
let running = false;
let minimized = false;
let detailsOpen = false;
let placed = false;
let checkResult: CheckResult | null = null;

function node<K extends keyof HTMLElementTagNameMap>(tag: K, css: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.style.cssText = css;
  if (text !== undefined) el.textContent = text;
  return el;
}

function button(label: string, variant: 'primary' | 'outline' | 'ghost'): HTMLButtonElement {
  const look = variant === 'primary'
    ? `background:color-mix(in srgb, ${ACCENT} 20%, transparent);border:1px solid color-mix(in srgb, ${ACCENT} 60%, transparent);color:${ACCENT};`
    : variant === 'outline'
      ? `background:transparent;border:1px solid color-mix(in srgb, ${ACCENT} 45%, transparent);color:${ACCENT};`
      : 'background:transparent;border:1px solid rgba(255,255,255,0.12);color:rgba(255,255,255,0.6);';
  return node('button', `${look}border-radius:6px;padding:7px 12px;font-size:11px;font-weight:600;font-family:inherit;cursor:pointer;`, label);
}

function sectionTitle(text: string): HTMLDivElement {
  return node('div', 'font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:rgba(180,140,255,0.75);margin:8px 0 2px;', text);
}

function chip(text: string): HTMLDivElement {
  return node('div', 'padding:3px 9px;border-radius:999px;font-size:10px;letter-spacing:0.04em;background:rgba(8,8,20,0.78);border:1px solid rgba(255,255,255,0.12);color:rgba(255,255,255,0.75);white-space:nowrap;', text);
}

function pill(text: string, tone: 'ok' | 'warn' | 'muted'): HTMLSpanElement {
  const color = tone === 'ok' ? '#22cc88' : tone === 'warn' ? '#FFB800' : 'rgba(255,255,255,0.45)';
  return node('span', `display:inline-block;padding:1px 8px;border-radius:999px;font-size:10px;font-weight:600;color:${color};border:1px solid ${color}66;white-space:nowrap;`, text);
}

function card(extraCss = ''): HTMLDivElement {
  return node('div', `border:1px solid ${SUBTLE_BORDER};border-radius:8px;padding:8px 10px;background:rgba(255,255,255,0.02);${extraCss}`);
}

function ensureStyles(): void {
  if (document.getElementById('oakguard-styles')) return;
  const style = document.createElement('style');
  style.id = 'oakguard-styles';
  style.textContent = `
    @keyframes og-spin { to { transform: rotate(360deg); } }
    #oakguard-window button:disabled { opacity: .4; cursor: default; }
    #oakguard-window button:not(:disabled):hover { filter: brightness(1.15); }
  `;
  document.head.appendChild(style);
}

function placeWindow(): void {
  if (!win || placed) return;
  placed = true;
  const width = Math.min(1040, window.innerWidth - 32);
  const height = Math.min(640, window.innerHeight - WINDOW_TOP_MIN - 40);
  Object.assign(win.style, {
    width: `${width}px`,
    height: `${Math.max(440, height)}px`,
    left: `${Math.max(12, Math.round((window.innerWidth - width) / 2))}px`,
    top: `${clearOfHeaderTop(WINDOW_TOP_MIN + 12)}px`,
  });
}

function buildWindow(): void {
  ensureStyles();
  manifest = corpusManifest();

  win = node('div', 'position:fixed;z-index:220;display:none;flex-direction:column;background:rgba(8,8,20,0.95);border:1px solid rgba(180,140,255,0.15);border-radius:10px;backdrop-filter:blur(12px);box-shadow:0 8px 40px rgba(0,0,0,0.6);overflow:hidden;color:rgba(255,255,255,0.75);font-size:11px;');
  win.id = 'oakguard-window';
  win.className = 'dafe-glow-window';

  // Header: the same chrome as the Model Inputs window.
  const header = node('div', 'display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid rgba(180,140,255,0.1);cursor:move;user-select:none;flex-shrink:0;');
  const titleWrap = node('div', 'display:flex;align-items:baseline;gap:10px;min-width:0;');
  titleWrap.append(
    node('span', `color:${ACCENT};font-size:12px;font-weight:600;white-space:nowrap;`, '⬢ OakGuard'),
    node('span', 'color:rgba(255,255,255,0.4);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;', 'Verification for AI-written indicators'),
  );
  const controls = node('div', 'display:flex;gap:4px;flex-shrink:0;');
  const minBtn = node('button', 'background:none;border:1px solid rgba(255,255,255,0.1);color:#888;cursor:pointer;font-size:14px;padding:1px 7px;border-radius:4px;', '−');
  minBtn.title = 'Collapse window';
  minBtn.onclick = () => {
    minimized = !minimized;
    if (bodyEl) bodyEl.style.display = minimized ? 'none' : 'flex';
  };
  const closeBtn = node('button', 'background:none;border:1px solid rgba(255,255,255,0.1);color:#888;cursor:pointer;font-size:12px;padding:1px 6px;border-radius:4px;', '✕');
  closeBtn.title = 'Close';
  closeBtn.onclick = () => closeOakGuard();
  controls.append(minBtn, closeBtn);
  header.append(titleWrap, controls);

  let dragX = 0;
  let dragY = 0;
  let dragging = false;
  header.addEventListener('mousedown', (ev) => {
    if (!win || (ev.target as HTMLElement).tagName === 'BUTTON') return;
    dragging = true;
    dragX = ev.clientX - win.offsetLeft;
    dragY = ev.clientY - win.offsetTop;
    ev.preventDefault();
  });
  document.addEventListener('mousemove', (ev) => {
    if (!dragging || !win) return;
    win.style.left = `${Math.min(window.innerWidth - 120, Math.max(0, ev.clientX - dragX))}px`;
    win.style.top = `${clearOfHeaderTop(Math.min(window.innerHeight - 40, ev.clientY - dragY))}px`;
  });
  document.addEventListener('mouseup', () => { dragging = false; });

  bodyEl = node('div', 'display:flex;flex:1;min-height:0;');
  const viewport = node('div', 'position:relative;flex:1.25;min-width:0;background:#04040c;border-right:1px solid rgba(180,140,255,0.1);');
  const canvas = node('canvas', 'position:absolute;inset:0;width:100%;height:100%;display:block;');
  chips = node('div', 'position:absolute;top:10px;left:10px;right:10px;display:flex;gap:6px;flex-wrap:wrap;pointer-events:none;');
  const caption = node('div', 'position:absolute;left:12px;bottom:10px;font-size:10px;letter-spacing:0.08em;color:rgba(255,255,255,0.35);pointer-events:none;', 'DRAG TO ORBIT · SCROLL TO ZOOM');
  viewport.append(canvas, chips, caption);

  side = node('div', 'width:392px;flex-shrink:0;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:10px;');
  bodyEl.append(viewport, side);
  win.append(header, bodyEl);
  document.body.appendChild(win);

  observatory = new OakGuardObservatory(canvas);
  placeWindow();
  render();
}

export function openOakGuard(): void {
  if (!win) buildWindow();
  if (!win) return;
  state = loadPlaybook();
  win.style.display = 'flex';
  observatory?.resize();
  syncScene();
  render();
}

export function closeOakGuard(): void {
  if (win) win.style.display = 'none';
}

export function disposeOakGuard(): void {
  observatory?.dispose();
  observatory = null;
  win?.remove();
  win = null;
  bodyEl = null;
  side = null;
  chips = null;
  placed = false;
}

export function mountOakGuardLauncher(): void {
  // OakGuard opens from Settings → LLM Configuration, the indicator list and the
  // editor. The deep link stays for demos and recordings.
  if (window.location.search.includes('oakguard=1')) openOakGuard();
}

function syncScene(): void {
  observatory?.setPlaybook(activeRules(state).map(r => r.issueCode));
  renderChips();
}

function renderChips(): void {
  if (!chips || !manifest) return;
  const rules = activeRules(state).length;
  chips.replaceChildren(
    chip('PLAYBOOK'),
    chip(`${rules} ACTIVE RULE${rules === 1 ? '' : 'S'}`),
    chip(`CORPUS ${manifest.corpusCount} SCRIPTS`),
    chip(`FINGERPRINT ${manifest.manifestHash}`),
  );
}

function render(): void {
  renderChips();
  if (!side) return;
  const scroll = side.scrollTop;
  side.replaceChildren(
    introBlock(),
    runBlock(),
    stepsBlock(),
    tilesBlock(),
    verdictBlock(),
    actionsBlock(),
    detailsBlock(),
  );
  side.scrollTop = scroll;
}

function introBlock(): HTMLElement {
  return node('div', 'font-size:11px;line-height:1.55;color:rgba(255,255,255,0.7);',
    'OakGuard checks the rules that check AI-written indicators. Candidate rules come from a hand-written catalogue today. An independent test keeps only the rules that catch real bugs without false alarms, and proven rules go live in your editor.');
}

function runBlock(): HTMLElement {
  const wrap = node('div', 'display:flex;flex-direction:column;gap:6px;');
  const run = button(running ? 'Running…' : lastRun ? '↻ Run again' : '▶ Run OakGuard', 'primary');
  run.style.width = '100%';
  run.style.padding = '9px 12px';
  run.style.fontSize = '12px';
  run.disabled = running;
  run.onclick = () => { void runNow(); };
  wrap.append(run, node('div', 'font-size:10px;color:rgba(255,255,255,0.4);text-align:center;',
    running ? 'Working through all 8 steps…' : 'Runs all 8 steps automatically. Takes a few seconds.'));
  return wrap;
}

function stepRow(index: number, step: StepRecord): HTMLElement {
  const tone = step.status === 'done' ? '#22cc88'
    : step.status === 'failed' ? '#ff4477'
      : step.status === 'running' ? '#2dffb3'
        : 'rgba(255,255,255,0.3)';
  const live = step.status === 'running';
  const row = node('div', `display:grid;grid-template-columns:24px 1fr 18px;gap:10px;align-items:start;padding:8px 10px;border-radius:8px;border:1px solid ${live ? 'rgba(45,255,179,0.45)' : SUBTLE_BORDER};background:${live ? 'rgba(45,255,179,0.06)' : 'rgba(255,255,255,0.02)'};`);
  const badge = node('div', `width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:${tone};border:1px solid ${tone};`, String(index + 1));
  const text = node('div', 'min-width:0;');
  text.append(
    node('div', 'font-size:11px;font-weight:600;color:#ece8ff;', step.title),
    node('div', 'font-size:10px;line-height:1.45;color:rgba(255,255,255,0.5);margin-top:2px;', step.summary || STEP_HINTS[index]),
  );
  const icon = node('div', `font-size:12px;color:${tone};text-align:center;line-height:24px;`,
    step.status === 'done' ? '✓' : step.status === 'failed' ? '✕' : live ? '◌' : '');
  if (live) icon.style.animation = 'og-spin 1.1s linear infinite';
  row.append(badge, text, icon);
  return row;
}

function stepsBlock(): HTMLElement {
  const wrap = node('div', 'display:flex;flex-direction:column;gap:6px;');
  const steps: StepRecord[] = lastRun
    ? lastRun.steps
    : STEP_TITLES.map((title, i): StepRecord => ({ title, status: 'pending', summary: STEP_HINTS[i] }));
  for (const group of STEP_GROUPS) {
    wrap.appendChild(sectionTitle(group.label));
    for (let i = group.from; i <= group.to; i++) wrap.appendChild(stepRow(i, steps[i]));
  }
  return wrap;
}

function tilesBlock(): HTMLElement {
  const grid = node('div', 'display:grid;grid-template-columns:1fr 1fr;gap:8px;');
  const candidates = lastRun?.candidates ?? [];
  const caught = candidates.reduce((n, c) => n + c.report.mutantCaught, 0);
  const variants = candidates.reduce((n, c) => n + c.report.mutantTotal, 0);
  const falseAlarms = candidates
    .filter(c => c.outcome === 'promoted' || c.outcome === 'active')
    .reduce((n, c) => n + c.report.falsePositiveCount, 0);
  const corpus = manifest?.corpusCount ?? 0;
  const tile = (value: string, label: string, color: string): HTMLElement => {
    const t = card('padding:9px 10px;');
    t.append(
      node('div', `font-size:18px;font-weight:700;color:${color};font-variant-numeric:tabular-nums;`, value),
      node('div', 'font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.45);margin-top:2px;', label),
    );
    return t;
  };
  grid.append(
    tile(String(activeRules(state).length), 'Active rules', ACCENT),
    tile(String(state.emeritus.length), 'Archived rules', '#c9a6ff'),
    tile(lastRun ? `${caught} / ${variants}` : '—', 'Broken variants caught', '#eaf4ff'),
    tile(lastRun ? `${falseAlarms} / ${corpus}` : '—', 'False alarms in playbook', lastRun && falseAlarms === 0 ? '#22cc88' : '#eaf4ff'),
  );
  return grid;
}

function verdictBlock(): HTMLElement {
  if (!lastRun || running) return node('div', 'display:none;');
  const run = lastRun;
  const promotedNow = run.candidates.filter(c => c.outcome === 'promoted').length;
  const archivedNow = run.candidates.filter(c => c.outcome === 'rejected').length;
  const playbookFalseAlarms = run.candidates
    .filter(c => c.outcome === 'promoted' || c.outcome === 'active')
    .reduce((n, c) => n + c.report.falsePositiveCount, 0);
  const blockedFalseAlarms = run.candidates
    .filter(c => c.outcome === 'rejected' || c.outcome === 'archived')
    .reduce((n, c) => n + c.report.falsePositiveCount, 0);
  const enforced = activeRules(run.playbook).length;
  const headline = promotedNow
    ? `${promotedNow} rule${promotedNow === 1 ? '' : 's'} now enforced in your editor`
    : enforced
      ? `${enforced} rule${enforced === 1 ? '' : 's'} enforced in your editor`
      : 'No rule qualified in this run';
  const lines = [
    run.seed.validatorValid && run.seed.finiteRatio < 0.5
      ? `Found a real failure: the validator accepts code whose SMA output is ${Math.round(run.seed.finiteRatio * 100)}% finite.`
      : 'Replayed the seed failure.',
    archivedNow ? `${archivedNow} rule archived with its counterexample.` : 'No rule was archived in this run.',
    `Rules in your playbook raise ${playbookFalseAlarms} false alarms on ${run.manifest.corpusCount} known-good scripts.`,
    ...(blockedFalseAlarms ? [`The gate blocked ${blockedFalseAlarms} false alarms from archived candidates.`] : []),
    `Trade assistant: ${run.assistant.certified} of ${run.assistant.grades.length} rules certified.`,
  ];
  const wrap = node('div', 'border-left:3px solid var(--dafe-glow, #2dffb3);background:rgba(45,255,179,0.06);border-radius:6px;padding:9px 11px;');
  wrap.append(node('div', 'font-size:12px;font-weight:700;color:#e8fff5;', headline));
  for (const line of lines) {
    wrap.appendChild(node('div', 'font-size:10.5px;line-height:1.5;color:rgba(255,255,255,0.65);margin-top:3px;', line));
  }
  return wrap;
}

function actionsBlock(): HTMLElement {
  const row = node('div', 'display:flex;gap:8px;flex-wrap:wrap;');
  const report = button('Download report', 'outline');
  report.title = lastRun ? 'Save a printable HTML report of the last run' : 'Runs OakGuard, then saves the report';
  report.disabled = running;
  report.onclick = () => { void downloadReport(); };
  const reset = button('Reset playbook', 'ghost');
  reset.disabled = running;
  reset.onclick = () => resetAll();
  row.append(report, reset);
  return row;
}

function candidateCard(rule: { name: string; description: string }, status: CandidateStatus | undefined, report: OakGuardRun['candidates'][number]['report'] | undefined): HTMLElement {
  const label = status === 'active' ? 'Active'
    : status === 'promoted' ? 'Promoted'
      : status === 'rejected' ? 'Archived'
        : status === 'archived' ? 'Archived earlier'
          : 'Not tested';
  const tone = status === 'active' || status === 'promoted' ? 'ok' : status ? 'warn' : 'muted';
  const c = card('display:flex;flex-direction:column;gap:4px;');
  const head = node('div', 'display:flex;justify-content:space-between;gap:8px;align-items:center;');
  head.append(node('div', 'font-size:11px;font-weight:600;color:#e8e2ff;', rule.name), pill(label, tone));
  c.append(head, node('div', 'font-size:10px;color:rgba(255,255,255,0.5);', rule.description));
  if (report) {
    c.append(node('div', 'font-size:10px;color:#ffd9a0;',
      `Broken variants ${report.mutantCaught}/${report.mutantTotal} · held-out ${report.heldOutCaught}/${report.heldOutTotal} · false alarms ${report.falsePositiveCount}/${report.goodTotal}`));
    if (report.reasons[0]) c.append(node('div', 'font-size:10px;color:rgba(255,255,255,0.45);', report.reasons[0]));
  }
  return c;
}

function checkOutput(result: CheckResult): HTMLElement {
  if (result.empty) return node('div', 'font-size:10.5px;color:rgba(255,255,255,0.45);margin-top:6px;', 'The editor is empty.');
  if (result.issues.length === 0) {
    return node('div', 'font-size:10.5px;color:#22cc88;margin-top:6px;', '✓ No issues. The script passes the validator and every active rule.');
  }
  const list = node('div', 'display:flex;flex-direction:column;gap:4px;margin-top:6px;');
  for (const issue of result.issues.slice(0, 8)) {
    list.appendChild(node('div', 'font-size:10.5px;line-height:1.45;color:#ffd9a0;',
      `Line ${issue.line} · [${issue.code}] ${issue.message}`));
  }
  if (result.issues.length > 8) list.appendChild(node('div', 'font-size:10px;color:rgba(255,255,255,0.4);', `…and ${result.issues.length - 8} more`));
  return list;
}

function detailsBlock(): HTMLElement {
  const wrap = node('div', 'border-top:1px solid rgba(180,140,255,0.1);padding-top:8px;display:flex;flex-direction:column;gap:8px;');
  const toggle = button(detailsOpen ? 'Hide details' : 'Show details', 'ghost');
  toggle.style.width = '100%';
  toggle.onclick = () => { detailsOpen = !detailsOpen; render(); };
  wrap.appendChild(toggle);
  if (!detailsOpen) return wrap;

  wrap.appendChild(sectionTitle('Candidate rules'));
  if (lastRun) {
    for (const c of lastRun.candidates) wrap.appendChild(candidateCard(c.rule, c.outcome, c.report));
  } else {
    for (const rule of CANDIDATE_CATALOGUE) wrap.appendChild(candidateCard(rule, undefined, undefined));
  }

  wrap.appendChild(sectionTitle(`Archive · ${state.emeritus.length}`));
  if (state.emeritus.length === 0) {
    wrap.appendChild(node('div', 'font-size:10.5px;color:rgba(255,255,255,0.45);', 'Nothing archived. Rejected rules are kept here with their counterexamples.'));
  }
  for (const rec of state.emeritus) {
    const c = card('display:flex;flex-direction:column;gap:3px;');
    c.append(node('div', 'font-size:11px;font-weight:600;color:#d7bdff;', rec.name));
    c.append(node('div', 'font-size:10px;color:rgba(255,255,255,0.5);', rec.reasons.join(' ')));
    if (rec.counterexample) c.append(node('div', 'font-size:10px;color:#ff9db1;', `Counterexample: ${rec.counterexample}`));
    wrap.appendChild(c);
  }

  wrap.appendChild(sectionTitle('Trade assistant rules'));
  for (const rule of ASSISTANT_RULES) {
    const status = state.assistantStatus?.[rule.id];
    const label = status === 'active' ? 'Certified' : status === 'needs_recert' ? 'In probation' : 'Not graded yet';
    const tone = status === 'active' ? 'ok' : status === 'needs_recert' ? 'warn' : 'muted';
    const c = card('display:flex;flex-direction:column;gap:4px;');
    const head = node('div', 'display:flex;justify-content:space-between;gap:8px;align-items:center;');
    head.append(node('div', 'font-size:11px;font-weight:600;color:#ffe2b0;', rule.name), pill(label, tone));
    c.append(head, node('div', 'font-size:10px;color:rgba(255,255,255,0.5);', rule.description));
    c.append(node('div', 'font-size:10px;color:rgba(255,255,255,0.4);', `Depends on ${rule.dependsOn.join(', ')}`));
    wrap.appendChild(c);
  }

  wrap.appendChild(sectionTitle('Check your editor script'));
  wrap.appendChild(node('div', 'font-size:10px;color:rgba(255,255,255,0.45);', 'Runs the validator and every active rule on the script in your editor.'));
  const check = button('Check editor script', 'outline');
  check.onclick = () => checkEditorScript();
  wrap.appendChild(check);
  if (checkResult) wrap.appendChild(checkOutput(checkResult));

  wrap.appendChild(sectionTitle('Evaluator log'));
  wrap.appendChild(node('pre', 'margin:0;max-height:220px;overflow:auto;white-space:pre-wrap;font:10.5px/1.5 ui-monospace,Menlo,Consolas,monospace;color:rgba(190,220,255,0.85);background:rgba(3,6,16,0.9);border:1px solid rgba(120,180,255,0.14);border-radius:8px;padding:8px;',
    lastRun ? lastRun.log.join('\n') : 'Run OakGuard to see the evaluator log.'));
  return wrap;
}

function collectScripts(): ScriptRef[] {
  return [...getIndicators(), ...getUserIndicators()].map(ind => ({ name: ind.name, source: ind.source }));
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

async function runNow(): Promise<OakGuardRun | null> {
  if (running) return null;
  running = true;
  checkResult = null;
  lastRun = null;
  render();
  try {
    const run = await runOakGuard({
      state,
      scripts: collectScripts(),
      onStep,
      pause: () => new Promise<void>(resolve => setTimeout(resolve, 300)),
    });
    lastRun = run;
    state = run.playbook;
    return run;
  } catch (err) {
    console.error('OakGuard run failed', err);
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
  const html = buildOakGuardReport(run, new Date());
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `OakGuard-report-${fileStamp(new Date())}.html`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function resetAll(): void {
  if (running) return;
  state = resetPlaybook();
  lastRun = null;
  checkResult = null;
  syncScene();
  observatory?.setStage(0);
  render();
}

function checkEditorScript(): void {
  const editor = document.getElementById('os-textarea') as HTMLTextAreaElement | null;
  const source = editor?.value ?? '';
  if (!source.trim()) {
    checkResult = { empty: true, issues: [] };
  } else {
    const baseline = validate(source).issues.map(i => ({ line: i.line, code: i.code, message: i.message }));
    const playbook = validateWithPlaybook(state, source).map(i => ({ line: i.line, code: i.code, message: i.message }));
    checkResult = { empty: false, issues: [...baseline, ...playbook] };
  }
  render();
}
