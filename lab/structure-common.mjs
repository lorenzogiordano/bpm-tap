// Strumenti comuni delle prove sulla struttura: probabilità degli accordi con il modello
// dell'app, metriche delle sezioni come mir_eval (confini entro 0,5 e 3 s, F a coppie).

import { readFileSync } from 'node:fs';
import { chordScores, transitionMatrix, decode, keyBonus } from '../audio/chords.js';

const chordModel = JSON.parse(readFileSync(new URL('../audio/chord-model.json', import.meta.url), 'utf8'));
const T = transitionMatrix(chordModel.transitions);

// Probabilità degli accordi per battito, come nell'app (tonalità come preferenza, HMM).
export function posteriorsFor(beats, key) {
  const bonus = keyBonus(key, chordModel.keyPrior, chordModel.keyWeight);
  const t = chordModel.temperature || 1;
  const scores = chordScores(beats, chordModel.emission, bonus).map((row) => row.map((x) => x / t));
  return decode(scores, T);
}

// Confini trovati entro `window` secondi da quelli veri (accoppiamento uno a uno, dal più
// vicino). trim: senza il primo e l'ultimo confine (inizio e fine del brano), come mir_eval.
export function boundaryF(ref, est, window, trim = true) {
  const r = trim ? ref.slice(1, -1) : ref;
  const e = trim ? est.slice(1, -1) : est;
  if (!r.length && !e.length) return { p: 1, r: 1, f: 1, hits: 0, nRef: 0, nEst: 0 };
  const pairs = [];
  r.forEach((x, i) => e.forEach((y, j) => { const d = Math.abs(x - y); if (d <= window) pairs.push([d, i, j]); }));
  pairs.sort((a, b) => a[0] - b[0]);
  const usedR = new Set();
  const usedE = new Set();
  let hits = 0;
  for (const [, i, j] of pairs) {
    if (usedR.has(i) || usedE.has(j)) continue;
    usedR.add(i); usedE.add(j); hits += 1;
  }
  const p = e.length ? hits / e.length : 0;
  const rc = r.length ? hits / r.length : 0;
  return { p, r: rc, f: p + rc ? (2 * p * rc) / (p + rc) : 0, hits, nRef: r.length, nEst: e.length };
}

// Etichetta a ogni istante (passo `hop`) da una lista di sezioni { start, end, label }.
function frameLabels(sections, from, to, hop) {
  const out = [];
  let k = 0;
  for (let t = from; t < to; t += hop) {
    while (k < sections.length && sections[k].end <= t) k += 1;
    out.push(k < sections.length && sections[k].start <= t ? sections[k].label : null);
  }
  return out;
}

// F a coppie (Levy & Sandler): tra tutte le coppie di istanti, quelle con la stessa etichetta.
export function pairwiseF(refSections, estSections, hop = 0.25) {
  const from = Math.max(refSections[0].start, estSections[0].start);
  const to = Math.min(refSections[refSections.length - 1].end, estSections[estSections.length - 1].end);
  const a = frameLabels(refSections, from, to, hop);
  const b = frameLabels(estSections, from, to, hop);
  const pairsOf = (counts) => [...counts.values()].reduce((s, n) => s + (n * (n - 1)) / 2, 0);
  const ca = new Map();
  const cb = new Map();
  const cab = new Map();
  for (let i = 0; i < a.length; i++) {
    if (a[i] === null || b[i] === null) continue;
    ca.set(a[i], (ca.get(a[i]) || 0) + 1);
    cb.set(b[i], (cb.get(b[i]) || 0) + 1);
    const k = `${a[i]}\u0000${b[i]}`;
    cab.set(k, (cab.get(k) || 0) + 1);
  }
  const both = pairsOf(cab);
  const p = pairsOf(cb) ? both / pairsOf(cb) : 0;
  const r = pairsOf(ca) ? both / pairsOf(ca) : 0;
  return { p, r, f: p + r ? (2 * p * r) / (p + r) : 0 };
}

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
export const pct = (x) => Math.round(1000 * x) / 10;

// Battute annotate che iniziano entro ogni sezione: lunghezza delle sezioni in battute.
export function sectionBars(song) {
  return song.sections.map((sec) => song.bars.filter((b) => b.start >= sec.start - 0.05 && b.start < sec.end - 0.05).length);
}

// Preferenza per la lunghezza delle sezioni: log P(lunghezza in battute), 1–32, contata sui
// brani dati (lisciatura additiva).
export function lengthPrior(list, smoothing = 0.5) {
  const counts = {};
  let total = 0;
  for (const s of list) for (const n of sectionBars(s)) { if (n > 0 && n <= 64) { counts[n] = (counts[n] || 0) + 1; total += 1; } }
  const out = {};
  for (let n = 1; n <= 32; n++) out[n] = Math.round(Math.log(((counts[n] || 0) + smoothing) / (total + 64 * smoothing)) * 100) / 100;
  return out;
}
