// Esperimenti sulla tonalità: caricamento delle caratteristiche in cache,
// profili classici, modello lineare equivariante alla trasposizione.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE, loadDataset, keyReport } from './common.mjs';
import { PROFILES, keyScores, bestKey } from '../audio/key.js';

// Carica le caratteristiche per frame dei brani con tonalità annotata.
export function loadKeyData(dataset, cacheName = 'base') {
  const dir = join(CACHE, dataset, cacheName);
  const out = [];
  for (const item of loadDataset(dataset)) {
    if (!item.key) continue;
    const metaPath = join(dir, `${item.id}.json`);
    if (!existsSync(metaPath)) continue;
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    const buf = readFileSync(join(dir, `${item.id}.bin`));
    const frames = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    // Condizione d'ascolto dal nome della cache (es. "nnls-mic-calib" → "mic-calib").
    const condition = cacheName.includes('-') ? cacheName.slice(cacheName.indexOf('-') + 1) : null;
    out.push({ item, key: item.key, frames, n: meta.frames, rms: meta.rms, tuning: meta.tuning, meta, condition });
  }
  return out;
}

export function fold36(v, offset) {
  const out = new Float64Array(12);
  for (let b = 0; b < 36; b++) out[Math.floor(((b + 1) % 36) / 3)] += v[offset + b];
  return out;
}

// Cromagramma medio a 12 classi di una parte ('treble' | 'bass'), con normalizzazione per frame.
export function aggregate(clip, { part = 'treble', norm = 'max', from = 0, to = clip.n, compress = 1 } = {}) {
  const acc = new Float64Array(12);
  const offset = part === 'bass' ? 36 : 0;
  for (let f = from; f < to; f++) {
    const v = fold36(clip.frames, f * 72 + offset);
    let s = norm === 'max' ? Math.max(...v) : norm === 'sum' ? v.reduce((a, b) => a + b, 0) : 1;
    if (!(s > 0)) continue;
    for (let i = 0; i < 12; i++) acc[i] += (v[i] / s) ** compress;
  }
  const total = acc.reduce((a, b) => a + b, 0);
  if (total > 0) for (let i = 0; i < 12; i++) acc[i] /= total;
  return acc;
}

export function evaluateProfiles(clips, options = {}) {
  const rows = {};
  for (const [name, profile] of Object.entries(PROFILES)) {
    const pairs = clips.map((c) => ({ est: bestKey(keyScores(aggregate(c, options), profile)), ref: c.key }));
    rows[name] = keyReport(pairs);
  }
  return rows;
}

// ---------- Modello lineare equivariante ----------
// Per ogni tonalità candidata (tonica t, modo m) le caratteristiche del brano
// vengono ruotate sulla tonica t; il punteggio è w_m · x_t. Gli stessi pesi
// valgono per tutte le 12 toniche: il modello non può imparare "le canzoni in La".

export function rotate(v, t) {
  const out = new Float64Array(12);
  for (let i = 0; i < 12; i++) out[i] = v[(i + t) % 12];
  return out;
}

// Vettore di caratteristiche relativo alla tonica t, a partire da blocchi di 12 valori.
export function candidateFeatures(blocks, t) {
  const parts = blocks.map((b) => rotate(b, t));
  const out = new Float64Array(parts.length * 12);
  parts.forEach((p, i) => out.set(p, i * 12));
  return out;
}

export function trainLinear(examples, { dims, epochs = 300, lr = 0.5, l2 = 1e-3 } = {}) {
  // examples: [{ blocks: [Float64Array(12), …], label: 0..23 }]
  const w = [new Float64Array(dims), new Float64Array(dims)];
  const feats = examples.map((e) => Array.from({ length: 12 }, (_, t) => candidateFeatures(e.blocks, t)));
  for (let epoch = 0; epoch < epochs; epoch++) {
    const grad = [new Float64Array(dims), new Float64Array(dims)];
    for (let n = 0; n < examples.length; n++) {
      const scores = new Float64Array(24);
      for (let k = 0; k < 24; k++) {
        const x = feats[n][k % 12];
        const wm = w[k < 12 ? 0 : 1];
        let s = 0;
        for (let d = 0; d < dims; d++) s += wm[d] * x[d];
        scores[k] = s;
      }
      const max = Math.max(...scores);
      let z = 0;
      for (let k = 0; k < 24; k++) { scores[k] = Math.exp(scores[k] - max); z += scores[k]; }
      for (let k = 0; k < 24; k++) {
        const p = scores[k] / z - (k === examples[n].label ? 1 : 0);
        const x = feats[n][k % 12];
        const g = grad[k < 12 ? 0 : 1];
        for (let d = 0; d < dims; d++) g[d] += p * x[d];
      }
    }
    for (let m = 0; m < 2; m++) {
      for (let d = 0; d < dims; d++) w[m][d] -= lr * (grad[m][d] / examples.length + l2 * w[m][d]);
    }
  }
  return w;
}

export function predictLinear(w, blocks) {
  const scores = new Float64Array(24);
  for (let k = 0; k < 24; k++) {
    const x = candidateFeatures(blocks, k % 12);
    const wm = w[k < 12 ? 0 : 1];
    let s = 0;
    for (let d = 0; d < x.length; d++) s += wm[d] * x[d];
    scores[k] = s;
  }
  return scores;
}

export const labelOf = (key) => key.tonic + (key.mode === 'minor' ? 12 : 0);

// Validazione incrociata a k gruppi (per brano), deterministica.
export function crossValidate(examples, folds, train, predict) {
  const pairs = [];
  for (let f = 0; f < folds; f++) {
    const trainSet = examples.filter((_, i) => i % folds !== f);
    const testSet = examples.filter((_, i) => i % folds === f);
    const model = train(trainSet);
    for (const e of testSet) pairs.push({ est: bestKey(predict(model, e)), ref: e.key });
  }
  return keyReport(pairs);
}
