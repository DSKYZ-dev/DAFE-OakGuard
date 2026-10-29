import { generateBars, transformBars, generatePerBarVolumes } from '../../apps/web/src/data-generator';
import { barEngine } from '../../apps/web/src/bar-engine';
import { computeVolumeProfileBins, DEFAULT_VP_SETTINGS } from '../../apps/web/src/volume-profile';

let fails=0;
function rand(min:number,max:number){ return min+Math.random()*(max-min); }

// Extreme price ranges
for (const price of [0.0005, 1.08, 5500, 67000, 1e6]) {
  const bars = generateBars(200,'1h','TEST');
  bars.forEach(b=>{ b.open=price*(0.99+rand(0,0.02)); b.close=price*(0.99+rand(0,0.02)); b.high=Math.max(b.open,b.close)*1.005; b.low=Math.min(b.open,b.close)*0.995; });
  for (const t of ['candlestick','renko','kagi'] as const) {
    const res = barEngine.transform(bars, t as any, '1h', 'extreme');
    if (!res.health.ok || res.bars.length===0) { console.error(`extreme price ${price} ${t} fail`); fails++; }
  }
}
// Zero volume
{
  const bars = generateBars(100,'1m','SPY'); bars.forEach(b=>b.volume=0);
  const res = barEngine.transform(bars,'volume-bar' as any,'1m','extreme');
  if (res.bars.length===0) { console.error('zero vol fail'); fails++; }
  const vpi = computeVolumeProfileBins(bars, {...DEFAULT_VP_SETTINGS, binCount:12});
  if (vpi.bins.length===0) { console.error('vpi zero vol fail'); fails++; }
}
// Single bar
{
  const bars = generateBars(1,'1m','SPY');
  const res = barEngine.transform(bars,'heikin-ashi' as any,'1m','extreme');
  if (res.bars.length===0) fails++;
}
// NaN handling
{
  const bars = generateBars(10,'1m','SPY'); (bars[5] as any).close = NaN;
  const res = barEngine.transform(bars,'candlestick' as any,'1m','extreme');
  if (res.health.ok) console.warn('NaN should warn'); // should have error but not crash
}
// Rapid TF switching simulation
{
  const tfs = ['1m','5m','1h','1d','1w'] as const;
  let cur = generateBars(300,'1m','SPY');
  for (const tf of tfs) {
    const res = barEngine.transform(cur, 'candlestick' as any, tf as any, 'rapid');
    if (res.bars.length===0) fails++;
    cur = res.bars.slice(-100);
  }
}
console.log(`Extreme test fails=${fails} ${fails===0?'PASS':'FAIL'}`);
process.exit(fails===0?0:1);
