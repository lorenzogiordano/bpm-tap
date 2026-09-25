// Tonalità in condizioni d'ascolto reali: modello allenato su audio pulito (o anche su
// audio "da stanza") e provato sugli stessi brani in quattro condizioni.
// Uso: node lab/key-conditions.mjs [blocchi]
import { loadKeyData } from './keylab.mjs';
import { keyReport } from './common.mjs';
import { prepare } from './keyfeat.mjs';
import { createModel, train, scoresOf } from './key-model.mjs';
import { bestKey } from '../audio/key.js';

const blocks = (process.argv[2] || 'treble,bass,active,majtriad,mintriad').split(',');
const conditions = (process.env.CONDITIONS || 'clean,mic,mic-calib,mic-auto').split(',');
const cacheOf = (c) => (c === 'clean' ? 'nnls' : `nnls-${c}`);
const featureOptions = { weighting: 'tonal', gamma: 2 };

// Stessi brani in tutte le condizioni.
const byCondition = {};
for (const c of conditions) {
  byCondition[c] = [...loadKeyData('gtzan', cacheOf(c)), ...loadKeyData('giantsteps_key', cacheOf(c))];
}
const ids = new Set(byCondition.clean.map((x) => x.item.id));
for (const c of conditions) for (const id of [...ids]) if (!byCondition[c].some((x) => x.item.id === id)) ids.delete(id);
const order = [...ids];
const prepared = {};
const all = prepare(conditions.flatMap((c) => order.map((id) => byCondition[c].find((x) => x.item.id === id))), blocks, featureOptions);
conditions.forEach((c, ci) => { prepared[c] = all.slice(ci * order.length, (ci + 1) * order.length); });

const dims = blocks.length * 12;
const folds = 5;
const results = {};
for (const trainOn of (process.env.TRAIN || 'pulito,pulito + stanza').split(',')) {
  const pairs = Object.fromEntries(conditions.map((c) => [c, []]));
  for (let f = 0; f < folds; f++) {
    const trainIdx = order.map((_, i) => i).filter((i) => i % folds !== f);
    const set = trainOn === 'pulito'
      ? trainIdx.map((i) => prepared.clean[i])
      : trainIdx.flatMap((i) => conditions.map((c) => prepared[c][i]));
    const model = train(createModel(dims), set);
    for (const c of conditions) {
      for (let i = f; i < order.length; i += folds) pairs[c].push({ est: bestKey(scoresOf(model, prepared[c][i])), ref: prepared[c][i].key });
    }
  }
  for (const c of conditions) {
    const r = keyReport(pairs[c]);
    results[`allenato su ${trainOn} · prova: ${c}`] = { esatta: r.exact, mirex: r.mirex, scala: r.scale, quinta: r.fifth, relativa: r.relative, parallela: r.parallel, altro: r.other };
  }
}
console.log(`${order.length} brani (GTZAN + GiantSteps), blocchi ${blocks.join(',')}`);
console.table(results);
