/**
 * Performance Tricks — extensive real run.
 * Run: npx tsx tools/verify/perf-tricks-test.ts [iterations]
 *
 * Runs the full A/B matrix (20 tricks, all measured in-process) and the
 * high-frequency harness at 5,000 iterations by default. Asserts the
 * directional claims that production relies on (counts/bytes/errors —
 * never wall-clock timings, which are machine-dependent).
 */
import { runMatrix, runSingleTrick, highFrequencyHarness, DEFAULT_MATRIX, TRICK_PRODUCTION, ALL_TRICKS } from '../../apps/web/src/perf-trick-test-engine';

const iterations = Number(process.argv[2] || 5000);
let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 200) : ''}`);
  if (!cond) failures++;
}

console.log(`=== A/B MATRIX (${ALL_TRICKS.length} tricks, measured) ===`);
const results = runMatrix(DEFAULT_MATRIX);
for (const id of ALL_TRICKS) {
  const r = results[id];
  console.log(`${id.padEnd(20)} with req=${r.with.requests} hit=${r.with.hitRatio.toFixed(2)} err=${r.with.syntheticErrorPct.toFixed(3)}% ms=${(r.with.ms ?? r.with.p99ms).toFixed(2)} | without req=${r.without.requests} err=${r.without.syntheticErrorPct.toFixed(3)}% | Δ ${r.delta}`);
  console.log(`${''.padEnd(20)} ${TRICK_PRODUCTION[id]}`);
}

// Directional assertions (counts / bytes / errors only).
const coal = runSingleTrick('coalescing', true), coalOff = runSingleTrick('coalescing', false);
check('coalescing cuts upstream requests', coal.requests < coalOff.requests, { on: coal.requests, off: coalOff.requests });
const delta = runSingleTrick('deltaCompression', true), deltaOff = runSingleTrick('deltaCompression', false);
check('delta encoding shrinks payload bytes', (delta.bytes ?? 0) < (deltaOff.bytes ?? 0), { on: delta.bytes, off: deltaOff.bytes });
check('delta reconstruction error is rounding-bounded (<0.001)', delta.syntheticErrorPct < 0.001, delta.syntheticErrorPct);
const seed = runSingleTrick('seededJitter', true), seedOff = runSingleTrick('seededJitter', false);
check('anchored ticks stay inside ±0.25% band', seed.syntheticErrorPct <= 0.25, seed.syntheticErrorPct);
check('unbounded walk drifts beyond 3x the anchored band', seedOff.syntheticErrorPct > 0.75, seedOff.syntheticErrorPct);
const slice = runSingleTrick('visibleSlice', true);
check('visible slice last-SMA matches full-history (warmup-guarded)', slice.syntheticErrorPct < 0.01, slice.syntheticErrorPct);
const pct = runSingleTrick('percentileScaling', true), pctOff = runSingleTrick('percentileScaling', false);
check('percentile scaling preserves more ordinary-bar scale than max', pct.hitRatio > pctOff.hitRatio, { on: pct.hitRatio, off: pctOff.hitRatio });
const geo = runSingleTrick('geometryCache', true), geoOff = runSingleTrick('geometryCache', false);
check('geometry cache builds once per 60 frames', geo.requests === 1 && geoOff.requests === 60);
const batch = runSingleTrick('barBatching', true), batchOff = runSingleTrick('barBatching', false);
check('bar batching is one engine call', batch.requests === 1 && batchOff.requests > 100);

console.log(`\n=== HIGH-FREQUENCY HARNESS (${iterations} iterations) ===`);
const harness = highFrequencyHarness(iterations);
console.log(`iterations=${harness.iterations} fails=${harness.fails} ms=${harness.ms.toFixed(0)} (${(harness.ms / harness.iterations).toFixed(3)}ms/iter)`);
check('high-frequency harness passes at requested iterations', harness.pass && harness.iterations === iterations);

console.log(failures === 0 ? '\nALL PERF-TRICK CHECKS PASS' : `\n${failures} PERF-TRICK CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
