// Tonalità con un modello esportato e lo stesso codice dell'app, per condizione e tipo di rumore.
// Uso: node lab/key-app-eval.mjs <raccolta> <modello.json> [condizioni, es. clean,mic,mic-calib,old/mic-calib]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE, loadDataset, keyReport } from './common.mjs';
import { skeyBlocks, standardize, scoreKeys, softmax } from '../audio/key-features.js';

const [dataset, modelPath, list = 'clean,mic,mic-calib,mic-auto'] = process.argv.slice(2);
const model = JSON.parse(readFileSync(modelPath, 'utf8'));
const SKEY = join(CACHE, '..', 'skey');

// Stesso sorteggio di micScenario (common.mjs): il primo numero casuale sceglie il rumore.
function rng(seed) { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
function hash(s) { let h = 2166136261; for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; }
const NOISES = ['fan', 'hum', 'babble', 'pink'];
const noiseOf = (id) => NOISES[Math.floor(rng(hash(id))() * 4)];

const items = loadDataset(dataset).filter((it) => it.key && it.file);
const label = (k) => k.tonic + (k.mode === 'minor' ? 12 : 0);
const rows = {};
const BINS = [0, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.01];
const reliability = {};
for (const cond of list.split(',')) {
  const parts = cond.split('/');
  const name = parts.pop();
  const file = join(SKEY, ...parts, `${dataset}${name === 'clean' ? '' : `-${name}`}.deep.json`);
  const deep = JSON.parse(readFileSync(file, 'utf8'));
  const probsFile = file.replace(/\.deep\.json$/, '.json');
  const skeyP = JSON.parse(readFileSync(probsFile, 'utf8'));
  const tally = { all: [0, 0], ...Object.fromEntries(NOISES.map((n) => [n, [0, 0]])) };
  const bins = BINS.slice(1).map(() => [0, 0]);
  const pairs = [];
  let top2 = 0;
  for (const it of items) {
    if (!deep[it.id]) continue;
    const probs = softmax(scoreKeys(standardize(skeyBlocks({ p: skeyP[it.id], deep: deep[it.id] }), model.blocks, model.scales), model.weights));
    const ok = probs.indexOf(Math.max(...probs)) === label(it.key) ? 1 : 0;
    const order = probs.map((v, k) => [v, k]).sort((a, b) => b[0] - a[0]);
    pairs.push({ est: { tonic: order[0][1] % 12, mode: order[0][1] < 12 ? 'major' : 'minor' }, ref: it.key });
    if (order[0][1] === label(it.key) || order[1][1] === label(it.key)) top2 += 1;
    const b = BINS.findIndex((lo, i) => order[0][0] >= lo && order[0][0] < BINS[i + 1]);
    bins[b][0] += ok; bins[b][1] += 1;
    for (const g of ['all', noiseOf(it.id)]) { tally[g][0] += ok; tally[g][1] += 1; }
  }
  rows[cond] = Object.fromEntries(Object.entries(tally).map(([g, [ok, n]]) => [g, Math.round((1000 * ok) / (n || 1)) / 10]));
  rows[cond].n = tally.all[1];
  rows[cond]['prime due'] = Math.round((1000 * top2) / tally.all[1]) / 10;
  const r = keyReport(pairs);
  Object.assign(rows[cond], { mirex: r.mirex, 'stessa scala': r.scale });
  reliability[cond] = Object.fromEntries(bins.map(([ok, n], i) => [`p ${BINS[i]}–${Math.min(1, BINS[i + 1])}`, n ? `${Math.round((100 * n) / tally.all[1])}% brani → ${Math.round((100 * ok) / n)}% giusti` : '-']));
}
console.log(`${dataset} · ${model.trainedOn}`);
console.table(rows);
console.log('affidabilità dichiarata → esattezza reale');
console.table(reliability);
