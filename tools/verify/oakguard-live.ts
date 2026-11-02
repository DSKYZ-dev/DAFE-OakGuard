/**
 * OakGuard live run — Muse Wonder proposes rules for each escape; the referee grades them.
 *
 * Every exchange is recorded to apps/web/src/oakguard/recorded-run.json so the
 * app (judge mode, no backend) and `npm run verify:proposer` can re-grade the
 * same model text with today's referee. Verdicts are never recorded as truth:
 * they are recomputed on every replay.
 *
 * Usage:
 *   npx tsx tools/verify/oakguard-live.ts [--model muse-wonder-1.0] [--rounds 3] [--escapes all|mined|seed] [--no-record]
 *
 * Needs the backend running with a Meta Model API key (Settings → Provider API Keys).
 */
import { writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { SEED_ESCAPES, type EscapeCase } from '../../apps/web/src/oakguard/escapes';
import { MINED_ESCAPES } from '../../apps/web/src/oakguard/mined-escapes';
import {
  backendTransport, recordingTransport, runProposalLoop,
  type RecordedExchange, type RecordedRun,
} from '../../apps/web/src/oakguard/proposer';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const BASE = process.env.DAFE_BACKEND || 'http://127.0.0.1:8788';
const MODEL = flag('--model') || 'muse-wonder-1.0';
const ROUNDS = Math.max(1, Number(flag('--rounds')) || 3);
const WHICH = flag('--escapes') || 'all';
const RECORD = !argv.includes('--no-record');

function postJson(url: string, body: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const req = httpRequest({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(text)); } catch { reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`)); }
      });
    });
    req.setTimeout(15 * 60 * 1000, () => req.destroy(new Error('request exceeded 15 minutes')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main(): Promise<void> {
  const escapes: EscapeCase[] = WHICH === 'seed' ? SEED_ESCAPES
    : WHICH === 'mined' ? MINED_ESCAPES
      : [...MINED_ESCAPES, ...SEED_ESCAPES.filter(s => !MINED_ESCAPES.some(m => m.defectClass === s.defectClass))];
  console.log(`OakGuard live run · proposer ${MODEL} · ${escapes.length} escapes · up to ${ROUNDS} rounds each\n`);

  const sink: RecordedExchange[] = [];
  const transport = recordingTransport(backendTransport(BASE, postJson), sink);
  let promoted = 0;
  let cost = 0;
  for (const escape of escapes) {
    console.log(`[${escape.id}] ${escape.title} (${escape.origin}${escape.model ? `, ${escape.model}` : ''})`);
    const result = await runProposalLoop({
      escape, transport, model: MODEL, maxRounds: ROUNDS,
      onRound: (r, phase) => {
        if (phase !== 'graded') return;
        if (r.error) { console.log(`  round ${r.round}: ${r.error}`); return; }
        const rep = r.report!;
        console.log(`  round ${r.round}: ${r.rule!.family} ${r.rule!.issueCode} ${JSON.stringify(r.rule!.params)}${r.rule!.allowObjectMethods ? ' +objectMethods' : ''}`);
        console.log(`    variants ${rep.mutantCaught}/${rep.mutantTotal} (held-out ${rep.heldOutCaught}/${rep.heldOutTotal}) · false alarms ${rep.falsePositiveCount}/${rep.goodTotal} → ${rep.verdict.toUpperCase()} · ${(r.meta!.latencyMs / 1000).toFixed(1)}s · $${r.meta!.costUsd.toFixed(4)}`);
        if (rep.verdict === 'rejected') for (const reason of rep.reasons) console.log(`    - ${reason}`);
      },
    });
    cost += result.totalCostUsd;
    if (result.promoted) promoted++;
    console.log(`  → ${result.promoted ? `PROMOTED after ${result.rounds.length} round(s)` : 'not promoted'}\n`);
  }
  console.log(`${promoted}/${escapes.length} escapes produced a promoted rule · total cost $${cost.toFixed(4)}`);

  if (RECORD) {
    const run: RecordedRun = {
      recordedAt: new Date().toISOString(),
      model: MODEL,
      note: `Live OakGuard run: ${MODEL} proposed rules for ${escapes.length} escapes, graded by the referee at record time. Replays re-grade this text with the current referee.`,
      exchanges: sink,
    };
    writeFileSync('apps/web/src/oakguard/recorded-run.json', JSON.stringify(run, null, 2) + '\n');
    console.log('recorded → apps/web/src/oakguard/recorded-run.json');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
