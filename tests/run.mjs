// Runs the real cleaners (the same code the browser uses) over tests/fixtures and writes tests/out.
import { createRequire } from 'node:module';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
globalThis.PDFLib = require('pdf-lib');
globalThis.JSZip = require('jszip');
const { cleanFile } = await import('../src/clean.js');

const here = dirname(fileURLToPath(import.meta.url));
const fx = join(here, 'fixtures');
const out = join(here, 'out');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const only = process.argv[2];
let failed = 0;
const summary = [];
for (const name of readdirSync(fx).sort()) {
  if (only && !name.includes(only)) continue;
  const file = new File([readFileSync(join(fx, name))], name);
  const t0 = performance.now();
  const r = await cleanFile(file, { renameMode: 'keep' });
  const ms = Math.round(performance.now() - t0);
  console.log(`\n=== ${name} → ${r.status} (${r.info.label}, ${ms} ms)${r.verified ? ' ✓ verified' : ''}`);
  if (r.message) console.log('   message:', r.message);
  if (r.detail) console.log('   detail:', r.detail.split('\n').slice(0, 4).join(' | '));
  for (const f of r.findings || []) console.log(`   ${f.level === 'high' ? '!' : '-'} ${f.label}${f.value ? ': ' + f.value : ''}`);
  for (const w of r.warnings || []) console.log(`   ⚠ ${w}`);
  if (r.blob) writeFileSync(join(out, name), Buffer.from(await r.blob.arrayBuffer()));
  if (r.status === 'error' || !r.verified) failed++;
  summary.push({ name, status: r.status, verified: r.verified, findings: (r.findings || []).length, size: [file.size, r.blob?.size] });
}
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`\n${summary.length} files, ${failed} not verified/errored`);
process.exit(failed ? 1 : 0);
