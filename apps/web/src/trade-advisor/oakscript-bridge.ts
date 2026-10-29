/**
 * OakScriptBridge — Connects the TradeAdvisorAgent to the OakScript editor,
 * indicator manager, and chart system. Handles agent-initiated code edits,
 * permission flows, auto-accept mode, and error forwarding.
 */
import type { TradeAdvisorAgent } from './agent';
import type { ChartSnapshot } from './visual-adapter';
import type { IndicatorInstance } from '../indicator-manager';

export interface AgentEditRequest {
  id: string;
  type: 'create' | 'edit' | 'fix';
  description: string;
  proposedCode: string;
  originalCode?: string;
  timestamp: number;
  accepted?: boolean;
}

export type PermissionMode = 'ask' | 'auto-accept';

export interface OakScriptBridgeConfig {
  editorTextarea: HTMLTextAreaElement;
  onRunScript: (source: string) => void;
  getSnapshot: () => ChartSnapshot | null;
  getActiveInstances: () => IndicatorInstance[];
  getEditorSource: () => string;
  setEditorSource: (source: string) => void;
  getErrors: () => string[];
}

let agent: TradeAdvisorAgent | null = null;
let config: OakScriptBridgeConfig | null = null;
let permissionMode: PermissionMode = 'ask';
let pendingEdits: AgentEditRequest[] = [];
let editCounter = 0;

// ─── UI elements ────────────────────────────────────────────────────
let permissionPanel: HTMLDivElement | null = null;
let autoAcceptToggle: HTMLInputElement | null = null;

export function getPermissionMode(): PermissionMode {
  return permissionMode;
}

export function setPermissionMode(mode: PermissionMode): void {
  permissionMode = mode;
  if (autoAcceptToggle) {
    autoAcceptToggle.checked = mode === 'auto-accept';
  }
}

/**
 * Initialize the bridge with an agent instance and editor configuration.
 */
export function initBridge(
  tradeAdvisor: TradeAdvisorAgent,
  bridgeConfig: OakScriptBridgeConfig,
): void {
  agent = tradeAdvisor;
  config = bridgeConfig;
}

/**
 * Extract OakScript code blocks from an agent response text.
 * Handles ```oakscript, ```js, and plain ``` code fences.
 */
export function extractCodeBlocks(text: string): string[] {
  const blocks: string[] = [];

  // Match closed fenced code blocks: ```oakscript ... ``` or ``` ... ```
  const fenceRegex = /```(?:oakscript|js|javascript)?\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = fenceRegex.exec(text)) !== null) {
    const code = match[1].trim();
    if (code.length > 10) blocks.push(code);
  }

  // Salvage a TRUNCATED block: the model ran out of tokens and never wrote the
  // closing ```. Take everything after the last opening fence. Without this, a
  // long indicator that gets cut off yields nothing and the edit panel never
  // appears (the "buttons do nothing" symptom).
  if (blocks.length === 0) {
    const open = text.match(/```(?:oakscript|js|javascript)?\s*\n([\s\S]*)$/);
    if (open && open[1].trim().length > 40) {
      blocks.push(open[1].trim());
    } else if (/\binput\s*\(|\bplot\w*\s*\(/.test(text)) {
      // No fence at all but the reply clearly contains code — take the whole thing.
      blocks.push(text.trim());
    }
  }

  return blocks;
}

/**
 * Clean agent code (strip trailing whitespace, normalize line endings).
 */
function normalizeCode(code: string): string {
  return code.replace(/\r\n/g, '\n').replace(/\t/g, '  ').trimEnd() + '\n';
}

type DiffOp = { type: 'ctx' | 'add' | 'del'; text: string };

/** LCS-based line diff between the original and proposed scripts. */
function computeLineDiff(original: string, proposed: string): DiffOp[] {
  const a = original.replace(/\r\n/g, '\n').split('\n');
  const b = proposed.replace(/\r\n/g, '\n').split('\n');
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffOp[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ type: 'ctx', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i++; }
    else { out.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < m) out.push({ type: 'del', text: a[i++] });
  while (j < n) out.push({ type: 'add', text: b[j++] });
  return out;
}

/** Build a colored inline diff panel: removed lines red/struck, added green. */
function buildDiffView(edit: AgentEditRequest): HTMLElement {
  const diff = computeLineDiff(edit.originalCode || '', edit.proposedCode);
  const adds = diff.filter(d => d.type === 'add').length;
  const dels = diff.filter(d => d.type === 'del').length;

  const wrap = document.createElement('div');
  const header = document.createElement('div');
  header.textContent = `Changes:  +${adds} added  −${dels} removed`;
  Object.assign(header.style, { fontSize: '10px', fontWeight: '700', padding: '4px 2px', color: 'rgba(255,255,255,0.6)' });
  wrap.appendChild(header);

  const pre = document.createElement('div');
  Object.assign(pre.style, {
    maxHeight: '280px', overflow: 'auto', margin: '4px 0 2px', padding: '8px',
    borderRadius: '6px', background: 'rgba(8,8,20,0.7)', border: '1px solid rgba(180,140,255,0.15)',
    fontSize: '11px', lineHeight: '1.5', fontFamily: 'ui-monospace, Menlo, monospace', whiteSpace: 'pre-wrap',
  });
  for (const d of diff) {
    const line = document.createElement('div');
    const prefix = d.type === 'add' ? '+ ' : d.type === 'del' ? '− ' : '  ';
    line.textContent = prefix + d.text;
    if (d.type === 'add') { line.style.color = '#22cc88'; line.style.background = 'rgba(34,204,136,0.12)'; }
    else if (d.type === 'del') { line.style.color = '#ff6b6b'; line.style.background = 'rgba(255,68,119,0.10)'; line.style.textDecoration = 'line-through'; line.style.opacity = '0.85'; }
    else { line.style.color = 'rgba(255,255,255,0.45)'; }
    pre.appendChild(line);
  }
  wrap.appendChild(pre);
  return wrap;
}

/**
 * Show the permission panel for an agent-proposed edit.
 * The panel appears inside the editor, showing a diff summary and
 * Accept/Reject buttons.
 */
function showPermissionPanel(edit: AgentEditRequest): void {
  if (!config) return;

  // Remove any existing panel
  if (permissionPanel) {
    permissionPanel.remove();
    permissionPanel = null;
  }

  permissionPanel = document.createElement('div');
  permissionPanel.id = 'os-agent-permission';
  Object.assign(permissionPanel.style, {
    padding: '8px 10px',
    borderTop: '1px solid rgba(34, 204, 136, 0.3)',
    borderBottom: '1px solid rgba(34, 204, 136, 0.3)',
    background: 'rgba(34, 204, 136, 0.05)',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    zIndex: '100',
    position: 'relative',
  });

  const label = document.createElement('div');
  label.textContent = `Agent ${edit.type === 'create' ? 'created' : edit.type === 'fix' ? 'fixed' : 'edited'} an indicator`;
  Object.assign(label.style, {
    color: '#22cc88',
    fontSize: '11px',
    fontWeight: '600',
  });

  const desc = document.createElement('div');
  desc.textContent = edit.description.length > 120
    ? edit.description.slice(0, 120) + '...'
    : edit.description;
  Object.assign(desc.style, {
    color: 'rgba(255,255,255,0.5)',
    fontSize: '10px',
  });

  const btnRow = document.createElement('div');
  Object.assign(btnRow.style, {
    display: 'flex',
    gap: '6px',
    flexWrap: 'wrap',
  });

  const viewBtn = document.createElement('button');
  viewBtn.textContent = '👁 View Diff';
  viewBtn.title = 'Show a colored diff of exactly what changed (red removed, green added)';
  Object.assign(viewBtn.style, {
    padding: '5px 12px',
    border: '1px solid rgba(180, 140, 255, 0.4)',
    borderRadius: '4px',
    background: 'rgba(180, 140, 255, 0.1)',
    color: 'rgba(255,255,255,0.8)',
    cursor: 'pointer',
    fontSize: '11px',
    fontWeight: '600',
  });
  // View Code toggles a colored inline diff (red = removed, green = added) so
  // you can see exactly what the agent changed before accepting.
  let diffEl: HTMLElement | null = null;
  viewBtn.onclick = () => {
    if (diffEl) {
      diffEl.remove();
      diffEl = null;
      viewBtn.textContent = '👁 View Diff';
      viewBtn.style.color = 'rgba(255,255,255,0.8)';
      return;
    }
    diffEl = buildDiffView(edit);
    permissionPanel?.appendChild(diffEl);
    viewBtn.textContent = '👁 Hide Diff';
    viewBtn.style.color = '#b48cff';
  };

  const testBtn = document.createElement('button');
  testBtn.textContent = '▶ Test Run';
  testBtn.title = 'Run this code to see the new visualization';
  Object.assign(testBtn.style, {
    padding: '5px 12px',
    border: '1px solid rgba(255, 184, 0, 0.5)',
    borderRadius: '4px',
    background: 'rgba(255, 184, 0, 0.15)',
    color: '#FFB800',
    cursor: 'pointer',
    fontSize: '11px',
    fontWeight: '700',
  });
  testBtn.onclick = () => {
    if (config) {
      config.setEditorSource(edit.proposedCode);
      config.onRunScript(edit.proposedCode);
      testBtn.textContent = '✓ Tested';
      testBtn.style.color = '#22cc88';
      testBtn.style.borderColor = 'rgba(34, 204, 136, 0.5)';
      testBtn.style.background = 'rgba(34, 204, 136, 0.15)';
      setTimeout(() => {
        testBtn.textContent = '▶ Test Run';
        testBtn.style.color = '#FFB800';
        testBtn.style.borderColor = 'rgba(255, 184, 0, 0.5)';
        testBtn.style.background = 'rgba(255, 184, 0, 0.15)';
      }, 2000);
    }
  };

  const acceptBtn = document.createElement('button');
  acceptBtn.textContent = '✓ Accept & Apply';
  Object.assign(acceptBtn.style, {
    padding: '5px 14px',
    border: '1px solid rgba(34, 204, 136, 0.5)',
    borderRadius: '4px',
    background: 'rgba(34, 204, 136, 0.18)',
    color: '#22cc88',
    cursor: 'pointer',
    fontSize: '11px',
    fontWeight: '700',
  });
  acceptBtn.onclick = () => acceptEdit(edit.id);

  const rejectBtn = document.createElement('button');
  rejectBtn.textContent = '✕ Decline';
  Object.assign(rejectBtn.style, {
    padding: '5px 12px',
    border: '1px solid rgba(255, 68, 119, 0.4)',
    borderRadius: '4px',
    background: 'rgba(255, 68, 119, 0.08)',
    color: '#ff4477',
    cursor: 'pointer',
    fontSize: '11px',
    fontWeight: '600',
  });
  rejectBtn.onclick = () => rejectEdit(edit.id);

  btnRow.appendChild(viewBtn);
  btnRow.appendChild(testBtn);
  btnRow.appendChild(acceptBtn);
  btnRow.appendChild(rejectBtn);
  permissionPanel.appendChild(label);
  permissionPanel.appendChild(desc);
  permissionPanel.appendChild(btnRow);

  // Insert at top of editor panel for visibility
  const editor = document.getElementById('oakscript-editor');
  if (editor) {
    const firstChild = editor.firstChild;
    if (firstChild) {
      firstChild.after(permissionPanel);
    } else {
      editor.appendChild(permissionPanel);
    }
  }
}

function showWarning(msg: string): void {
  if (!permissionPanel) return;
  const warn = document.createElement('div');
  warn.textContent = msg;
  Object.assign(warn.style, {
    padding: '4px 10px', color: '#FFB800', fontSize: '10px', fontWeight: '600',
    borderTop: '1px solid rgba(255, 184, 0, 0.2)',
  });
  permissionPanel.appendChild(warn);
  setTimeout(() => warn.remove(), 4000);
}

/**
 * Accept an agent edit — apply the code, run it, and clean up.
 */
export function acceptEdit(editId: string): void {
  const edit = pendingEdits.find(e => e.id === editId);
  if (!edit || !config) return;

  // Safety: refuse to accept obvious fragments. Accept any plot variant
  // (plot, plotshape, plot3d, plotarrow, plotchar) — a plot3d-only indicator
  // is valid. Test Run remains available for anything below this bar.
  const hasPlot = /\bplot\w*\s*\(/.test(edit.proposedCode);
  if (edit.proposedCode.length < 120 || !hasPlot) {
    showWarning('That looks like a fragment (no plot* call). Use ▶ Test Run to try it, or ask the agent to output the COMPLETE script.');
    return;
  }

  // Sanitize: strip non-ASCII garbage the model sometimes generates
  let clean = edit.proposedCode.replace(/[^\x20-\x7E\n\r\t]/g, '').trim();
  if (clean !== edit.proposedCode) {
    showWarning('Stripped invalid characters from agent code.');
  }

  edit.accepted = true;
  edit.proposedCode = clean;
  config.setEditorSource(clean);
  config.onRunScript(clean);

  if (permissionPanel) {
    permissionPanel.remove();
    permissionPanel = null;
  }

  // Show a brief success flash in the permission panel area
  const editor = document.getElementById('oakscript-editor');
  if (editor) {
    const flash = document.createElement('div');
    flash.textContent = '✓ Code accepted and applied';
    Object.assign(flash.style, {
      padding: '6px 10px',
      color: '#22cc88',
      fontSize: '10px',
      fontWeight: '600',
      textAlign: 'center',
      borderTop: '1px solid rgba(34, 204, 136, 0.2)',
    });
    const controls = editor.children[2];
    if (controls) controls.after(flash);
    setTimeout(() => flash.remove(), 2000);
  }

  pendingEdits = pendingEdits.filter(e => e.id !== editId);
}

/**
 * Reject an agent edit — discard it.
 */
export function rejectEdit(editId: string): void {
  const edit = pendingEdits.find(e => e.id === editId);

  // Restore the original code if available
  if (edit?.originalCode && config) {
    config.setEditorSource(edit.originalCode);
  }

  pendingEdits = pendingEdits.filter(e => e.id !== editId);

  if (permissionPanel) {
    permissionPanel.remove();
    permissionPanel = null;
  }
}

/**
 * Apply agent code to the editor, respecting permission mode.
 */
export function applyAgentCode(
  code: string,
  description: string,
  type: AgentEditRequest['type'],
  originalCode?: string,
): void {
  if (!config) return;

  const normalized = normalizeCode(code);
  const edit: AgentEditRequest = {
    id: `edit_${++editCounter}_${Date.now()}`,
    type,
    description,
    proposedCode: normalized,
    originalCode: originalCode || config.getEditorSource(),
    timestamp: Date.now(),
  };

  pendingEdits.push(edit);

  if (permissionMode === 'auto-accept') {
    acceptEdit(edit.id);
  } else {
    // Always show the code first, then ask
    config.setEditorSource(normalized);
    showPermissionPanel(edit);
  }
}

/**
 * Create the auto-accept toggle UI element.
 */
export function createAutoAcceptToggle(): HTMLDivElement {
  const row = document.createElement('div');
  Object.assign(row.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 10px',
    borderTop: '1px solid rgba(180, 140, 255, 0.08)',
  });

  const label = document.createElement('label');
  Object.assign(label.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    color: 'rgba(255,255,255,0.5)',
    fontSize: '10px',
    cursor: 'pointer',
  });

  autoAcceptToggle = document.createElement('input');
  autoAcceptToggle.type = 'checkbox';
  autoAcceptToggle.id = 'os-auto-accept';
  autoAcceptToggle.checked = permissionMode === 'auto-accept';
  Object.assign(autoAcceptToggle.style, {
    accentColor: '#22cc88',
  });
  autoAcceptToggle.onchange = () => {
    permissionMode = autoAcceptToggle!.checked ? 'auto-accept' : 'ask';
  };

  const textNode = document.createTextNode('Auto-accept agent edits');

  label.appendChild(autoAcceptToggle);
  label.appendChild(textNode);
  row.appendChild(label);

  return row;
}

// ─── Agent-triggered operations ─────────────────────────────────────

/**
 * Ask the agent to generate a new indicator from a natural-language description.
 * Simple single-pass version. For complex indicators, use agentGenerateIndicatorPhased.
 */
export async function agentGenerateIndicator(
  description: string,
  onUpdate?: (reply: string) => void,
): Promise<void> {
  if (!agent || !config) return;

  const snapshot = config.getSnapshot() || undefined;
  const resp = await agent.generateIndicator(description, snapshot);

  if (resp.ok) {
    const codeBlocks = extractCodeBlocks(resp.reply);
    if (codeBlocks.length > 0) {
      applyAgentCode(codeBlocks[0], description, 'create');
      onUpdate?.(resp.reply);
    } else {
      onUpdate?.(resp.reply);
    }
  } else {
    onUpdate?.(`Error: ${resp.reply}`);
  }
}

/**
 * Ask the agent to generate a new indicator using the phased workflow.
 * This breaks generation into Concept→Code→Validate phases to stay within
 * model context limits. Much more reliable for complex indicators.
 */
export async function agentGenerateIndicatorPhased(
  description: string,
  onPhase?: (phase: number, result: string) => void,
  onUpdate?: (reply: string) => void,
): Promise<void> {
  if (!agent || !config) return;

  const snapshot = config.getSnapshot() || undefined;

  try {
    const result = await agent.generateIndicatorPhased(description, snapshot, onPhase);

    if (result.finalCode) {
      // Run pre-flight validation AND request-coverage before applying.
      // "Validated" must mean both syntactically legal AND actually the
      // requested indicator (see request-coverage.ts).
      const { validate, formatValidationIssues } = await import('../oakscript/validator');
      const { checkRequestCoverage } = await import('./request-coverage');
      const prefer3D = (window as any).__osGetPrefer3D?.() ?? true;
      const coverageFn = (code: string) => checkRequestCoverage(description, code, { prefer3D });
      const validation = validate(result.finalCode);
      const coverageProblems = coverageFn(result.finalCode);
      if (!validation.valid || coverageProblems.length > 0) {
        onUpdate?.(`Phase 3: Auto-correcting ${validation.issues.length} validation issue(s), ${coverageProblems.length} coverage problem(s)...\n${formatValidationIssues(validation.issues)}${coverageProblems.length ? '\n' + coverageProblems.join('\n') : ''}`);

        // Iterate with the agent to fix — pass the original request so the
        // self-correction loop doesn't lose track of what the script was
        // supposed to do (see validateAndIterate's fixPrompt).
        const iterResult = await agent.validateAndIterate(result.finalCode, 3, snapshot, undefined, description, coverageFn);
        if (iterResult.valid) {
          applyAgentCode(iterResult.finalCode, description, 'create');
          onUpdate?.(`✓ Indicator generated and validated (${iterResult.iterations} iteration(s))`);
        } else {
          // Apply with a warning
          applyAgentCode(iterResult.finalCode, description + ' (may have issues)', 'create');
          onUpdate?.(`⚠ Indicator applied but may have remaining issues after ${iterResult.iterations} iteration(s). Review in editor.`);
        }
      } else {
        applyAgentCode(result.finalCode, description, 'create');
        onUpdate?.('✓ Indicator generated and validated');
      }
    } else {
      onUpdate?.('Error: Agent did not produce code');
    }
  } catch (err: any) {
    onUpdate?.(`Error: ${err.message}`);
  }
}

/**
 * Validate current editor code without running it. Shows issues in the
 * error panel if the editor has one, or returns them via callback.
 */
export async function validateCurrentCode(
  onUpdate?: (result: string) => void,
): Promise<{ valid: boolean; issues: string[] }> {
  if (!config) return { valid: true, issues: [] };

  const source = config.getEditorSource();
  if (!source.trim()) {
    onUpdate?.('No code in editor to validate.');
    return { valid: true, issues: [] };
  }

  try {
    const { validate, formatValidationIssues } = await import('../oakscript/validator');
    const result = validate(source);
    if (result.valid) {
      onUpdate?.('✓ Code passes validation. No issues found.');
    } else {
      onUpdate?.(`${result.issues.length} issue(s) found:\n${formatValidationIssues(result.issues)}`);
    }
    return { valid: result.valid, issues: result.issues.map(i => i.message) };
  } catch (err: any) {
    onUpdate?.(`Validation error: ${err.message}`);
    return { valid: false, issues: [err.message] };
  }
}

/**
 * Run the validate-and-iterate loop on current editor code.
 * Self-corrects with the agent until code is valid (max 3 iterations).
 */
export async function agentAutoFixIterative(
  onUpdate?: (reply: string) => void,
): Promise<{ valid: boolean; finalCode: string; iterations: number }> {
  if (!agent || !config) return { valid: false, finalCode: '', iterations: 0 };

  const source = config.getEditorSource();
  const snapshot = config.getSnapshot() || undefined;

  onUpdate?.('Starting auto-fix loop...');

  let lastIterationDetails = '';
  const result = await agent.validateAndIterate(source, 3, snapshot, (iter, issues, fixed) => {
    if (fixed) {
      lastIterationDetails = `Iteration ${iter}: Fixed ${issues.length} issue(s).`;
      onUpdate?.(lastIterationDetails);
    } else {
      lastIterationDetails = `Iteration ${iter}: Found ${issues.length} issue(s). Asking agent to fix...\n${issues.join('\n')}`;
      onUpdate?.(lastIterationDetails);
    }
  });

  if (result.valid && result.iterations === 1) {
    onUpdate?.('✓ Code was already valid. No fixes needed.');
  } else if (result.valid) {
    applyAgentCode(result.finalCode, `Auto-fixed after ${result.iterations} iteration(s)`, 'fix', source);
    onUpdate?.(`✓ Fixed after ${result.iterations} iteration(s). Code applied.`);
  } else {
    applyAgentCode(result.finalCode, `Partial fix after ${result.iterations} iteration(s)`, 'fix', source);
    onUpdate?.(`⚠ Partial fix after ${result.iterations} iteration(s). Manual review recommended.`);
  }

  return result;
}

/**
 * Ask the agent to edit the current indicator code.
 */
export async function agentEditIndicator(
  editDescription: string,
  onUpdate?: (reply: string) => void,
): Promise<void> {
  if (!agent || !config) return;

  const currentSource = config.getEditorSource();
  const snapshot = config.getSnapshot() || undefined;
  const resp = await agent.editIndicator(currentSource, editDescription, snapshot);

  if (resp.ok) {
    const codeBlocks = extractCodeBlocks(resp.reply);
    if (codeBlocks.length > 0) {
      applyAgentCode(codeBlocks[0], editDescription, 'edit', currentSource);
      onUpdate?.(resp.reply);
    } else {
      onUpdate?.(resp.reply);
    }
  } else {
    onUpdate?.(`Error: ${resp.reply}`);
  }
}

/**
 * Ask the agent to brainstorm indicator ideas based on current chart.
 */
export async function agentBrainstormIndicator(
  focus?: string,
  onUpdate?: (reply: string) => void,
): Promise<void> {
  if (!agent || !config) return;

  const snapshot = config.getSnapshot();
  if (!snapshot) {
    onUpdate?.('Error: No chart data available for brainstorming.');
    return;
  }

  const resp = await agent.brainstormIndicator(snapshot, focus);

  if (resp.ok) {
    onUpdate?.(resp.reply);
  } else {
    onUpdate?.(`Error: ${resp.reply}`);
  }
}

/**
 * Send current errors to the agent for diagnosis and auto-fix.
 */
export async function agentDiagnoseErrors(
  onUpdate?: (reply: string) => void,
): Promise<void> {
  if (!agent || !config) return;

  const currentSource = config.getEditorSource();
  const errors = config.getErrors();
  const snapshot = config.getSnapshot() || undefined;

  if (errors.length === 0) {
    onUpdate?.('No errors to diagnose. The indicator is running clean.');
    return;
  }

  const resp = await agent.diagnoseErrors(currentSource, errors, snapshot);

  if (resp.ok) {
    const codeBlocks = extractCodeBlocks(resp.reply);
    if (codeBlocks.length > 0) {
      applyAgentCode(
        codeBlocks[0],
        `Auto-fix ${errors.length} indicator error(s)`,
        'fix',
        currentSource,
      );
      onUpdate?.(resp.reply);
    } else {
      onUpdate?.(resp.reply);
    }
  } else {
    onUpdate?.(`Error: ${resp.reply}`);
  }
}

/**
 * Ask the agent to analyze current indicator metrics.
 */
export async function agentAnalyzeMetrics(
  onUpdate?: (reply: string) => void,
): Promise<void> {
  if (!agent || !config) return;

  const snapshot = config.getSnapshot();
  if (!snapshot) {
    onUpdate?.('Error: No chart data available for metrics analysis.');
    return;
  }

  const activeInstances = config.getActiveInstances();
  if (activeInstances.length === 0) {
    onUpdate?.('No active indicators to analyze. Load an indicator first.');
    return;
  }

  const firstInst = activeInstances[0];
  // Convert new indicator format to legacy values array
  const indicatorValues = snapshot.indicators
    .flatMap(ind => ind.values ? ind.values.split(', ').map(v => {
      const [name, val] = v.split('=');
      return { name: name || 'value', value: parseFloat(val) || 0, color: '#b48cff' };
    }) : [])
    .filter(v => !isNaN(v.value));
  const resp = await agent.analyzeMetrics(
    firstInst.name,
    indicatorValues,
    snapshot,
  );

  onUpdate?.(resp.ok ? resp.reply : `Error: ${resp.reply}`);
}
