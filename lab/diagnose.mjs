// Diagnosi: la scala annotata spiega il cromagramma meglio delle altre 11?
import { loadKeyData, aggregate } from './keylab.mjs';
const cache = process.argv[2] || 'nnls';
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
// Scala diatonica (7 note) associata a una tonalità: maggiore → la sua; minore → quella della relativa maggiore.
const scaleRoot = (key) => (key.mode === 'major' ? key.tonic : (key.tonic + 3) % 12);
for (const d of ['gtzan', 'giantsteps_key']) {
  const clips = loadKeyData(d, cache);
  const ranks = [];
  const shares = [];
  for (const c of clips) {
    const chroma = aggregate(c, { norm: 'max' });
    const energy = Array.from({ length: 12 }, (_, r) => MAJOR_SCALE.reduce((a, i) => a + chroma[(r + i) % 12], 0));
    const truth = energy[scaleRoot(c.key)];
    ranks.push(energy.filter((e) => e > truth).length + 1);
    shares.push(truth);
  }
  const hist = [1, 2, 3, 4].map((r) => Math.round((100 * ranks.filter((x) => x === r).length) / ranks.length));
  const beyond = Math.round((100 * ranks.filter((x) => x > 4).length) / ranks.length);
  const s = shares.sort((a, b) => a - b);
  console.log(`${d}: la scala annotata è la più "piena" nel ${hist[0]}% dei brani, 2ª nel ${hist[1]}%, 3ª ${hist[2]}%, 4ª ${hist[3]}%, oltre ${beyond}%. Quota di energia nelle 7 note annotate: mediana ${s[s.length >> 1].toFixed(2)} (a caso sarebbe 0.58)`);
}
