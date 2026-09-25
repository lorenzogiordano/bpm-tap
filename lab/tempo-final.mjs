// Scelta del tempo: modello finale per l'app, allenato su audio pulito + stanza simulata.
// Validazione incrociata per brano: lo stesso brano (pulito o dal microfono) sta sempre
// dallo stesso lato. Uso: node lab/tempo-final.mjs [--write]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE, tempoReport } from './common.mjs';
import { train } from './tempo-learn.mjs';
import { chooseTempo } from '../audio/tempo-choice.js';

const dir = join(CACHE, 'tempo');
const conditions = ['clean', 'mic', 'mic-calib', 'mic-auto'];
const load = (ds, c) => {
  const data = JSON.parse(readFileSync(join(dir, `${ds}${c === 'clean' ? '' : `-${c}`}.json`), 'utf8'));
  return Object.values(data).filter((x) => x.candidates && x.candidates.length).map((x) => ({ ...x, ds, condition: c }));
};
const clips = ['gtzan', 'giantsteps_tempo'].flatMap((ds) => conditions.flatMap((c) => load(ds, c)));
const songs = [...new Set(clips.map((c) => `${c.ds}/${c.id}`))];
const fold = new Map(songs.map((s, i) => [s, i % 5]));
const foldOf = (c) => fold.get(`${c.ds}/${c.id}`);
const pick = (model, c) => chooseTempo(c.candidates, model.raw)?.bpm ?? null;

const regimes = { pulito: ['clean'], 'pulito + stanza': ['clean', 'mic'] };
const rows = {};
for (const [name, trainOn] of Object.entries(regimes)) {
  const pairs = {};
  for (let f = 0; f < 5; f++) {
    const model = train(clips.filter((c) => foldOf(c) !== f && trainOn.includes(c.condition)));
    for (const c of clips.filter((x) => foldOf(x) === f)) {
      const key = `${c.ds} · ${c.condition}`;
      (pairs[key] ||= []).push({ est: pick(model, c), ref: c.tempo });
    }
  }
  for (const [key, p] of Object.entries(pairs)) {
    const r = tempoReport(p);
    rows[`${name} → ${key}`] = { n: r.n, acc1: r.acc1, acc2: r.acc2 };
  }
}
console.table(rows);

if (process.argv.includes('--write')) {
  const final = train(clips.filter((c) => regimes['pulito + stanza'].includes(c.condition)));
  const weights = final.raw.map((x) => Math.round(x * 1e6) / 1e6);
  const path = new URL('../audio/tempo-choice.js', import.meta.url);
  const src = readFileSync(path, 'utf8').replace(/export const TEMPO_WEIGHTS = [^;]*;/, `export const TEMPO_WEIGHTS = ${JSON.stringify(weights)};`);
  writeFileSync(path, src);
  console.log(`pesi scritti in audio/tempo-choice.js (${weights.length})`);
}
