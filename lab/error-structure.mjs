// Struttura degli errori del modello: distanza in semitoni (stima − annotata) e coppia di modi.
import { loadKeyData } from './keylab.mjs';
import { prepare } from './keyfeat.mjs';
import { createModel, train, scoresOf } from './key-model.mjs';
import { bestKey } from '../audio/key.js';
const blocks = 'treble,bass,active,majtriad,mintriad'.split(',');
const clips = [...loadKeyData('gtzan', 'nnls'), ...loadKeyData('giantsteps_key', 'nnls')];
const all = prepare(clips, blocks, { weighting: 'tonal', gamma: 2 });
const counts = {};
let total = 0;
for (let f = 0; f < 5; f++) {
  const model = train(createModel(blocks.length * 12), all.filter((_, i) => i % 5 !== f));
  for (const e of all.filter((_, i) => i % 5 === f)) {
    const est = bestKey(scoresOf(model, e));
    total += 1;
    const d = (est.tonic - e.key.tonic + 12) % 12;
    const k = `${e.key.mode === 'major' ? 'M' : 'm'}→${est.mode === 'major' ? 'M' : 'm'} +${d}`;
    counts[k] = (counts[k] || 0) + 1;
  }
}
const names = { 'M→M +0': 'giusta', 'm→m +0': 'giusta', 'M→M +7': 'quinta sopra', 'M→M +5': 'quarta (quinta sotto)', 'm→m +7': 'quinta sopra', 'm→m +5': 'quarta', 'M→m +9': 'relativa', 'm→M +3': 'relativa', 'M→m +0': 'parallela', 'm→M +0': 'parallela', 'M→m +4': 'relativa della quinta (6 note in comune)', 'm→M +10': 'relativa della quinta sotto', 'm→M +8': 'relativa della quarta', 'M→m +2': 'relativa della quarta (6 note)' };
console.table(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 18).map(([k, v]) => ({ relazione: k, '%': Math.round((1000 * v) / total) / 10, significato: names[k] || '' })));
