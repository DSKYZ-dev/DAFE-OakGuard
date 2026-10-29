import { generateBars, generatePerBarVolumes, transformBars } from '../../apps/web/src/data-generator';
import { barEngine } from '../../apps/web/src/bar-engine';
import { computeVolumeProfileBins, DEFAULT_VP_SETTINGS } from '../../apps/web/src/volume-profile';

const TFs = ['1m','5m','15m','1h','4h','1d'] as const;
const TYPES = ['candlestick','heikin-ashi','renko','range-bar','volume-bar','tick-bar','kagi','footprint','line','area','dollar-bar','imbalance-bar'] as const;

let fails=0, warns=0, total=0;
const startAll=performance.now();
for (const tf of TFs) {
  const bars = generateBars(5000, tf, 'ES=F');
  if (bars.length!==5000) { console.error(`gen ${tf} wrong count ${bars.length}`); fails++; }
  for (const t of TYPES) {
    total++;
    const t0=performance.now();
    const res = barEngine.transform(bars, t as any, tf as any, 'yahoo');
    const dt=performance.now()-t0;
    if (!res.health.ok) { console.error(`FAIL ${tf}/${t}: ${res.health.errors.join('; ')}`); fails++; }
    if (res.health.warnings.length) warns++;
    if (dt>16) console.warn(`SLOW ${tf}/${t} ${dt.toFixed(1)}ms`);
    // VolP check
    if (res.perBarVols.length !== res.bars.length) { console.error(`VolP mismatch ${tf}/${t}`); fails++; }
    // Determinism check — use same levelCount as engine (12 for footprint/imbalance)
    const lc = (t==='footprint'||t==='imbalance-bar')?12:8;
    const vols2 = generatePerBarVolumes(res.bars, lc);
    const same = JSON.stringify(res.perBarVols.slice(0,2))===JSON.stringify(vols2.slice(0,2));
    if (!same) { console.error(`Non-deterministic VolP ${tf}/${t}`); fails++; }
  }
}
// VPI check
const vpiBars = generateBars(300,'1h','SPY');
const vpi = computeVolumeProfileBins(vpiBars, DEFAULT_VP_SETTINGS);
if (!vpi.poc || vpi.bins.length!==24) { console.error('VPI fail'); fails++; }
console.log(`BarEngine stress: ${total} transforms, fails=${fails}, warns=${warns}, time=${(performance.now()-startAll).toFixed(0)}ms`);
console.log(fails===0? 'PASS':'FAIL');
process.exit(fails===0?0:1);
