// Runs the end-to-end suites one after another against the local Firebase emulators and exits with
// an error if any check fails. Start the emulators first (see README.md).
//
//   node e2e/run-all.mjs                 all suites except documents
//   node e2e/run-all.mjs --documents     also the documents suite (needs OCR access in backend/.env.local)
//   node e2e/run-all.mjs regression      only the named suite(s)
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ALL = ['regression', 'wallet_finance', 'commission', 'super_admin', 'admin_panel', 'p1_fixes', 'documents'];
const args = process.argv.slice(2);
const named = args.filter(a => !a.startsWith('--'));
const suites = named.length ? named : ALL.filter(s => s !== 'documents' || args.includes('--documents'));

let failed = 0, passed = 0;
for (const s of suites) {
  if (!ALL.includes(s)) { console.error(`Unknown suite "${s}". Choose from: ${ALL.join(', ')}`); process.exit(2); }
  const file = fileURLToPath(new URL(`./suites/${s}.mjs`, import.meta.url));
  console.log(`\n=== ${s}`);
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout}${r.stderr}`;
  const fails = out.split('\n').filter(l => l.startsWith('FAIL'));
  const ok = out.split('\n').filter(l => l.startsWith('PASS')).length;
  fails.forEach(l => console.log(l));
  passed += ok; failed += fails.length;
  if (r.status !== 0) { failed++; console.log(`Suite crashed (exit ${r.status}):\n${out.split('\n').slice(-15).join('\n')}`); }
  else console.log(`${ok} passed, ${fails.length} failed`);
}
console.log(`\nTOTAL: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
