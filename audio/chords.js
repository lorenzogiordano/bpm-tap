// Accordi della canzone (maggiori e minori), sullo schema di Chordino (Mauch & Dixon 2010):
// cromagramma NNLS di basso e acuti mediato tra un battito e l'altro, punteggio dei 24
// accordi più "nessun accordo" con pesi imparati (uguali per le 12 fondamentali), poi la
// sequenza più probabile con un modello di Markov nascosto (HMM) e le probabilità a
// posteriori di ogni battito. Lo stesso codice serve all'app e al banco di prova (lab/).

import { fold } from './key.js';

export const CHORD_STATES = 25; // 0–11 maggiori (Do = 0), 12–23 minori, 24 = nessun accordo
export const NO_CHORD = 24;

// Cromagramma per battito. frames: [{ treble, bass }] (36 bin, 3 per semitono) con i
// loro istanti centrali times (s); beats: istanti dei battiti (s). Per ogni intervallo tra
// due battiti: media dei frame, normalizzata al massimo, più l'energia (log) degli acuti.
export function beatChroma(frames, times, beats, binsPerSemitone = 3) {
  const out = [];
  let j = 0;
  for (let i = 0; i + 1 < beats.length; i++) {
    const t = new Float64Array(12);
    const b = new Float64Array(12);
    let n = 0;
    while (j < times.length && times[j] < beats[i]) j += 1;
    for (let k = j; k < times.length && times[k] < beats[i + 1]; k++) {
      const ft = fold(frames[k].treble, binsPerSemitone);
      const fb = fold(frames[k].bass, binsPerSemitone);
      for (let p = 0; p < 12; p++) { t[p] += ft[p]; b[p] += fb[p]; }
      n += 1;
    }
    const tm = Math.max(...t);
    const bm = Math.max(...b);
    out.push({
      start: beats[i],
      end: beats[i + 1],
      treble: t.map((v) => (tm > 0 ? v / tm : 0)),
      bass: b.map((v) => (bm > 0 ? v / bm : 0)),
      energy: Math.log(1e-6 + (n ? t.reduce((a, v) => a + v, 0) / n : 0)),
    });
  }
  return out;
}

// Indizi di un battito, con il contesto (media del battito prima e dopo).
function blocks(beats, i) {
  const cur = beats[i];
  const prev = beats[Math.max(0, i - 1)];
  const next = beats[Math.min(beats.length - 1, i + 1)];
  const c = (v) => v.map((x) => Math.sqrt(x));
  const ctx = cur.treble.map((v, p) => Math.sqrt((prev.treble[p] + next.treble[p]) / 2));
  return [c(cur.treble), c(cur.bass), ctx];
}

// Indizi indipendenti dalla fondamentale, per "nessun accordo".
function flatness(v) {
  const mean = v.reduce((a, x) => a + x, 0) / 12;
  return mean; // valori già normalizzati al massimo: media alta = cromagramma piatto
}
export const N_FEATURES = 4;
function noChordFeatures(beat, meanEnergy) {
  return [1, beat.energy - meanEnergy, flatness(beat.treble), flatness(beat.bass)];
}

// Preferenza per gli accordi della tonalità: log P(accordo | tonalità) imparata dai dati,
// per modo (maggiore/minore), qualità dell'accordo e distanza della fondamentale dalla
// tonica. key: { tonic, mode } (stimata da S-KEY nell'app); weight: quanto conta.
export function keyBonus(key, prior, weight) {
  const out = new Float64Array(CHORD_STATES);
  if (!key || !prior || !weight) return out;
  const table = prior[key.mode === 'minor' ? 1 : 0];
  for (let s = 0; s < 24; s++) out[s] = weight * table[s < 12 ? 0 : 1][(s - key.tonic + 12) % 12];
  return out;
}

// Punteggi (log) dei 25 stati per ogni battito.
// model: { weights: { maj: [36], min: [36] }, bias: { maj, min }, none: [N_FEATURES] }
export function chordScores(beats, model, bonus = null) {
  const meanEnergy = beats.reduce((a, b) => a + b.energy, 0) / (beats.length || 1);
  return beats.map((beat, i) => {
    const x = blocks(beats, i);
    const s = new Float64Array(CHORD_STATES);
    for (let r = 0; r < 12; r++) {
      for (const [q, offset] of [['maj', 0], ['min', 12]]) {
        const w = model.weights[q];
        let v = model.bias[q];
        for (let b = 0; b < x.length; b++) for (let p = 0; p < 12; p++) v += w[b * 12 + p] * x[b][(p + r) % 12];
        s[r + offset] = v;
      }
    }
    const f = noChordFeatures(beat, meanEnergy);
    s[NO_CHORD] = f.reduce((a, v, k) => a + v * model.none[k], 0);
    if (bonus) for (let k = 0; k < 24; k++) s[k] += bonus[k];
    return s;
  });
}

export function chordFeatures(beats, i) {
  const meanEnergy = beats.reduce((a, b) => a + b.energy, 0) / (beats.length || 1);
  return { blocks: blocks(beats, i), none: noChordFeatures(beats[i], meanEnergy) };
}

// Probabilità di passaggio (log) da uno stato all'altro: resta con probabilità `stay`,
// altrimenti cambia secondo change[qualità di partenza][qualità d'arrivo][intervallo di
// fondamentale] (imparato dai dati, uguale per tutte le fondamentali).
export function transitionMatrix({ stay, change, toNone }) {
  const T = Array.from({ length: CHORD_STATES }, () => new Float64Array(CHORD_STATES));
  for (let a = 0; a < CHORD_STATES; a++) {
    for (let b = 0; b < CHORD_STATES; b++) {
      let p;
      if (a === b) p = stay;
      else if (a === NO_CHORD) p = (1 - stay) / 24;
      else if (b === NO_CHORD) p = (1 - stay) * toNone;
      else {
        const qa = a < 12 ? 0 : 1;
        const qb = b < 12 ? 0 : 1;
        p = (1 - stay) * (1 - toNone) * change[qa][qb][(b - a + 24) % 12];
      }
      T[a][b] = Math.log(Math.max(p, 1e-9));
    }
  }
  return T;
}

// Viterbi (sequenza più probabile) e avanti-indietro (probabilità di ogni stato per battito).
// scores: punteggi log di emissione per battito; T: matrice log di transizione.
export function decode(scores, T) {
  const n = scores.length;
  if (!n) return { path: [], posteriors: [] };
  const S = CHORD_STATES;
  // Viterbi
  let delta = Float64Array.from(scores[0]);
  const back = [];
  for (let i = 1; i < n; i++) {
    const next = new Float64Array(S);
    const arg = new Int16Array(S);
    for (let b = 0; b < S; b++) {
      let best = -Infinity;
      let bestA = 0;
      for (let a = 0; a < S; a++) {
        const v = delta[a] + T[a][b];
        if (v > best) { best = v; bestA = a; }
      }
      next[b] = best + scores[i][b];
      arg[b] = bestA;
    }
    back.push(arg);
    delta = next;
  }
  const path = new Array(n);
  path[n - 1] = delta.indexOf(Math.max(...delta));
  for (let i = n - 1; i > 0; i--) path[i - 1] = back[i - 1][path[i]];
  // Avanti-indietro in dominio log.
  const lse = (arr) => { const m = Math.max(...arr); return m + Math.log(arr.reduce((a, v) => a + Math.exp(v - m), 0)); };
  const alpha = [Float64Array.from(scores[0])];
  for (let i = 1; i < n; i++) {
    const cur = new Float64Array(S);
    for (let b = 0; b < S; b++) {
      const terms = new Float64Array(S);
      for (let a = 0; a < S; a++) terms[a] = alpha[i - 1][a] + T[a][b];
      cur[b] = lse(terms) + scores[i][b];
    }
    alpha.push(cur);
  }
  const beta = new Array(n);
  beta[n - 1] = new Float64Array(S);
  for (let i = n - 2; i >= 0; i--) {
    const cur = new Float64Array(S);
    for (let a = 0; a < S; a++) {
      const terms = new Float64Array(S);
      for (let b = 0; b < S; b++) terms[b] = T[a][b] + scores[i + 1][b] + beta[i + 1][b];
      cur[a] = lse(terms);
    }
    beta[i] = cur;
  }
  const posteriors = alpha.map((al, i) => {
    const v = al.map((x, s) => x + beta[i][s]);
    const z = lse(v);
    return v.map((x) => Math.exp(x - z));
  });
  return { path, posteriors };
}

// Quota di tempo di ogni accordo (dalle probabilità a posteriori, pesate con la durata dei
// battiti): { chord, share } in ordine decrescente, senza "nessun accordo".
export function chordShares(beats, posteriors) {
  const total = new Float64Array(CHORD_STATES);
  let sum = 0;
  beats.forEach((b, i) => {
    const d = b.end - b.start;
    for (let s = 0; s < CHORD_STATES; s++) total[s] += d * posteriors[i][s];
    sum += d;
  });
  const out = [];
  for (let s = 0; s < 24; s++) if (total[s] > 0) out.push({ chord: s, share: total[s] / (sum || 1) });
  return out.sort((a, b) => b.share - a.share);
}
