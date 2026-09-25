// Allenamento sulle quattro raccolte e prove "a raccolta esclusa".
// Uso: node lab/key-big.mjs <blocchi> [linear|mlp] [hidden]
import { loadKeyData } from './keylab.mjs';
import { keyReport } from './common.mjs';
import { prepare, expandBlocks } from './keyfeat.mjs';
import { createModel, train, scoresOf, probabilities } from './key-model.mjs';
import { bestKey } from '../audio/key.js';

const blocks = expandBlocks(process.argv[2].split(','));
const kind = process.argv[3] || 'linear';
const hidden = Number(process.argv[4] || 16);
const sets = ['gtzan', 'giantsteps_key', 'fmak', 'giantsteps_mtg_key'];
const names = { gtzan: 'GTZAN', giantsteps_key: 'GiantSteps', fmak: 'FMAK', giantsteps_mtg_key: 'GS-MTG' };
const clips = sets.flatMap((d) => loadKeyData(d, 'nnls'));
const all = prepare(clips, blocks, { weighting: 'tonal', gamma: 2 });
const byDs = Object.fromEntries(sets.map((d) => [d, all.filter((_, i) => clips[i].item.dataset === d)]));
const dims = blocks.length * 12;
const hp = JSON.parse(process.env.HP || '{}');
const fit = (ex) => train(createModel(dims, { kind, hidden }), ex, { epochs: kind === 'mlp' ? 60 : 120, lr: kind === 'mlp' ? 0.01 : 0.02, ...hp });
const fmt = (r) => ({ n: r.n, esatta: r.exact, mirex: r.mirex, scala: r.scale, quinta: r.fifth, relativa: r.relative, parallela: r.parallel, altro: r.other });
const rows = {};
const t0 = Date.now();
for (const held of ['giantsteps_key', 'gtzan', 'fmak']) {
  const model = fit(sets.filter((d) => d !== held).flatMap((d) => byDs[d]));
  const pairs = byDs[held].map((e) => ({ est: bestKey(scoresOf(model, e)), ref: e.key }));
  rows[`esclusa ${names[held]} (allenato sulle altre 3)`] = fmt(keyReport(pairs));
}
// Validazione incrociata su tutto, riportata per raccolta.
const folds = 5;
const perDs = Object.fromEntries(sets.map((d) => [d, []]));
for (let f = 0; f < folds; f++) {
  const model = fit(all.filter((_, i) => i % folds !== f));
  all.forEach((e, i) => { if (i % folds === f) perDs[clips[i].item.dataset].push({ est: bestKey(scoresOf(model, e)), ref: e.key }); });
}
for (const d of sets) rows[`CV su tutto · ${names[d]}`] = fmt(keyReport(perDs[d]));
rows['CV su tutto · totale'] = fmt(keyReport(sets.flatMap((d) => perDs[d])));
console.log(`${kind}${kind === 'mlp' ? ` ${hidden}` : ''} · ${process.argv[2]} · ${JSON.stringify(hp)} · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
console.table(rows);
