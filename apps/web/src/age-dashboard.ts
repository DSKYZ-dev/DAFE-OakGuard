/**
 * AGE Dashboard — Information-rich status panel for Adaptive Genesis Engine
 * Renders a draggable HTML overlay with population stats, signals, and RCM data.
 */
import type { Strategy } from '@dafe/core';
import { getThemeFromId, type AGETheme } from './age-3d-visuals';

export interface DashboardData {
  // Population
  activeCount: number;
  maxPopulation: number;
  validatedCount: number;
  generation: number;
  MAS: number;
  totalSpawned: number;
  totalCulled: number;
  totalTrades: number;
  totalWins: number;
  winRate: number;
  totalPnl: number;
  bestFitness: number;

  // Selected strategy
  selectedId: number;
  selectedGen: number;
  selectedTrades: number;
  selectedWins: number;
  selectedPnl: number;
  selectedValidated: boolean;
  selectedFitness: number;
  selectedWinRate: number;

  // Signal
  position: number;
  probability: number;
  confluence: number;
  signalAge: number;
  signalFormingAge: number;
  signalFormingProb: number;

  // RCM & Structure
  rcmState: string;
  rcmIntegrity: number;
  rcmDamage: string;
  insideVA: boolean;
  relativeToVA: string;
  nearestPoc: number;
  nearestLevel: number;

  // Flow
  regimeType: number;
  dvsRatio: number;
  unifiedAgg: number;
  spreadProxy: number;

  // Narrative
  narrative: string;

  // Diagnostics
  diagEvaluated: number;
  diagPassed: number;
  diagRejProb: number;
  diagRejConf: number;
  diagRejTrend: number;
  diagRejRegime: number;
  diagRejVol: number;
}

export class AGEDashboard {
  private container: HTMLDivElement;
  private table: HTMLTableElement;
  private theme: AGETheme;
  private visible = true;
  private dragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private posX = 0;
  private posY = 0;

  constructor(themeId: string = 'DAFE Signature') {
    this.theme = getThemeFromId(themeId);
    this.container = this.createContainer();
    this.table = this.createTable();
    this.container.appendChild(this.table);
    document.body.appendChild(this.container);
    this.setupDrag();
    this.setupResize();
  }

  private createContainer(): HTMLDivElement {
    const c = document.createElement('div');
    c.id = 'age-dashboard';
    Object.assign(c.style, {
      position: 'fixed',
      top: '60px',
      right: '10px',
      width: '280px',
      maxHeight: '80vh',
      overflowY: 'auto',
      zIndex: '100',
      background: '#0A0E27',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: '8px',
      padding: '8px',
      fontFamily: 'monospace',
      fontSize: '10px',
      color: '#E0F8F7',
      boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
      userSelect: 'none',
      display: 'none',
    });

    // Header bar
    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '4px 6px',
      marginBottom: '6px',
      borderBottom: '1px solid rgba(255,255,255,0.08)',
      cursor: 'move',
    });
    header.innerHTML = `<span style="color:#00FF9F;font-size:12px;font-weight:bold;">✦ AGE Engine — [DAFE]</span>`;

    const closeBtn = document.createElement('button');
    Object.assign(closeBtn.style, {
      background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '14px', padding: '0 4px',
    });
    closeBtn.textContent = '✕';
    closeBtn.onclick = () => this.toggle();
    header.appendChild(closeBtn);
    c.appendChild(header);

    return c;
  }

  private createTable(): HTMLTableElement {
    const t = document.createElement('table');
    Object.assign(t.style, {
      width: '100%',
      borderCollapse: 'collapse',
      fontSize: '10px',
    });
    return t;
  }

  private setupDrag(): void {
    const header = this.container.querySelector('div') as HTMLDivElement;
    if (!header) return;
    header.addEventListener('mousedown', (e) => {
      this.dragging = true;
      this.dragStartX = e.clientX - this.posX;
      this.dragStartY = e.clientY - this.posY;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.dragging) return;
      this.posX = e.clientX - this.dragStartX;
      this.posY = e.clientY - this.dragStartY;
      this.container.style.right = 'auto';
      this.container.style.top = `${this.posY}px`;
      this.container.style.left = `${this.posX}px`;
    });
    document.addEventListener('mouseup', () => { this.dragging = false; });
  }

  private setupResize(): void {
    const handle = document.createElement('div');
    Object.assign(handle.style, {
      position: 'absolute', bottom: '0', left: '0', width: '100%', height: '6px',
      cursor: 'ns-resize', background: 'transparent',
    });
    handle.addEventListener('mousedown', (e) => {
      const startY = e.clientY;
      const startH = this.container.clientHeight;
      const onMove = (ev: MouseEvent) => {
        this.container.style.maxHeight = `${Math.max(200, startH + ev.clientY - startY)}px`;
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    this.container.appendChild(handle);
  }

  update(data: DashboardData): void {
    if (!this.visible) return;
    this.container.style.display = 'block';

    const t = this.table;
    t.innerHTML = '';

    const sep = (txt: string) => {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4;
      td.style.cssText = `color:rgba(255,255,255,0.3);background:rgba(255,255,255,0.05);padding:2px 4px;font-size:9px;text-align:center;border-radius:3px;`;
      td.textContent = `─── ${txt} ───`;
      tr.appendChild(td);
      t.appendChild(tr);
    };

    const row = (label: string, value: string, label2?: string, value2?: string) => {
      const tr = document.createElement('tr');
      const c1 = document.createElement('td');
      c1.textContent = label;
      c1.style.cssText = 'color:#8B9DC3;padding:1px 4px;';
      const c2 = document.createElement('td');
      c2.textContent = value;
      c2.style.cssText = 'color:#E0F8F7;font-weight:bold;padding:1px 4px;';
      tr.appendChild(c1); tr.appendChild(c2);

      if (label2) {
        const c3 = document.createElement('td');
        c3.textContent = label2;
        c3.style.cssText = 'color:#8B9DC3;padding:1px 4px;';
        const c4 = document.createElement('td');
        c4.textContent = value2 || '';
        c4.style.cssText = 'color:#E0F8F7;font-weight:bold;padding:1px 4px;';
        tr.appendChild(c3); tr.appendChild(c4);
      }
      t.appendChild(tr);
    };

    const coloredRow = (label: string, value: string, color: string) => {
      const tr = document.createElement('tr');
      const c1 = document.createElement('td');
      c1.textContent = label;
      c1.style.cssText = 'color:#8B9DC3;padding:1px 4px;';
      const c2 = document.createElement('td');
      c2.textContent = value;
      c2.style.cssText = `color:${color};font-weight:bold;padding:1px 4px;`;
      c2.colSpan = 3;
      tr.appendChild(c1); tr.appendChild(c2);
      t.appendChild(tr);
    };

    // Population
    sep('🧬 POPULATION & PERFORMANCE');
    row('Active / Max', `${data.activeCount}/${data.maxPopulation}`, 'Validated', `${data.validatedCount}/${data.activeCount}`);
    row('Generation', `${data.generation}`, 'MAS', data.MAS.toFixed(3));
    row('Spawned', `${data.totalSpawned}`, 'Culled', `${data.totalCulled}`);
    row('Total Trades', `${data.totalTrades}`, 'Win Rate', `${data.winRate.toFixed(1)}%`);
    row('Total P&L', `${data.totalPnl.toFixed(1)}R`, 'Best Fitness', data.bestFitness.toFixed(3));

    // Active Strategy
    if (data.selectedId >= 0) {
      sep(`📡 STRATEGY #${data.selectedId}`);
      row('Validation', data.selectedValidated ? '✓ VALIDATED' : '○ TRAINING');
      row('Fitness', data.selectedFitness.toFixed(3), 'Win Rate', `${data.selectedWinRate.toFixed(1)}%`);
      row('Trades', `${data.selectedTrades}`, 'P&L', `${data.selectedPnl.toFixed(1)}R`);
    } else {
      sep('📡 STRATEGY');
      coloredRow('', 'No active strategy', '#FF006E');
    }

    // Current Signal
    sep('🎯 CURRENT SIGNAL');
    const sigStatus = data.position === 1 ? '▲ LONG' : data.position === -1 ? '▼ SHORT' : data.signalFormingAge > 0 ? '⏳ FORMING' : '○ WAITING';
    const sigColor = data.position === 1 ? '#00FF9F' : data.position === -1 ? '#FF006E' : data.signalFormingAge > 0 ? '#FFB800' : '#8B9DC3';
    const confStars = this.stars(data.probability);
    row('Status', sigStatus, 'Confidence', `${(data.probability * 100).toFixed(1)}% ${confStars}`);
    row('Confluence', `${data.confluence}/3`, 'Age', data.signalFormingAge > 0 ? `${data.signalFormingAge} bars` : data.position !== 0 ? 'IN TRADE' : '---');

    // RCM & Structure
    sep('🧠 RCM & STRUCTURE');
    const rcmColor = data.rcmState === 'BULLISH' ? '#00FF9F' : data.rcmState === 'BEARISH' ? '#FF006E' : '#FFB800';
    row('RCM State', data.rcmState, 'Integrity', `${Math.round(data.rcmIntegrity * 100)}%`);
    row('Damage', data.rcmDamage, 'VA Zone', data.relativeToVA);
    row('Nearest PoC', data.nearestPoc > 0 ? data.nearestPoc.toFixed(2) : 'n/a', 'Level', data.nearestLevel > 0 ? data.nearestLevel.toFixed(2) : 'n/a');

    // Flow Engine
    sep('🔬 FLOW ENGINE');
    const regimeLabel = data.regimeType === 1 ? 'TRENDING' : data.regimeType === 2 ? 'VOLATILE' : 'BALANCED';
    row('Market Regime', regimeLabel, 'DVS Ratio', data.dvsRatio.toFixed(2));
    row('Aggressor', `${(data.unifiedAgg * 100).toFixed(0)}% Buy`, 'Spread', data.spreadProxy.toFixed(2));

    // Narrative
    sep('NARRATIVE');
    coloredRow('', data.narrative, '#E0F8F7');

    // Diagnostics (collapsible)
    if (data.diagEvaluated > 0) {
      sep('🔍 DIAGNOSTICS');
      const passRate = data.diagEvaluated > 0 ? (data.diagPassed / data.diagEvaluated * 100).toFixed(1) : '0';
      row('Evaluated', `${data.diagEvaluated}`, '✓ Passed', `${data.diagPassed} (${passRate}%)`);
      row('⨯ Prob', `${data.diagRejProb}`, '⨯ Conf', `${data.diagRejConf}`);
      row('⨯ Trend', `${data.diagRejTrend}`, '⨯ Regime', `${data.diagRejRegime}`);
      row('⨯ Volume', `${data.diagRejVol}`, '', '');
    }
  }

  private stars(prob: number): string {
    if (prob >= 0.85) return '★★★★★';
    if (prob >= 0.75) return '★★★★';
    if (prob >= 0.65) return '★★★';
    if (prob >= 0.55) return '★★';
    return '★';
  }

  toggle(): void {
    this.visible = !this.visible;
    this.container.style.display = this.visible ? 'block' : 'none';
  }

  isVisible(): boolean { return this.visible; }

  setTheme(themeId: string): void {
    this.theme = getThemeFromId(themeId);
  }

  destroy(): void {
    this.container.remove();
  }
}

export function buildDashboardData(
  engine: any,
  strategies: Strategy[],
  selectedIdx: number,
  signal: any,
  regimeType: number,
  dvsRatio: number,
  insideVA: boolean,
  relativeToVA: string,
  nearestPoc: number,
  nearestLevel: number,
  unifiedAgg: number,
  spreadProxy: number,
  narrative: string,
): DashboardData {
  const active = strategies.filter((s: Strategy) => s.active);
  const validated = active.filter((s: Strategy) => s.wfoValidated);

  let totTrades = 0, totWins = 0, totPnl = 0, bestFit = 0;
  for (const s of active) {
    totTrades += s.trades;
    totWins += s.wins;
    totPnl += s.pnl;
    bestFit = Math.max(bestFit, s.fitness);
  }
  const aggWR = totTrades > 0 ? (totWins / totTrades) * 100 : 0;

  const sel = selectedIdx >= 0 ? strategies[selectedIdx] : null;
  const sWR = sel && sel.trades > 0 ? (sel.wins / sel.trades) * 100 : 0;

  return {
    activeCount: active.length,
    maxPopulation: 8,
    validatedCount: validated.length,
    generation: engine.getCurrentGeneration?.() ?? 0,
    MAS: engine.getMAS?.() ?? 0,
    totalSpawned: engine.getTotalSpawned?.() ?? 0,
    totalCulled: engine.getTotalCulled?.() ?? 0,
    totalTrades: totTrades,
    totalWins: totWins,
    winRate: aggWR,
    totalPnl: totPnl,
    bestFitness: bestFit,

    selectedId: sel?.id ?? -1,
    selectedGen: sel?.generation ?? 0,
    selectedTrades: sel?.trades ?? 0,
    selectedWins: sel?.wins ?? 0,
    selectedPnl: sel?.pnl ?? 0,
    selectedValidated: sel?.wfoValidated ?? false,
    selectedFitness: sel?.fitness ?? 0,
    selectedWinRate: sWR,

    position: signal?.position ?? 0,
    probability: signal?.probability ?? 0,
    confluence: signal?.confluence ?? 0,
    signalAge: signal?.signalAge ?? 0,
    signalFormingAge: signal?.signalAge ?? 0,
    signalFormingProb: signal?.probability ?? 0,

    rcmState: engine.rcm?.stateText?.() ?? 'NEUTRAL',
    rcmIntegrity: engine.rcm?.getCurrentState?.()?.integrity ?? 0.5,
    rcmDamage: engine.rcm?.damageText?.() ?? 'CLEAN',
    insideVA,
    relativeToVA,
    nearestPoc,
    nearestLevel,

    regimeType,
    dvsRatio,
    unifiedAgg,
    spreadProxy,

    narrative,

    diagEvaluated: sel?.diagSignalsEvaluated ?? 0,
    diagPassed: sel?.diagSignalsPassed ?? 0,
    diagRejProb: sel?.diagRejectedProbability ?? 0,
    diagRejConf: sel?.diagRejectedConfluence ?? 0,
    diagRejTrend: sel?.diagRejectedTrend ?? 0,
    diagRejRegime: sel?.diagRejectedRegime ?? 0,
    diagRejVol: sel?.diagRejectedVolume ?? 0,
  };
}
