// Tonalità per tipo di rumore: il silenzio iniziale (pulizia con impronta) aiuta con alcuni rumori?
import { loadKeyData } from './keylab.mjs';
import { keyReport } from './common.mjs';
import { prepare, expandBlocks } from './keyfeat.mjs';
import { createModel, train, scoresOf } from './key-model.mjs';
import { bestKey } from '../audio/key.js';

function rng(seed) { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
function hash(s) { let h = 2166136261; for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; }
const noiseTypeOf = (id) => ['fan', 'hum', 'babble', 'pink'][Math.floor(rng(hash(id))() * 4)];

const blocks = expandBlocks(['deep6', 'deep5', 'deep4']);
const conditions = ['mic', 'mic-calib', 'mic-auto'];
const rows = {};
for (const held of (process.argv[2] || 'gtzan,giantsteps_key').split(',')) {
  const sets = ['gtzan', 'giantsteps_key', 'fmak', 'giantsteps_mtg_key'].filter((d) => d !== held);
  const trainClips = sets.flatMap((d) => [...loadKeyData(d, 'nnls'), ...loadKeyData(d, 'nnls-mic')]);
  const testClips = conditions.flatMap((c) => loadKeyData(held, `nnls-${c}`));
  const prepared = prepare([...trainClips, ...testClips], blocks, { weighting: 'tonal', gamma: 2 });
  const model = train(createModel(blocks.length * 12), prepared.slice(0, trainClips.length), { lr: 0.002, epochs: 300, l2: 0.003 });
  const test = prepared.slice(trainClips.length);
  for (const type of ['fan', 'hum', 'babble', 'pink']) {
    const row = {};
    for (const c of conditions) {
      const pairs = testClips.map((clip, i) => [clip, i]).filter(([clip]) => clip.condition === c && noiseTypeOf(clip.item.id) === type)
        .map(([clip, i]) => ({ est: bestKey(scoresOf(model, test[i])), ref: clip.key }));
      const r = keyReport(pairs);
      row.n = r.n;
      row[c] = r.exact;
    }
    rows[`${held} · ${type}`] = row;
  }
}
console.table(rows);
