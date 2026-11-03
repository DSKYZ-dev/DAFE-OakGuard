// Invariants for the per-bar volume profile and the 3D extrusions built from it.
// Run: npm run verify:volume
import type { BaseBar } from '@dafe/types';
import { generatePerBarVolumes, levelBuyShare } from '../../apps/web/src/data-generator';
import { biasMix, biasOf, bodySpan, extrusionBox, NEUTRAL_BIAS } from '../../apps/web/src/volume-extrusion';

let checks = 0;
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) {
    failures++;
    if (failures <= 25) console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}
const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));

// Seeded generator, so any failure reproduces exactly.
let seed = 20260502;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

function randomBar(i: number): BaseBar {
  const open = 100 + rnd() * 50;
  const c = open + (rnd() - 0.5) * 6;
  const high = Math.max(open, c) + rnd() * 3;
  const low = Math.min(open, c) - rnd() * 3;
  return { timestamp: i * 60_000, open, high, low, close: c, volume: 1 + Math.floor(rnd() * 90_000) };
}

const edge: BaseBar[] = [
  { timestamp: 0, open: 100, high: 101, low: 99, close: 101, volume: 5000 }, // closes at the high
  { timestamp: 1, open: 100, high: 101, low: 99, close: 99, volume: 5000 }, // closes at the low
  { timestamp: 2, open: 100, high: 100, low: 100, close: 100, volume: 800 }, // no price range
  { timestamp: 3, open: 100, high: 102, low: 98, close: 100, volume: 0 }, // no volume
];

const bars = [...Array.from({ length: 400 }, (_, i) => randomBar(i)), ...edge];
const levelCount = 12;
const profiles = generatePerBarVolumes(bars, levelCount);
check('one profile per bar', profiles.length === bars.length);

bars.forEach((bar, idx) => {
  const pv = profiles[idx];
  const name = `bar ${idx}`;
  const range = bar.high - bar.low;
  if (!(range > 0) || !(bar.volume > 0)) {
    check(`${name}: no profile without range or volume`, pv.levels.length === 0 && pv.maxVol === 0);
    return;
  }
  const lv = pv.levels;
  check(`${name}: level count`, lv.length === levelCount, `${lv.length}`);
  check(`${name}: bins start at the low`, lv[0].lo === bar.low);
  check(`${name}: bins end at the high`, lv[lv.length - 1].hi === bar.high);
  for (let k = 0; k < lv.length; k++) {
    check(`${name}: bin ${k} has height`, lv[k].hi > lv[k].lo);
    if (k > 0) check(`${name}: bin ${k} starts where bin ${k - 1} ends`, lv[k].lo === lv[k - 1].hi);
    check(`${name}: bin ${k} sits inside the bar`, lv[k].lo >= bar.low - 1e-9 && lv[k].hi <= bar.high + 1e-9);
    check(`${name}: buy + sell = volume at bin ${k}`, near(lv[k].buyVol + lv[k].sellVol, lv[k].volume));
    check(`${name}: no negative volume at bin ${k}`, lv[k].buyVol >= 0 && lv[k].sellVol >= 0 && lv[k].volume >= 0);
  }
  const sum = lv.reduce((s, l) => s + l.volume, 0);
  check(`${name}: levels conserve the bar volume`, near(sum, bar.volume), `${sum} vs ${bar.volume}`);
  for (const l of lv) {
    check(`${name}: level buy share follows the candle shape`, near(l.buyVol, l.volume * levelBuyShare(bar, l.price)));
  }
  check(`${name}: maxVol is the largest level`, pv.maxVol === Math.max(...lv.map(l => l.volume)));
  // Volume peaks where the bar's typical price sits, within one bin.
  const typical = (bar.high + bar.low + bar.close) / 3;
  const peak = lv.reduce((best, l, k) => (l.volume > lv[best].volume ? k : best), 0);
  const peakMid = (lv[peak].lo + lv[peak].hi) / 2;
  check(`${name}: peak bin holds the typical price`, Math.abs(peakMid - typical) <= lv[0].hi - lv[0].lo + 1e-9, `${peakMid} vs ${typical}`);
});

// Bias must vary inside a bar (body and wicks lean differently), not sit at one value.
const mixedBars = profiles.filter(p => p.levels.some(l => biasOf(l) > 0) && p.levels.some(l => biasOf(l) < 0)).length;
check('bias varies within bars', mixedBars > bars.length / 4, `${mixedBars} of ${bars.length} bars`);

// Bias on the edge bars: a bar closing at its high is all buying, at its low all selling.
check('closes at high: all buying', profiles[bars.length - 4].levels.every(l => l.sellVol === 0 && biasOf(l) === 1));
check('closes at low: all selling', profiles[bars.length - 3].levels.every(l => l.buyVol === 0 && biasOf(l) === -1));

// Extrusions: depth is linear in volume against the window's largest level.
const maxVolume = Math.max(...profiles.flatMap(p => p.levels.map(l => l.volume)));
const maxDepth = 4;
const py = (p: number) => 5000 - p * 20; // any linear price → pixel map
const boxes = profiles.flatMap((pv, idx) => pv.levels.map((lv, k) => ({
  idx, k, lv,
  box: extrusionBox({ top: py(lv.hi), bottom: py(lv.lo), volume: lv.volume, buyVolume: lv.buyVol, maxVolume, maxDepth }),
})));
const nonNull = boxes.filter(b => b.box !== null) as Array<{ idx: number; k: number; lv: typeof boxes[number]['lv']; box: NonNullable<typeof boxes[number]['box']> }>;
check('every positive level has a box', nonNull.length === boxes.filter(b => b.lv.volume > 0).length);
check('depth never exceeds the maximum', nonNull.every(b => b.box.depth <= maxDepth + 1e-12));
check('the largest level extrudes the full depth', nonNull.some(b => b.lv.volume === maxVolume && near(b.box.depth, maxDepth)));
for (let t = 0; t < 300; t++) {
  const a = nonNull[Math.floor(rnd() * nonNull.length)];
  const b = nonNull[Math.floor(rnd() * nonNull.length)];
  check('depth is proportional to volume', near(a.box.depth / b.box.depth, a.lv.volume / b.lv.volume, 1e-9),
    `${a.box.depth / b.box.depth} vs ${a.lv.volume / b.lv.volume}`);
}
nonNull.slice(0, 200).forEach(({ lv, box }) => {
  check('buy share is the level buy fraction', near(box.buyShare, lv.buyVol / lv.volume));
  check('box edges keep top < bottom', box.bottom > box.top);
});
// Neighbouring bins meet exactly, so the profile has no gaps or overlaps.
profiles.forEach((pv, idx) => {
  for (let k = 1; k < pv.levels.length; k++) {
    const lowerBox = extrusionBox({ top: py(pv.levels[k - 1].hi), bottom: py(pv.levels[k - 1].lo), volume: pv.levels[k - 1].volume, buyVolume: 0, maxVolume, maxDepth });
    const upperBox = extrusionBox({ top: py(pv.levels[k].hi), bottom: py(pv.levels[k].lo), volume: pv.levels[k].volume, buyVolume: 0, maxVolume, maxDepth });
    if (lowerBox && upperBox) check(`bar ${idx}: bins ${k - 1} and ${k} share an edge`, upperBox.bottom === lowerBox.top, `${upperBox.bottom} vs ${lowerBox.top}`);
  }
});
check('zero volume has no extrusion', extrusionBox({ top: 0, bottom: 10, volume: 0, buyVolume: 0, maxVolume: 5, maxDepth: 4 }) === null);
check('empty window has no extrusion', extrusionBox({ top: 0, bottom: 10, volume: 5, buyVolume: 2, maxVolume: 0, maxDepth: 4 }) === null);
check('zero height has no extrusion', extrusionBox({ top: 5, bottom: 5, volume: 5, buyVolume: 2, maxVolume: 5, maxDepth: 4 }) === null);

// The profile is centred on the candle's front face, whatever the width factor.
for (const factor of [0.4, 0.7, 1]) {
  const span = bodySpan(100, 8, factor);
  check(`profile centred on the body (factor ${factor})`, near((span.left + span.right) / 2, 104));
  check(`profile width follows the factor (factor ${factor})`, near(span.right - span.left, 8 * factor));
}

// Bias colours: neutral at zero, the bull and bear colours at the ends.
const bull = '#22cc88';
const bear = '#ff4477';
check('bias 0 is neutral', biasMix(0, bull, bear) === NEUTRAL_BIAS);
check('bias +1 is bull', biasMix(1, bull, bear) === bull);
check('bias -1 is bear', biasMix(-1, bull, bear) === bear);
check('bias clamps to the colour ends', biasMix(5, bull, bear) === bull && biasMix(-5, bull, bear) === bear);
check('bias of a 70/30 level is 0.4', near(biasOf({ volume: 10, buyVol: 7, sellVol: 3 }), 0.4));
check('bias of an empty level is 0', biasOf({ volume: 0, buyVol: 0, sellVol: 0 }) === 0);

console.log(`${checks - failures}/${checks} volume-extrusion checks passed`);
process.exitCode = failures ? 1 : 0;
