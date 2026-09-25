// Allena il modello finale della tonalità e lo esporta per l'app (audio/key-model.json).
// Uso: node lab/key-export.mjs <blocchi> [cache aggiuntive per l'allenamento] [--exclude <raccolta> --out <file>]
// Esempio: node lab/key-export.mjs deep6,deep5,deep4 nnls-mic
// Con --exclude si allena senza una raccolta, per provare il modello esportato su brani mai visti.
import { writeFileSync } from 'node:fs';
import { loadKeyData } from './keylab.mjs';
import { prepare, expandBlocks } from './keyfeat.mjs';
import { createModel, train } from './key-model.mjs';

const blocks = expandBlocks(process.argv[2].split(','));
const option = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const extraCaches = (process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : '').split(',').filter(Boolean);
const sets = ['gtzan', 'giantsteps_key', 'fmak', 'giantsteps_mtg_key'].filter((d) => d !== option('--exclude'));
const clips = sets.flatMap((d) => [loadKeyData(d, 'nnls'), ...extraCaches.map((c) => loadKeyData(d, c))].flat());
const all = prepare(clips, blocks, { weighting: 'tonal', gamma: 2 });
const model = train(createModel(blocks.length * 12), all, { lr: 0.002, epochs: 300, l2: 0.003 });
const round = (v) => Array.from(v, (x) => Math.round(x * 1e6) / 1e6);
const out = {
  version: 1,
  trainedOn: `${sets.join(', ')}${extraCaches.length ? ` + ${extraCaches.join(', ')}` : ''} (${all.length} esempi)`,
  gamma: 2,
  blocks,
  scales: Object.fromEntries(blocks.map((b) => [b, Math.round(all.scale[b] * 1e6) / 1e6])),
  weights: model.w.map(round),
};
writeFileSync(option('--out') || new URL('../audio/key-model.json', import.meta.url), JSON.stringify(out));
console.log(`esportato: ${blocks.length} blocchi, ${out.weights[0].length * 2} pesi, ${all.length} esempi`);
