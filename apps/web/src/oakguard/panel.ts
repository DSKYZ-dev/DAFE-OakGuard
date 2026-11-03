/**
 * OakGuard window — the Crucible as a floating window, like the rest of the app.
 *
 * One action runs the whole loop (pipeline.ts): live against Muse Wonder when
 * the backend has a Meta key, or as a replay that re-grades a recorded Muse
 * Wonder run with today's referee (judge mode, no backend). The 3D stage, the
 * proposal feed, the step list and the report all read the same run.
 */
import { OakGuardObservatory } from './observatory';
import {
  runOakGuard, STEP_GROUPS, STEP_HINTS, STEP_TITLES, defaultEscapes,
  type CandidateStatus, type OakGuardRun, type ProposerMode, type ScriptRef, type StepRecord, type StepStatus,
} from './pipeline';
import { backendTransport, replayTransport, DEFAULT_PROPOSER_MODEL, type RecordedRun, type RoundRecord } from './proposer';
import { buildOakGuardReport } from './report';
import { ASSISTANT_RULES } from './assistant';
import { activeRules, loadPlaybook, resetPlaybook, validateWithPlaybook } from './store';
import { corpusManifest } from './evaluator';
import { measureCurve } from './curve';
import { DEFECT_CLASS_LABELS, type EscapeCase } from './escapes';
import recorded from './recorded-run.json';
import { validate } from '../oakscript/validator';
import { getIndicators, getUserIndicators } from '../oakscript/indicators';
import { WINDOW_TOP_MIN, clearOfHeaderTop } from '../header-band';
import { minimizeWindow, restoreWindow, forgetWindow } from '../window-dock';
import type { PlaybookState } from './types';

const ACCENT = 'var(--dafe-glow, #2dffb3)';
const SUBTLE_BORDER = 'rgba(180,140,255,0.12)';
const RECORDED = recorded as unknown as RecordedRun;
const BACKEND = (): string => (window as any).__DAFE_BACKEND_URL || 'http://localhost:8788';

interface CheckIssue { line: number; code: string; message: string; }
interface CheckResult { empty: boolean; issues: CheckIssue[]; }

/** One row of the live proposal feed. */
interface FeedItem {
  escape: EscapeCase;
  round: RoundRecord;
  graded: boolean;
}

let win: HTMLDivElement | null = null;
let bodyEl: HTMLDivElement | null = null;
let side: HTMLDivElement | null = null;
let chips: HTMLDivElement | null = null;
let observatory: OakGuardObservatory | null = null;
let manifest: ReturnType<typeof corpusManifest> | null = null;
let state: PlaybookState = loadPlaybook();
let lastRun: OakGuardRun | null = null;
let running = false;
let runningMode: ProposerMode | null = null;
let detailsOpen = false;
let placed = false;
let checkResult: CheckResult | null = null;
let feed: FeedItem[] = [];
/** null = not probed yet; true when the backend answers and a Meta key is saved. */
let liveAvailable: boolean | null = null;

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

function pill(text: string, tone: 'ok' | 'warn' | 'muted' | 'live'): HTMLSpanElement {
  const color = tone === 'ok' ? '#22cc88' : tone === 'warn' ? '#FFB800' : tone === 'live' ? '#7fd6ff' : 'rgba(255,255,255,0.45)';
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
    @keyframes og-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
    #oakguard-window button:disabled { opacity: .4; cursor: default; }
    #oakguard-window button:not(:disabled):hover { filter: brightness(1.15); }
    #oakguard-window .og-feed-item { animation: og-in .35s ease-out; }
  `;
  document.head.appendChild(style);
}

function placeWindow(): void {
  if (!win || placed) return;
  placed = true;
  const width = Math.min(1100, window.innerWidth - 32);
  const height = Math.min(680, window.innerHeight - WINDOW_TOP_MIN - 40);
  Object.assign(win.style, {
    width: `${width}px`,
    height: `${Math.max(460, height)}px`,
    left: `${Math.max(12, Math.round((window.innerWidth - width) / 2))}px`,
    top: `${clearOfHeaderTop(WINDOW_TOP_MIN + 12)}px`,
  });
}

function buildWindow(): void {
  ensureStyles();
  manifest = corpusManifest();

  win = node('div', 'position:fixed;z-index:10000;display:none;flex-direction:column;background:rgba(8,8,20,0.95);border:1px solid rgba(180,140,255,0.15);border-radius:10px;backdrop-filter:blur(12px);box-shadow:0 8px 40px rgba(0,0,0,0.6);overflow:hidden;color:rgba(255,255,255,0.75);font-size:11px;');
  win.id = 'oakguard-window';
  win.className = 'dafe-glow-window';

  const header = node('div', 'display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid rgba(180,140,255,0.1);cursor:move;user-select:none;flex-shrink:0;');
  const titleWrap = node('div', 'display:flex;align-items:baseline;gap:10px;min-width:0;');
  titleWrap.append(
    node('span', `color:${ACCENT};font-size:12px;font-weight:600;white-space:nowrap;`, '⬢ OakGuard'),
    node('span', 'color:rgba(255,255,255,0.4);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;', 'Muse Wonder writes the rules · a referee it cannot see decides'),
    node('span', 'font-size:9px;font-weight:700;letter-spacing:0.08em;color:#0b0c1d;background:#ffd166;border-radius:4px;padding:1px 5px;', 'NEW'),
  );
  const controls = node('div', 'display:flex;gap:4px;flex-shrink:0;');
  const minBtn = node('button', 'background:none;border:1px solid rgba(255,255,255,0.1);color:#888;cursor:pointer;font-size:14px;padding:1px 7px;border-radius:4px;', '−');
  minBtn.title = 'Minimize';
  minBtn.onclick = () => { if (win) minimizeWindow('oakguard', 'OakGuard', win); };
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
  const viewport = node('div', 'position:relative;flex:1.2;min-width:0;background:#04040c;border-right:1px solid rgba(180,140,255,0.1);');
  const canvas = node('canvas', 'position:absolute;inset:0;width:100%;height:100%;display:block;');
  chips = node('div', 'position:absolute;top:10px;left:10px;right:10px;display:flex;gap:6px;flex-wrap:wrap;pointer-events:none;');
  const caption = node('div', 'position:absolute;left:12px;bottom:10px;font-size:10px;letter-spacing:0.08em;color:rgba(255,255,255,0.35);pointer-events:none;', 'DRAG TO ORBIT · SCROLL TO ZOOM');
  viewport.append(canvas, chips, caption);

  side = node('div', 'width:430px;flex-shrink:0;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:10px;');
  bodyEl.append(viewport, side);
  win.append(header, bodyEl);
  document.body.appendChild(win);

  observatory = new OakGuardObservatory(canvas);
  placeWindow();
  render();
}

async function probeLive(): Promise<void> {
  try {
    const r = await fetch(`${BACKEND()}/api/llm/providers`, { signal: AbortSignal.timeout(2500) });
    const d = await r.json();
    liveAvailable = !!d?.providers?.some((p: any) => p.id === 'meta' && p.configured);
  } catch {
    liveAvailable = false;
  }
  render();
}

export function openOakGuard(): void {
  if (!win) buildWindow();
  if (!win) return;
  state = loadPlaybook();
  restoreWindow('oakguard');
  win.style.display = 'flex';
  observatory?.resize();
  syncScene();
  render();
  if (liveAvailable === null) void probeLive();
}

export function closeOakGuard(): void {
  forgetWindow('oakguard');
  if (win) win.style.display = 'none';
}

export function disposeOakGuard(): void {
  forgetWindow('oakguard');
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
    chip(`PLAYBOOK v${state.version}`),
    chip(`${rules} ACTIVE RULE${rules === 1 ? '' : 'S'}`),
    chip(`CORPUS ${manifest.corpusCount} SCRIPTS`),
    chip(`FINGERPRINT ${manifest.manifestHash}`),
    ...(lastRun && lastRun.proposer.costUsd > 0 ? [chip(`META API $${lastRun.proposer.costUsd.toFixed(3)}`)] : []),
  );
}

function render(): void {
  renderChips();
  if (!side) return;
  const scroll = side.scrollTop;
  side.replaceChildren(
    introBlock(),
    runBlock(),
    feedBlock(),
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
    'When code passes the validator but breaks at runtime, Muse Wonder writes a rule that would have caught it: declarative data, never code. A referee the model cannot see tests the rule against broken variants, some held out, and known-good scripts. Only rules that pass every gate go live in your editor.');
}

function runBlock(): HTMLElement {
  const wrap = node('div', 'display:flex;flex-direction:column;gap:6px;');
  const row = node('div', 'display:flex;gap:6px;');
  const live = button(running && runningMode === 'live' ? 'Muse Wonder is working…' : '▶ Run live · Muse Wonder', 'primary');
  live.style.flex = '1.3';
  live.style.padding = '9px 10px';
  live.style.fontSize = '12px';
  live.disabled = running || liveAvailable !== true;
  live.title = liveAvailable === true
    ? `Calls ${DEFAULT_PROPOSER_MODEL} on the Meta Model API through your backend.`
    : 'Live mode needs the local backend with a Meta Model API key. Replay works anywhere.';
  live.onclick = () => { void runNow('live'); };
  const replay = button(running && runningMode === 'replay' ? 'Replaying…' : '↻ Replay recorded run', 'outline');
  replay.style.flex = '1';
  replay.disabled = running;
  replay.title = `Re-grades the text ${RECORDED.model} wrote on ${new Date(RECORDED.recordedAt).toLocaleString()} with today's referee.`;
  replay.onclick = () => { void runNow('replay'); };
  row.append(live, replay);
  const note = liveAvailable === false
    ? 'No backend or Meta key here, so live mode is off. The replay re-grades a recorded Muse Wonder run; verdicts are recomputed, never replayed.'
    : running ? 'Working through all 8 steps…' : 'Reset the playbook first to watch rules being learned from v1.';
  wrap.append(row, node('div', 'font-size:10px;color:rgba(255,255,255,0.4);text-align:center;line-height:1.4;', note));
  return wrap;
}

function specText(r: RoundRecord): string {
  if (!r.rule) return '';
  const p: Record<string, unknown> = { family: r.rule.family, issueCode: r.rule.issueCode };
  const params = r.rule.params ?? {};
  for (const [k, v] of Object.entries(params)) if (v !== undefined) p[k] = v;
  if (r.rule.allowObjectMethods) p.allowObjectMethods = true;
  return JSON.stringify(p, null, 1).replace(/\n\s*/g, ' ');
}

function feedBlock(): HTMLElement {
  const wrap = node('div', 'display:flex;flex-direction:column;gap:6px;');
  if (feed.length === 0 && !lastRun) return node('div', 'display:none;');
  wrap.appendChild(sectionTitle(`Proposals · ${lastRun?.proposer.model ?? DEFAULT_PROPOSER_MODEL}`));
  if (feed.length === 0) {
    wrap.appendChild(node('div', 'font-size:10.5px;color:rgba(255,255,255,0.45);', lastRun?.escapes.every(e => e.alreadyCaughtBy.length)
      ? 'Every escape is already caught by the playbook, so nothing was proposed. Reset the playbook to learn again.'
      : 'Waiting for the first proposal…'));
    return wrap;
  }
  for (const item of feed) {
    const r = item.round;
    const c = card('display:flex;flex-direction:column;gap:4px;');
    c.className = 'og-feed-item';
    const head = node('div', 'display:flex;justify-content:space-between;gap:8px;align-items:center;');
    head.append(
      node('div', 'font-size:10.5px;font-weight:600;color:#e8e2ff;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
        `${DEFECT_CLASS_LABELS[item.escape.defectClass]} · round ${r.round}`),
      !item.graded ? pill('Testing…', 'live')
        : r.error ? pill('Unusable', 'warn')
          : r.report?.verdict === 'promoted' ? pill('Promoted', 'ok') : pill('Rejected', 'warn'),
    );
    c.appendChild(head);
    if (r.rule) {
      c.appendChild(node('div', 'font:10px/1.45 ui-monospace,Menlo,Consolas,monospace;color:rgba(190,220,255,0.88);word-break:break-word;', specText(r)));
      if (r.rule.fixHint) c.appendChild(node('div', 'font-size:10px;color:rgba(255,255,255,0.5);', `Fix hint: ${r.rule.fixHint}`));
    }
    if (r.error) c.appendChild(node('div', 'font-size:10px;color:#ffd9a0;', r.error));
    if (item.graded && r.report) {
      const rep = r.report;
      c.appendChild(node('div', 'font-size:10px;color:#ffd9a0;',
        `Variants ${rep.mutantCaught}/${rep.mutantTotal} · held-out ${rep.heldOutCaught}/${rep.heldOutTotal} · false alarms ${rep.falsePositiveCount}/${rep.goodTotal}`));
      if (rep.verdict === 'rejected') c.appendChild(node('div', 'font-size:10px;color:#ff9db1;', rep.reasons[0] ?? ''));
    }
    if (r.meta) {
      const src = r.meta.source === 'live' ? 'live' : `recorded ${r.meta.recordedAt ? new Date(r.meta.recordedAt).toLocaleDateString() : ''}`;
      c.appendChild(node('div', 'font-size:9.5px;color:rgba(255,255,255,0.35);',
        `${r.meta.model} · ${src} · ${(r.meta.latencyMs / 1000).toFixed(1)} s · ${r.meta.inputTokens + r.meta.outputTokens} tokens · $${r.meta.costUsd.toFixed(4)}`));
    }
    wrap.appendChild(c);
  }
  return wrap;
}

function stepRow(index: number, step: StepRecord): HTMLElement {
  const tone = step.status === 'done' ? '#22cc88'
    : step.status === 'failed' ? '#ff4477'
      : step.status === 'running' ? '#2dffb3'
        : 'rgba(255,255,255,0.3)';
  const live = step.status === 'running';
  const row = node('div', `display:grid;grid-template-columns:24px 1fr 18px;gap:10px;align-items:start;padding:7px 10px;border-radius:8px;border:1px solid ${live ? 'rgba(45,255,179,0.45)' : SUBTLE_BORDER};background:${live ? 'rgba(45,255,179,0.06)' : 'rgba(255,255,255,0.02)'};`);
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
  const grid = node('div', 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;');
  const candidates = lastRun?.candidates ?? [];
  const caught = candidates.reduce((n, c) => n + c.report.mutantCaught, 0);
  const variants = candidates.reduce((n, c) => n + c.report.mutantTotal, 0);
  const held = candidates.reduce((n, c) => n + c.report.heldOutTotal, 0);
  const heldCaught = candidates.reduce((n, c) => n + c.report.heldOutCaught, 0);
  const falseAlarms = candidates
    .filter(c => c.outcome === 'promoted' || c.outcome === 'active')
    .reduce((n, c) => n + c.report.falsePositiveCount, 0);
  const corpus = manifest?.corpusCount ?? 0;
  const curve = lastRun?.curve ?? measureCurve(state);
  const tile = (value: string, label: string, color: string): HTMLElement => {
    const t = card('padding:8px 9px;');
    t.append(
      node('div', `font-size:16px;font-weight:700;color:${color};font-variant-numeric:tabular-nums;`, value),
      node('div', 'font-size:9px;letter-spacing:0.07em;text-transform:uppercase;color:rgba(255,255,255,0.45);margin-top:2px;', label),
    );
    return t;
  };
  grid.append(
    tile(String(activeRules(state).length), 'Active rules', ACCENT),
    tile(String(state.emeritus.length), 'Archived rules', '#c9a6ff'),
    tile(lastRun ? `${caught} / ${variants}` : '—', 'Variants caught', '#eaf4ff'),
    tile(lastRun ? `${heldCaught} / ${held}` : '—', 'Held-out caught', '#eaf4ff'),
    tile(lastRun ? `${falseAlarms} / ${corpus}` : '—', 'False alarms', lastRun && falseAlarms === 0 ? '#22cc88' : '#eaf4ff'),
    tile(lastRun ? `$${lastRun.proposer.costUsd.toFixed(3)}` : '—', 'Meta API cost', '#ffd166'),
  );
  const wrap = node('div', 'display:flex;flex-direction:column;gap:6px;');
  wrap.appendChild(grid);
  if (curve) {
    wrap.appendChild(node('div', 'font-size:10px;line-height:1.45;color:rgba(255,255,255,0.5);',
      `Unseen ${curve.draftModel} drafts: ${curve.validatorClean} of ${curve.drafts} pass the validator, ${curve.escapes} carry a runtime defect, ${curve.falseFlagsNow} false alarm(s) from the playbook. First-draft validity ${curve.firstDraftValidity.validatorClean}/${curve.firstDraftValidity.drafts}.`));
  }
  return wrap;
}

function verdictBlock(): HTMLElement {
  if (!lastRun || running) return node('div', 'display:none;');
  const run = lastRun;
  const promotedNow = run.candidates.filter(c => c.outcome === 'promoted').length;
  const archivedNow = run.candidates.filter(c => c.outcome === 'rejected').length;
  const caughtAfter = run.escapes.filter(e => e.caughtAfter.length > 0).length;
  const enforced = activeRules(run.playbook).length;
  const headline = promotedNow
    ? `${promotedNow} rule${promotedNow === 1 ? '' : 's'} written by ${run.proposer.model} now enforced in your editor`
    : enforced
      ? `${enforced} rule${enforced === 1 ? '' : 's'} enforced in your editor`
      : 'No rule qualified in this run';
  const p = run.proposer;
  const lines = [
    `${caughtAfter} of ${run.escapes.length} escapes are now flagged before they run.`,
    archivedNow ? `${archivedNow} rule(s) rejected and archived with counterexamples.` : 'No rule was rejected in this run.',
    p.calls > 0 ? `${p.calls} Meta API call(s) · ${p.inputTokens + p.outputTokens} tokens · $${p.costUsd.toFixed(4)} · ${(p.latencyMs / 1000).toFixed(0)} s of model time${p.mode === 'replay' ? ' (recorded)' : ''}.` : '',
    `Dependent advice: ${run.assistant.certified} of ${run.assistant.grades.length} rules re-certified.`,
  ].filter(Boolean);
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
  report.title = lastRun ? 'Save a printable HTML report of the last run' : 'Replays the recorded run, then saves the report';
  report.disabled = running;
  report.onclick = () => { void downloadReport(); };
  const reset = button('Reset playbook', 'ghost');
  reset.disabled = running;
  reset.onclick = () => resetAll();
  row.append(report, reset);
  return row;
}

function candidateCard(c: OakGuardRun['candidates'][number]): HTMLElement {
  const status: CandidateStatus = c.outcome;
  const label = status === 'active' ? 'Active'
    : status === 'promoted' ? 'Promoted'
      : status === 'rejected' ? 'Archived'
        : 'Archived earlier';
  const tone = status === 'active' || status === 'promoted' ? 'ok' : 'warn';
  const el = card('display:flex;flex-direction:column;gap:4px;');
  const head = node('div', 'display:flex;justify-content:space-between;gap:8px;align-items:center;');
  head.append(node('div', 'font-size:11px;font-weight:600;color:#e8e2ff;', c.rule.name), pill(label, tone));
  el.append(head, node('div', 'font-size:10px;color:rgba(255,255,255,0.5);', c.rule.description));
  el.append(node('div', 'font-size:10px;color:rgba(255,255,255,0.4);', `${c.rule.issueCode} · ${c.rule.family} · by ${c.rule.proposal?.model ?? c.rule.proposedBy}`));
  if (c.rule.rationale) el.append(node('div', 'font-size:10px;color:rgba(255,255,255,0.45);', `Rationale: ${c.rule.rationale}`));
  el.append(node('div', 'font-size:10px;color:#ffd9a0;',
    `Variants ${c.report.mutantCaught}/${c.report.mutantTotal} · held-out ${c.report.heldOutCaught}/${c.report.heldOutTotal} · false alarms ${c.report.falsePositiveCount}/${c.report.goodTotal}`));
  if (c.report.reasons[0]) el.append(node('div', 'font-size:10px;color:rgba(255,255,255,0.45);', c.report.reasons[0]));
  return el;
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

  wrap.appendChild(sectionTitle('Escapes'));
  const escapes = lastRun?.escapes.map(e => ({ escape: e.escape, evidence: e.evidence, caught: e.caughtAfter }))
    ?? defaultEscapes().map(escape => ({ escape, evidence: '', caught: [] as string[] }));
  for (const e of escapes) {
    const c = card('display:flex;flex-direction:column;gap:4px;');
    c.append(node('div', 'font-size:11px;font-weight:600;color:#e8e2ff;', e.escape.title));
    c.append(node('div', 'font-size:10px;color:rgba(255,255,255,0.45);',
      e.escape.origin === 'model-draft' ? `${e.escape.model} draft for "${e.escape.request}"` : 'Seed reproduction of the bug class'));
    if (e.evidence) c.append(node('div', 'font-size:10px;color:#ff9db1;', `Runtime: ${e.evidence}`));
    if (e.caught.length) c.append(node('div', 'font-size:10px;color:#22cc88;', `Now flagged before running by ${e.caught.join(', ')}`));
    c.append(node('pre', 'margin:0;max-height:120px;overflow:auto;white-space:pre;font:10px/1.4 ui-monospace,Menlo,Consolas,monospace;color:rgba(190,220,255,0.8);background:rgba(3,6,16,0.9);border-radius:6px;padding:6px;', e.escape.source));
    wrap.appendChild(c);
  }

  wrap.appendChild(sectionTitle('Candidate rules'));
  if (lastRun?.candidates.length) {
    for (const c of lastRun.candidates) wrap.appendChild(candidateCard(c));
  } else {
    wrap.appendChild(node('div', 'font-size:10.5px;color:rgba(255,255,255,0.45);', 'Run OakGuard to see the proposed rules and their scores.'));
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

  wrap.appendChild(sectionTitle('Dependent advice rules'));
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
      if (index === 0 && run.escapes.length) observatory.pulseEscape();
      if (index === 4) {
        observatory.setPlaybook(activeRules(run.playbook).map(r => r.issueCode));
        observatory.setStage(4);
      }
    }
  }
  state = run.playbook;
  render();
}

function onRound(escape: EscapeCase, round: RoundRecord, phase: 'proposed' | 'graded', run: OakGuardRun): void {
  lastRun = run;
  const existing = feed.find(f => f.escape.id === escape.id && f.round.round === round.round);
  if (existing) {
    existing.round = round;
    existing.graded = phase === 'graded';
  } else {
    feed.push({ escape, round, graded: phase === 'graded' });
  }
  if (observatory) {
    if (phase === 'proposed') {
      observatory.setStage(1);
    } else if (round.report) {
      observatory.launchSwarm(round.report.mutantTotal, round.report.mutantCaught);
      if (round.report.verdict === 'rejected') {
        observatory.rejectToEmeritus(round.rule?.name ?? 'rule');
        observatory.setStage(3);
      }
    }
  }
  render();
}

async function runNow(mode: 'live' | 'replay'): Promise<OakGuardRun | null> {
  if (running) return null;
  running = true;
  runningMode = mode;
  checkResult = null;
  lastRun = null;
  feed = [];
  render();
  try {
    const run = await runOakGuard({
      state,
      scripts: collectScripts(),
      mode,
      transport: mode === 'live' ? backendTransport(BACKEND()) : replayTransport(RECORDED),
      model: mode === 'live' ? DEFAULT_PROPOSER_MODEL : RECORDED.model,
      recordedAt: mode === 'replay' ? RECORDED.recordedAt : undefined,
      onStep,
      onRound,
      pause: () => new Promise<void>(resolve => setTimeout(resolve, mode === 'replay' ? 650 : 250)),
    });
    lastRun = run;
    state = run.playbook;
    return run;
  } catch (err) {
    console.error('OakGuard run failed', err);
    return null;
  } finally {
    running = false;
    runningMode = null;
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
  const run = lastRun && lastRun.steps.every(s => s.status === 'done') ? lastRun : await runNow('replay');
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
  feed = [];
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
