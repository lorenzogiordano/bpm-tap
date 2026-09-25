// Collaudo finale della tonalità: raccolta esclusa, provata nelle condizioni d'ascolto reali.
// Uso: node lab/key-final-eval.mjs <raccolta esclusa> <pulito|stanza> [blocchi]
// "stanza" = allenamento su audio pulito + audio da stanza simulato (condizione "mic").
import { loadKeyData } from './keylab.mjs';
import { keyReport } from './common.mjs';
import { prepare, expandBlocks } from './keyfeat.mjs';
import { createModel, train, scoresOf, probabilities } from './key-model.mjs';
import { bestKey } from '../audio/key.js';

const held = process.argv[2];
const regime = process.argv[3] || 'pulito';
const blocks = expandBlocks((process.argv[4] || 'deep6,deep5,deep4').split(','));
const sets = ['gtzan', 'giantsteps_key', 'fmak', 'giantsteps_mtg_key'].filter((d) => d !== held);
const conditions = ['clean', 'mic', 'mic-calib', 'mic-auto'];
const cacheOf = (c) => (c === 'clean' ? 'nnls' : `nnls-${c}`);

const trainClips = sets.flatMap((d) => [
  ...loadKeyData(d, 'nnls'),
  ...(regime === 'stanza' ? loadKeyData(d, 'nnls-mic') : []),
]);
const testClips = conditions.flatMap((c) => loadKeyData(held, cacheOf(c)));
// La normalizzazione dei blocchi si calcola sull'allenamento e si applica uguale alla prova.
const prepared = prepare([...trainClips, ...testClips], blocks, { weighting: 'tonal', gamma: 2 });
const trainSet = prepared.slice(0, trainClips.length);
const testSet = prepared.slice(trainClips.length);
const model = train(createModel(blocks.length * 12), trainSet, { lr: 0.002, epochs: 300, l2: 0.003 });

const rows = {};
const calibration = {};
const top2s = {};
for (const c of conditions) {
  const idx = testClips.map((clip, i) => [clip, i]).filter(([clip]) => (clip.condition || 'clean') === c);
  const pairs = idx.map(([clip, i]) => ({ est: bestKey(scoresOf(model, testSet[i])), ref: clip.key }));
  // Riferimento: S-KEY da solo nella stessa condizione (dai suoi punteggi grezzi).
  const skeyPairs = idx.map(([, i]) => {
    const r = testSet[i].raw;
    const s = Array.from({ length: 24 }, (_, k) => (k < 12 ? r.skmaj[k] : r.skmin[k - 12]));
    return { est: bestKey(s), ref: testSet[i].key };
  });
  const r = keyReport(pairs);
  const sk = keyReport(skeyPairs);
  // Affidabilità dichiarata contro esattezza reale, e "giusta tra le prime due".
  const probs = idx.map(([, i]) => probabilities(scoresOf(model, testSet[i])));
  const labels = idx.map(([clip]) => clip.key.tonic + (clip.key.mode === 'minor' ? 12 : 0));
  const top2 = probs.filter((p, j) => { const o = p.map((v, k) => [v, k]).sort((a, b) => b[0] - a[0]); return o[0][1] === labels[j] || o[1][1] === labels[j]; }).length;
  calibration[c] = [[0, 0.35], [0.35, 0.5], [0.5, 0.65], [0.65, 0.8], [0.8, 1.01]].map(([lo, hi]) => {
    const sel = probs.map((p, j) => [Math.max(...p), p.indexOf(Math.max(...p)) === labels[j]]).filter(([m]) => m >= lo && m < hi);
    return `${lo}-${Math.min(1, hi)}: ${Math.round((100 * sel.length) / probs.length)}% brani → ${sel.length ? Math.round((100 * sel.filter(([, ok]) => ok).length) / sel.length) : '-'}% giusti`;
  });
  top2s[c] = Math.round((1000 * top2) / probs.length) / 10;
  rows[`${c}`] = { n: r.n, 'S-KEY esatta': sk.exact, 'modello esatta': r.exact, 'modello mirex': r.mirex, scala: r.scale, quinta: r.fifth, relativa: r.relative, parallela: r.parallel, altro: r.other };
}
console.log(`esclusa ${held} · allenamento: ${regime} (${trainSet.length} esempi) · ${process.argv[4] || 'deep6,deep5,deep4'}`);
console.table(rows);
console.log('giusta tra le prime due:', top2s);
for (const [c, lines] of Object.entries(calibration)) console.log(`affidabilità [${c}]:`, lines.join(' | '));
