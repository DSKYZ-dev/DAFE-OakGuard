import type { BaseBar, VolumeBin } from '@dafe/types';

export type VisualEngine =
  | '3D-Depth'
  | 'Thermal'
  | 'Nebula'
  | 'Quantum'
  | 'DNA'
  | 'Constellation'
  | 'Liquid Metal'
  | 'Neon Wireframe';

export type VPColorTheme = 'DAFE Signature' | 'Cyber Neon' | 'Ocean Depths' | 'Volcanic';

export interface VPSettings {
  mode: '2D-Side' | '2D-Per-Bar' | '3D-Extrude' | '3D-Heatmap';
  visualEngine: VisualEngine;
  binCount: number;
  lookbackBars: number;
  valueAreaPct: number;
  profileWidth: number;
  colorTheme: VPColorTheme;
  showValueArea: boolean;
  showDelta: boolean;
  showNodes: boolean;
  pocColor: string;
  deltaPocColor: string;
  vaFillColor: string;
  vaLineColor: string;
  hvnColor: string;
  lvnColor: string;
}

export interface VPComputed {
  bins: VolumeBin[];
  poc: VolumeBin | null;
  deltaPoc: VolumeBin | null;
  vah: number | null;
  val: number | null;
  totalVolume: number;
  delta: number;
  highNodes: VolumeBin[];
  lowNodes: VolumeBin[];
  colors: VPColors;
  showValueArea?: boolean;
  showDelta?: boolean;
  showNodes?: boolean;
}

export interface VPColors {
  bull: string;
  bear: string;
  poc: string;
  deltaPoc: string;
  vaFill: string;
  vaLine: string;
  hvn: string;
  lvn: string;
}

const THEME_COLORS: Record<VPColorTheme, Omit<VPColors, 'poc' | 'deltaPoc' | 'vaFill' | 'vaLine' | 'hvn' | 'lvn'>> = {
  'DAFE Signature': { bull: '#1affa0', bear: '#ff3b6b' },
  'Cyber Neon': { bull: '#00f3ff', bear: '#ff00ff' },
  'Ocean Depths': { bull: '#00ffcc', bear: '#ff6b6b' },
  'Volcanic': { bull: '#ffcc00', bear: '#ff3300' },
};

export const DEFAULT_VP_SETTINGS: VPSettings = {
  mode: '3D-Extrude',
  visualEngine: '3D-Depth',
  binCount: 24,
  lookbackBars: 0,
  valueAreaPct: 70,
  profileWidth: 50,
  colorTheme: 'DAFE Signature',
  showValueArea: true,
  showDelta: true,
  showNodes: true,
  pocColor: '#FFD700',
  deltaPocColor: '#FF6B00',
  vaFillColor: 'rgba(65,105,225,0.3)',
  vaLineColor: '#4169E1',
  hvnColor: '#00FF88',
  lvnColor: '#FF4444',
};

function resolveColors(settings: VPSettings): VPColors {
  const theme = THEME_COLORS[settings.colorTheme];
  return {
    bull: theme.bull,
    bear: theme.bear,
    poc: settings.pocColor,
    deltaPoc: settings.deltaPocColor,
    vaFill: settings.vaFillColor,
    vaLine: settings.vaLineColor,
    hvn: settings.hvnColor,
    lvn: settings.lvnColor,
  };
}

/** Compute a volume profile with equal-price bins from a slice of bars. */
export function computeVolumeProfileBins(
  bars: BaseBar[],
  settings: VPSettings,
): VPComputed {
  if (bars.length === 0 || settings.binCount < 1) {
    return {
      bins: [], poc: null, deltaPoc: null, vah: null, val: null,
      totalVolume: 0, delta: 0, highNodes: [], lowNodes: [],
      colors: resolveColors(settings),
    };
  }

  let minP = Infinity;
  let maxP = -Infinity;
  let totalVolume = 0;
  let usesSyntheticVol = false;
  for (const b of bars) {
    if (b.low < minP) minP = b.low;
    if (b.high > maxP) maxP = b.high;
    totalVolume += b.volume;
  }
  // Forex/crypto pairs often have zero volume from Yahoo — use bar range as proxy
  if (totalVolume === 0) {
    usesSyntheticVol = true;
    for (const b of bars) {
      totalVolume += (b.high - b.low) || 1;
    }
  }
  const range = maxP - minP || 1;
  const step = range / settings.binCount;

  const bins: VolumeBin[] = [];
  for (let i = 0; i < settings.binCount; i++) {
    const low = minP + i * step;
    const high = i === settings.binCount - 1 ? maxP : minP + (i + 1) * step;
    bins.push({
      price: (low + high) / 2,
      volume: 0,
      buyVolume: 0,
      sellVolume: 0,
      barIndex: -1,
      tickCount: 0,
      low,
      high,
    });
  }

  for (const b of bars) {
    const vol = usesSyntheticVol ? ((b.high - b.low) || 1) : b.volume;
    const barSpan = b.high - b.low;
    const t = barSpan > 0 ? (b.close - b.low) / barSpan : 0.5;
    const buyFrac = 0.25 + 0.5 * Math.min(1, Math.max(0, t));
    const buyVol = vol * buyFrac;
    const sellVol = vol - buyVol;
    for (const bin of bins) {
      const binLow = bin.low ?? bin.price - step / 2;
      const binHigh = bin.high ?? bin.price + step / 2;
      const overlapLow = Math.max(b.low, binLow);
      const overlapHigh = Math.min(b.high, binHigh);
      if (overlapHigh <= overlapLow) continue;
      const overlap = (overlapHigh - overlapLow) / (barSpan || 1);
      bin.volume += vol * overlap;
      bin.buyVolume += buyVol * overlap;
      bin.sellVolume += sellVol * overlap;
      bin.tickCount += 1;
    }
  }

  let poc: VolumeBin | null = null;
  let deltaPoc: VolumeBin | null = null;
  let maxDelta = -Infinity;
  let delta = 0;
  for (const b of bins) {
    if (!poc || b.volume > poc.volume) poc = b;
    const binDelta = b.buyVolume - b.sellVolume;
    delta += binDelta;
    if (Math.abs(binDelta) > Math.abs(maxDelta)) {
      maxDelta = binDelta;
      deltaPoc = b;
    }
  }

  const sorted = [...bins].filter(b => b.volume > 0).sort((a, b) => b.volume - a.volume);
  let acc = 0;
  const target = totalVolume * (settings.valueAreaPct / 100);
  const vaBins = new Set<VolumeBin>();
  for (const b of sorted) {
    if (acc >= target) break;
    vaBins.add(b);
    acc += b.volume;
  }
  const vaPrices = Array.from(vaBins).map(b => b.price);
  const vah = vaPrices.length > 0 ? Math.max(...vaPrices) : null;
  const val = vaPrices.length > 0 ? Math.min(...vaPrices) : null;

  const thresholdIndex = Math.max(1, Math.floor(sorted.length * 0.15));
  const highNodes = sorted.slice(0, thresholdIndex);
  const lowNodes = sorted.slice(-thresholdIndex).reverse();

  return {
    bins,
    poc,
    deltaPoc,
    vah,
    val,
    totalVolume,
    delta,
    highNodes,
    lowNodes,
    colors: resolveColors(settings),
    showValueArea: settings.showValueArea,
    showDelta: settings.showDelta,
    showNodes: settings.showNodes,
  };
}
