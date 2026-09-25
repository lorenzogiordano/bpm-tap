// Prova molte varianti del cromagramma: estrae (in cache) e valuta i profili migliori.
// Uso: node lab/sweep.mjs '[["nome", {opzioni}], …]'
import { execFileSync } from 'node:child_process';
import { loadKeyData, evaluateProfiles } from './keylab.mjs';

const variants = JSON.parse(process.argv[2]);
const datasets = (process.argv[3] || 'gtzan,giantsteps_key').split(',');
const profiles = ['bgate', 'edma', 'shaath', 'tkp', 'temperley'];
const table = {};
for (const [name, opts] of variants) {
  for (const d of datasets) {
    execFileSync('node', ['lab/extract.mjs', d, '--variant', name, '--opts', JSON.stringify(opts)], { stdio: 'ignore' });
    const rows = evaluateProfiles(loadKeyData(d, name), { norm: 'max' });
    for (const p of profiles) {
      const key = `${name} · ${p}`;
      table[key] ??= {};
      table[key][`${d === 'gtzan' ? 'GTZAN' : 'GiantSteps'} esatta`] = rows[p].exact;
      table[key][`${d === 'gtzan' ? 'GTZAN' : 'GiantSteps'} mirex`] = rows[p].mirex;
    }
  }
}
console.table(table);
