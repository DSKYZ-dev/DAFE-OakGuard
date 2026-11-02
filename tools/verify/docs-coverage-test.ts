/**
 * Documentation coverage — keeps the two OakScript references honest.
 * Run: npm run verify:docs
 *
 * Every builtin in the signature registry must be named in the in-editor
 * reference (apps/web/src/oakscript/docs.ts, the 📖 button) and in the agent's
 * retrieval mirror (backend/oak_kb.py). The two copies are hand-maintained, so
 * this check is what stops them drifting as the language grows.
 */
import { readFileSync } from 'node:fs';
import { BUILTIN_REGISTRY } from '../../apps/web/src/oakscript/builtins';
import { getDocumentation } from '../../apps/web/src/oakscript/docs';

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 260) : ''}`);
  if (!cond) failures++;
}

const editorDocs = getDocumentation().map(s => `${s.title}\n${s.content}`).join('\n');
const agentMirror = readFileSync(new URL('../../backend/oak_kb.py', import.meta.url), 'utf8');

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const named = (text: string, name: string) =>
  new RegExp(`(^|[^A-Za-z0-9_.])${escapeRe(name)}(?![A-Za-z0-9_])`).test(text);

const names = BUILTIN_REGISTRY.map(b => b.name);
const missingEditor = names.filter(n => !named(editorDocs, n));
const missingMirror = names.filter(n => !named(agentMirror, n));

console.log(`OakScript docs — ${names.length} builtins in the registry\n`);
check(`every builtin is named in the in-editor reference (docs.ts) — ${missingEditor.length} missing`, missingEditor.length === 0);
check(`every builtin is named in the agent mirror (oak_kb.py) — ${missingMirror.length} missing`, missingMirror.length === 0);
if (missingEditor.length) console.log(`  editor: ${missingEditor.join(', ')}`);
if (missingMirror.length) console.log(`  mirror: ${missingMirror.join(', ')}`);

const agentSection = getDocumentation().find(s => /^Agent Integration/.test(s.title));
check('agent section explains preview, Accept & Apply and Decline', !!agentSection
  && /preview/i.test(agentSection.content) && /Accept/.test(agentSection.content) && /Decline/.test(agentSection.content), agentSection?.title);
check('in-editor reference documents OakGuard', /OakGuard/.test(editorDocs));

console.log(`\n${failures === 0 ? 'DOCS COVERAGE PASS' : `DOCS COVERAGE FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
