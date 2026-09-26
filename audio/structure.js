// Struttura della canzone: battute, sezioni (A, B, C…) e giro di ogni sezione. Tutto a
// livello di battuta, con elaborazione del segnale classica: non esiste un modello piccolo e
// con licenza libera che giri su un telefono. Numeri e prove in lab/structure-*.mjs.
//
// 1. Battute: modello di Markov sulla posizione del battito nella battuta, osservando i cambi
//    d'accordo (il primo battito è dove cambiano più spesso). Solo 4/4: il 3/4 riconosciuto
//    così è giusto 4 volte su 10.
// 2. Indizi per battuta: cromagramma di basso e acuti e probabilità degli accordi per mezza
//    battuta, volume e timbro (coefficienti cepstrali delle bande mel del tracciatore del tempo:
//    quando cambiano gli strumenti cambia la sezione).
// 3. Matrice di somiglianza tra battute (coseno sugli indizi centrati; volume con una gaussiana).
// 4. Confini: novità di Foote (blocchi omogenei) più novità delle ripetizioni di Serrà et al.
//    (dove comincia un passaggio che torna altrove), poi programmazione dinamica con la
//    preferenza per le lunghezze tipiche delle sezioni contate su Billboard (8, 16, 4…
//    battute) e una rifinitura di una battuta sul contrasto immediato.
// 5. Lettere: le sezioni che si somigliano lungo la diagonale (stessa successione) prendono la
//    stessa lettera (raggruppamento agglomerativo); le ripetizioni che poi non vanno d'accordo
//    con il giro della lettera diventano una variante (A′).
// 6. Ruoli (strofa, ritornello…): modello dell'ordine delle sezioni imparato su Billboard più
//    indizi (quante volte torna, volume, lunghezza, posizione), come RefraiD (Goto 2006). Con le
//    sezioni trovate qui il ritornello è giusto circa una volta su due: i nomi sono spenti
//    (SHOW.names) e l'app mostra solo le lettere.

import { NO_CHORD } from './chords.js';
import { barUnits, unitsPerBar, meanLog, sectionProgression } from './progressions.js';

// ---------- Battute ----------

// Quanto cambia l'accordo da un battito al successivo: 1 − Σc P_(i−1)(c)·P_i(c).
export function changeCurve(posteriors) {
  return posteriors.map((p, i) => {
    if (!i) return 0;
    let s = 0;
    for (let c = 0; c < p.length; c++) s += p[c] * posteriors[i - 1][c];
    return 1 - s;
  });
}

// Primo battito della battuta: modello di Markov sulla posizione del battito nella battuta
// (0 = primo). Di solito si avanza di uno; con probabilità `jump` la posizione salta (una
// battuta di 2/4, un battito perso dal tracciatore). Osservazione: il cambio d'accordo c del
// battito, con P(cambio | posizione) misurata su Billboard (lab/structure-eval.mjs downbeats):
// 0,41 sul primo battito, 0,14 sul secondo, 0,20 sul terzo, 0,27 sul quarto.
export const CHANGE_RATE = { 4: [0.41, 0.14, 0.2, 0.27], 3: [0.41, 0.15, 0.22] };

export function trackDownbeats(posteriors, meter = 4, { jump = 0.01, rates = CHANGE_RATE } = {}) {
  const change = changeCurve(posteriors);
  const a = rates[meter];
  const n = change.length;
  if (!n) return { meter, starts: [], logLik: 0 };
  const stay = Math.log(1 - jump);
  const hop = Math.log(jump / Math.max(1, meter - 1));
  let delta = new Float64Array(meter).fill(-Math.log(meter));
  const back = [];
  const emit = (c, s) => Math.log(c * a[s] + (1 - c) * (1 - a[s]));
  for (let s = 0; s < meter; s++) delta[s] += emit(change[0], s);
  for (let i = 1; i < n; i++) {
    const next = new Float64Array(meter);
    const arg = new Int8Array(meter);
    for (let s = 0; s < meter; s++) {
      let best = -Infinity;
      for (let r = 0; r < meter; r++) {
        const v = delta[r] + ((r + 1) % meter === s ? stay : hop);
        if (v > best) { best = v; arg[s] = r; }
      }
      next[s] = best + emit(change[i], s);
    }
    back.push(arg);
    delta = next;
  }
  const pos = new Array(n);
  pos[n - 1] = delta.indexOf(Math.max(...delta));
  for (let i = n - 1; i > 0; i--) pos[i - 1] = back[i - 1][pos[i]];
  const starts = [];
  pos.forEach((s, i) => { if (s === 0) starts.push(i); });
  return { meter, starts, logLik: Math.max(...delta) / n };
}

// Metro e primi battiti: 4/4 salvo che il 3/4 spieghi i cambi nettamente meglio.
export function findDownbeats(posteriors, { meters = [4], threeMargin = 0.1, jump = 0.01 } = {}) {
  let best = trackDownbeats(posteriors, 4, { jump });
  if (meters.includes(3)) {
    const three = trackDownbeats(posteriors, 3, { jump });
    if (three.logLik > best.logLik + threeMargin) best = three;
  }
  return best;
}

// Battute dai primi battiti: da un primo battito al successivo (le battute troppo corte o
// troppo lunghe per un salto di fase restano come sono). I battiti prima del primo diventano
// una battuta incompleta se sono almeno due (spesso il tracciatore perde il primo battito del
// brano: senza questa battuta tutta la griglia delle sezioni scivolerebbe di una battuta).
export function makeBars(nBeats, starts, meter) {
  const bars = [];
  if (starts.length && starts[0] >= 2) bars.push({ from: 0, to: starts[0] });
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : Math.min(nBeats, from + meter);
    if (to - from >= 2 || k + 1 < starts.length) bars.push({ from, to });
  }
  // L'ultima battuta, se incompleta, non entra.
  if (bars.length && bars[bars.length - 1].to - bars[bars.length - 1].from < meter && bars[bars.length - 1].to >= nBeats) bars.pop();
  return bars;
}

// ---------- Indizi e somiglianza ----------

// Timbro per battito: coefficienti cepstrali (come gli MFCC, senza il primo che è il volume)
// dalle bande mel medie del tracciatore del tempo. spectra: bande (log) ogni `step` secondi a
// partire da t0; beats: { start, end }.
export function beatTimbre(spectra, step, beats, coefficients = 12, t0 = 0) {
  if (!spectra.length) return null;
  const bands = spectra[0].length;
  const dct = Array.from({ length: coefficients }, (_, k) => Float64Array.from({ length: bands }, (__, b) => Math.cos((Math.PI * (k + 1) * (b + 0.5)) / bands)));
  return beats.map((beat) => {
    const from = Math.max(0, Math.floor((beat.start - t0) / step));
    const to = Math.min(spectra.length, Math.max(from + 1, Math.ceil((beat.end - t0) / step)));
    const mean = new Float64Array(bands);
    for (let i = from; i < to; i++) for (let b = 0; b < bands; b++) mean[b] += spectra[i][b] / Math.max(1, to - from);
    return dct.map((row) => row.reduce((a, w, b) => a + w * mean[b], 0));
  });
}

// Volume per battito (dB) dal valore efficace dei frame del cromagramma: rms e times per frame,
// beats come quelli di beatChroma ({ start, end }).
export function beatLoudness(rms, times, beats) {
  let j = 0;
  return beats.map((b) => {
    while (j < times.length && times[j] < b.start) j += 1;
    let e = 0;
    let n = 0;
    for (let k = j; k < times.length && times[k] < b.end; k++) { e += rms[k] * rms[k]; n += 1; }
    return 10 * Math.log10((n ? e / n : 0) + 1e-10);
  });
}

function unitChroma(beats, from, to) {
  const t = new Float64Array(12);
  const b = new Float64Array(12);
  const n = Math.max(1, to - from);
  for (let i = from; i < to; i++) {
    for (let p = 0; p < 12; p++) { t[p] += Math.sqrt(beats[i].treble[p]) / n; b[p] += Math.sqrt(beats[i].bass[p]) / n; }
  }
  return [t, b];
}

// Indizi di ogni battuta: blocchi separati (cromagramma, accordi, timbro) e volume.
// timbre: per battito un vettore (facoltativo), mediato sulla battuta.
export function barFeatures(beats, posteriors, bars, meter, loudness, timbre = null) {
  const upb = unitsPerBar(meter);
  const units = barUnits(posteriors, bars, meter);
  return bars.map((bar, k) => {
    const chroma = [];
    const chords = [];
    for (let h = 0; h < upb; h++) {
      const u = units[k * upb + h];
      const [t, b] = unitChroma(beats, u.from, u.to);
      chroma.push(...t, ...b);
      chords.push(...Array.from(u.p).slice(0, NO_CHORD));
    }
    let loud = 0;
    for (let i = bar.from; i < bar.to; i++) loud += (loudness ? loudness[i] : beats[i].energy) / (bar.to - bar.from);
    let tim = null;
    if (timbre) {
      tim = new Float64Array(timbre[0].length);
      for (let i = bar.from; i < bar.to; i++) for (let d = 0; d < tim.length; d++) tim[d] += timbre[i][d] / (bar.to - bar.from);
    }
    return { chroma: Float64Array.from(chroma), chords: Float64Array.from(chords), loud, timbre: tim };
  });
}

// Coseno tra vettori centrati sulla media del brano, con l'incorporamento di `embed` battute.
function cosineMatrix(vectors, embed) {
  const n = vectors.length;
  const dim = vectors[0].length;
  const mean = new Float64Array(dim);
  for (const v of vectors) for (let d = 0; d < dim; d++) mean[d] += v[d] / n;
  const x = vectors.map((_, k) => {
    const out = new Float64Array(dim * embed);
    for (let e = 0; e < embed; e++) {
      const v = vectors[Math.min(n - 1, k + e)];
      for (let d = 0; d < dim; d++) out[e * dim + d] = v[d] - mean[d];
    }
    let norm = 0;
    for (const val of out) norm += val * val;
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < out.length; d++) out[d] /= norm;
    return out;
  });
  const S = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let s = 0;
      const a = x[i];
      const b = x[j];
      for (let d = 0; d < a.length; d++) s += a[d] * b[d];
      S[i][j] = s;
      S[j][i] = s;
    }
  }
  return S;
}

// Ogni dimensione a media 0 e varianza 1 sul brano (per il timbro, dove le scale sono diverse).
function zscore(vectors) {
  const n = vectors.length;
  const dim = vectors[0].length;
  const mean = new Float64Array(dim);
  const sd = new Float64Array(dim);
  for (const v of vectors) for (let d = 0; d < dim; d++) mean[d] += v[d] / n;
  for (const v of vectors) for (let d = 0; d < dim; d++) sd[d] += (v[d] - mean[d]) ** 2 / n;
  return vectors.map((v) => Float64Array.from(v, (x, d) => (x - mean[d]) / (Math.sqrt(sd[d]) || 1)));
}

// Matrice di somiglianza combinata: cromagramma, accordi, volume (pesi in `weights`), poi
// lisciata lungo le diagonali (media su 2·smooth+1 battute).
export function similarity(features, { weights = { chroma: 1, chords: 1, loud: 0.5 }, embed = 2, smooth = 2, loudSigma = 3 } = {}) {
  const n = features.length;
  const blocks = [];
  if (weights.chroma) blocks.push([weights.chroma, cosineMatrix(features.map((f) => f.chroma), embed)]);
  if (weights.chords) blocks.push([weights.chords, cosineMatrix(features.map((f) => f.chords), embed)]);
  if (weights.timbre && features[0].timbre) blocks.push([weights.timbre, cosineMatrix(zscore(features.map((f) => f.timbre)), embed)]);
  if (weights.loud) {
    const L = Array.from({ length: n }, (_, i) => Float64Array.from({ length: n }, (__, j) => 2 * Math.exp(-0.5 * ((features[i].loud - features[j].loud) / loudSigma) ** 2) - 1));
    blocks.push([weights.loud, L]);
  }
  const total = blocks.reduce((a, [w]) => a + w, 0) || 1;
  const S = Array.from({ length: n }, () => new Float64Array(n));
  for (const [w, M] of blocks) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) S[i][j] += (w * M[i][j]) / total;
  if (!smooth) return S;
  const out = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      let c = 0;
      for (let d = -smooth; d <= smooth; d++) {
        const a = i + d;
        const b = j + d;
        if (a < 0 || b < 0 || a >= n || b >= n) continue;
        s += S[a][b];
        c += 1;
      }
      out[i][j] = s / c;
    }
  }
  return out;
}

// ---------- Confini ----------

// Novità di Foote (2000): un nucleo a scacchiera gaussiano di 2·w battute lungo la diagonale
// della matrice. Alta dove finisce un blocco di battute simili e ne comincia un altro.
export function footeNovelty(S, w = 6) {
  const n = S.length;
  const out = new Float64Array(n);
  const sigma = w / 2;
  for (let i = 0; i < n; i++) {
    let v = 0;
    let z = 0;
    for (let a = -w; a < w; a++) {
      const x = i + a;
      if (x < 0 || x >= n) continue;
      for (let b = -w; b < w; b++) {
        const y = i + b;
        if (y < 0 || y >= n) continue;
        const g = Math.exp(-0.5 * (((a + 0.5) / sigma) ** 2 + ((b + 0.5) / sigma) ** 2));
        v += ((a < 0) === (b < 0) ? g : -g) * S[x][y];
        z += g;
      }
    }
    out[i] = z ? v / z : 0;
  }
  return normalizeNovelty(out);
}

// Novità delle "strutture" di Serrà et al. (2014): per ogni battuta, dove si ripete (vicini
// più simili, reciproci) in funzione della distanza; lisciato nel tempo, il cambio di questo
// profilo segna l'inizio di un passaggio ripetuto in un altro punto del brano.
export function repetitionNovelty(S, { k = null, sigma = 2 } = {}) {
  const n = S.length;
  const kk = k || Math.max(4, Math.min(12, Math.round(n / 10)));
  const near = S.map((row, i) => new Set(Array.from(row, (v, j) => [v, j]).filter(([, j]) => Math.abs(j - i) > 1).sort((x, y) => y[0] - x[0]).slice(0, kk).map(([, j]) => j)));
  const lag = Array.from({ length: n }, (_, i) => Float64Array.from({ length: n }, (__, l) => {
    const j = (i + l) % n;
    return near[i].has(j) && near[j].has(i) ? 1 : 0;
  }));
  const radius = Math.ceil(3 * sigma);
  const smooth = lag.map((_, i) => {
    const out = new Float64Array(n);
    let z = 0;
    for (let d = -radius; d <= radius; d++) {
      const x = i + d;
      if (x < 0 || x >= n) continue;
      const g = Math.exp(-0.5 * (d / sigma) ** 2);
      z += g;
      for (let l = 0; l < n; l++) out[l] += g * lag[x][l];
    }
    return out.map((v) => v / z);
  });
  const out = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    let v = 0;
    for (let l = 0; l < n; l++) v += (smooth[i][l] - smooth[i - 1][l]) ** 2;
    out[i] = v;
  }
  return normalizeNovelty(out);
}

function normalizeNovelty(v) {
  let m = 0;
  for (const x of v) m = Math.max(m, x);
  return Float64Array.from(v, (x) => (m > 0 ? Math.max(0, x) / m : 0));
}

// Preferenza per la lunghezza delle sezioni (in battute): log P(lunghezza) contata su
// Billboard; le lunghezze mai viste costano `floor`.
function lengthLog(len, prior, floor) {
  const v = prior ? prior[len] : undefined;
  return v === undefined || v === null ? floor : v;
}

// Confini: programmazione dinamica che massimizza Σ novità ai confini + λ·Σ log P(lunghezza).
// Restituisce gli indici di battuta dove iniziano le sezioni (0 compreso).
export function segmentBars(novelty, { lambda = 0.2, maxLen = 32, lengthPrior = null, floor = -8 } = {}) {
  const n = novelty.length;
  const best = new Float64Array(n + 1).fill(-Infinity);
  const back = new Int32Array(n + 1).fill(-1);
  best[0] = 0;
  for (let b = 1; b <= n; b++) {
    for (let a = Math.max(0, b - maxLen); a < b; a++) {
      if (best[a] === -Infinity) continue;
      const v = best[a] + (a > 0 ? novelty[a] : 0) + lambda * lengthLog(b - a, lengthPrior, floor);
      if (v > best[b]) { best[b] = v; back[b] = a; }
    }
  }
  const starts = [];
  for (let b = n; b > 0; b = back[b]) starts.push(back[b]);
  return starts.reverse();
}

// ---------- Lettere ----------

// Somiglianza tra due sezioni: media lungo la diagonale (stessa successione, allineata
// all'inizio), la migliore tra piccoli spostamenti di una battuta.
export function segmentSimilarity(S, a, b, shifts = 1) {
  const la = a.end - a.start;
  const lb = b.end - b.start;
  const len = Math.min(la, lb);
  let best = -Infinity;
  for (let o = -shifts; o <= shifts; o++) {
    let s = 0;
    let c = 0;
    for (let k = 0; k < len; k++) {
      const i = a.start + k;
      const j = b.start + k + o;
      if (j < b.start || j >= b.end || i >= a.end) continue;
      s += S[i][j];
      c += 1;
    }
    if (c >= Math.max(2, len / 2)) best = Math.max(best, s / c);
  }
  return best;
}

// Raggruppamento agglomerativo (media dei legami) con soglia; lettere per prima comparsa.
export function groupSegments(S, segments, { threshold = 0.35, shifts = 1 } = {}) {
  const k = segments.length;
  const sim = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (__, j) => (i === j ? 1 : segmentSimilarity(S, segments[i], segments[j], shifts))));
  let clusters = segments.map((_, i) => [i]);
  for (;;) {
    let bestPair = null;
    let bestValue = threshold;
    for (let x = 0; x < clusters.length; x++) {
      for (let y = x + 1; y < clusters.length; y++) {
        let s = 0;
        for (const i of clusters[x]) for (const j of clusters[y]) s += sim[i][j];
        s /= clusters[x].length * clusters[y].length;
        if (s > bestValue) { bestValue = s; bestPair = [x, y]; }
      }
    }
    if (!bestPair) break;
    const [x, y] = bestPair;
    clusters[x] = [...clusters[x], ...clusters[y]];
    clusters = clusters.filter((_, i) => i !== y);
  }
  const clusterOf = new Array(k);
  clusters.forEach((c, id) => c.forEach((i) => { clusterOf[i] = id; }));
  const letterOf = new Map();
  return segments.map((s, i) => {
    if (!letterOf.has(clusterOf[i])) letterOf.set(clusterOf[i], String.fromCharCode(65 + letterOf.size));
    return { ...s, letter: letterOf.get(clusterOf[i]) };
  });
}

// ---------- Tutto insieme ----------

export const STRUCTURE_DEFAULTS = {
  embed: 1,                 // battute per vettore (con 2 i confini arrivano una battuta prima)
  smooth: 1,                // lisciatura lungo le diagonali, ± battute
  weights: { chroma: 1, chords: 1, loud: 0.5, timbre: 1 }, // il timbro vale solo se c'è
  foote: 6,                 // metà del nucleo di Foote, in battute
  mix: 0.5,                 // peso della novità delle ripetizioni rispetto a Foote
  sigma: 2,
  lambda: 0.2,              // peso della preferenza di lunghezza
  maxLen: 32,
  threshold: 0.3,           // somiglianza minima per dare la stessa lettera
  shifts: 1,
  mergeBelow: 0.3,          // due sezioni vicine con la stessa lettera si uniscono se il confine è debole
  refine: 2,                // rifinitura dei confini (metà del nucleo, in battute; 0 = no)
  refineRatio: 1.5,         // … solo se il contrasto accanto è almeno così più forte
};

// Quanto si somigliano le ripetizioni della stessa lettera (media lungo la diagonale): su
// Billboard è l'indizio che predice meglio una struttura giusta (lab/structure-eval.mjs).
export function withinSimilarity(S, sections) {
  let sum = 0;
  let n = 0;
  const byLetter = {};
  for (const sec of sections) (byLetter[sec.letter] ||= []).push(sec);
  for (const list of Object.values(byLetter)) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const v = segmentSimilarity(S, list[i], list[j]);
        if (Number.isFinite(v)) { sum += v; n += 1; }
      }
    }
  }
  return n ? sum / n : 0;
}

// Sezioni consecutive con la stessa lettera e un confine debole (novità < soglia) diventano una.
export function mergeRepeats(sections, below = 0.3) {
  const out = [];
  for (const sec of sections) {
    const last = out[out.length - 1];
    if (last && last.letter === sec.letter && sec.novelty < below) last.end = sec.end;
    else out.push({ ...sec });
  }
  return out;
}

// beats: cromagramma per battito (chords.js beatChroma); posteriors: probabilità degli
// accordi per battito; loudness: volume per battito in dB (facoltativo).
export function analyzeBars(beats, posteriors, loudness, options = {}) {
  const cfg = { ...STRUCTURE_DEFAULTS, ...options };
  const down = cfg.downbeats || findDownbeats(posteriors, cfg);
  const bars = makeBars(beats.length, down.starts, down.meter);
  if (bars.length < 8) return null;
  const features = barFeatures(beats, posteriors, bars, down.meter, loudness, cfg.timbre || null);
  const raw = similarity(features, { ...cfg, smooth: 0 });
  const S = cfg.smooth ? similarity(features, cfg) : raw;
  const foote = footeNovelty(raw, cfg.foote);
  const rep = repetitionNovelty(S, { sigma: cfg.sigma });
  const novelty = foote.map((v, i) => (1 - cfg.mix) * v + cfg.mix * rep[i]);
  let starts = segmentBars(novelty, cfg);
  // Rifinitura: ogni confine si sposta di una battuta se lì il contrasto immediato (Foote con
  // un nucleo di 2 battute, sulla matrice non lisciata) è più forte. La novità lisciata e la
  // preferenza per le lunghezze tipiche sbagliano spesso proprio di una battuta.
  if (cfg.refine) {
    const sharp = footeNovelty(raw, cfg.refine);
    starts = starts.map((b, i) => {
      if (!i) return b;
      let best = b;
      for (const c of [b - 1, b + 1]) if (c > starts[i - 1] && (i + 1 >= starts.length || c < starts[i + 1]) && sharp[c] > cfg.refineRatio * sharp[best]) best = c;
      return best;
    });
  }
  const segments = starts.map((start, i) => ({ start, end: i + 1 < starts.length ? starts[i + 1] : bars.length, novelty: novelty[start] }));
  const grouped = mergeRepeats(groupSegments(S, segments, cfg), cfg.mergeBelow);
  return { meter: down.meter, bars, features, S, novelty, sections: grouped, within: withinSimilarity(S, grouped) };
}

export { meanLog };

// ---------- Ruoli delle sezioni ----------

export const ROLES = ['intro', 'verse', 'prechorus', 'chorus', 'bridge', 'instrumental', 'outro', 'other'];

// Indizi di ogni sezione per il ruolo: volume rispetto al brano (z), posizione, lunghezza,
// quante volte torna la sua lettera, se è la lettera che torna più spesso, se è la prima o
// l'ultima sezione, se è la prima volta della sua lettera.
export function sectionCues(sections, features) {
  const n = features.length;
  const louds = features.map((f) => f.loud);
  const mu = louds.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(louds.reduce((a, b) => a + (b - mu) ** 2, 0) / n) || 1;
  const count = {};
  const letterLoud = {};
  const seen = new Set();
  const sectionLoud = sections.map((s) => {
    let v = 0;
    for (let k = s.start; k < s.end; k++) v += louds[k];
    return (v / Math.max(1, s.end - s.start) - mu) / sd;
  });
  sections.forEach((s, i) => {
    count[s.letter] = (count[s.letter] || 0) + 1;
    letterLoud[s.letter] = (letterLoud[s.letter] || 0) + sectionLoud[i];
  });
  for (const l of Object.keys(letterLoud)) letterLoud[l] /= count[l];
  const maxCount = Math.max(...Object.values(count));
  return sections.map((s, i) => {
    const firstOf = !seen.has(s.letter);
    seen.add(s.letter);
    return {
      loud: sectionLoud[i],
      letterLoud: letterLoud[s.letter],
      pos: (s.start + s.end) / 2 / n,
      len: Math.log2(Math.max(1, s.end - s.start)),
      count: Math.min(4, count[s.letter]),
      top: count[s.letter] === maxCount && maxCount > 1,
      first: i === 0,
      last: i === sections.length - 1,
      firstOf,
    };
  });
}

const gauss = ([m, s], x) => -0.5 * ((x - m) / s) ** 2 - Math.log(s);

// log P(indizi | ruolo), bayesiano ingenuo con i parametri di model.emission.
export function roleLogLik(model, cue, r) {
  const e = model.emission;
  let v = gauss(e.loud[r], cue.loud) + gauss(e.letterLoud[r], cue.letterLoud) + gauss(e.pos[r], cue.pos) + gauss(e.len[r], cue.len);
  v += Math.log(e.count[r][cue.count - 1]);
  for (const flag of ['top', 'first', 'last', 'firstOf']) v += Math.log(e[flag][r][cue[flag] ? 1 : 0]);
  return v;
}

// Ruoli più probabili (Viterbi) e probabilità di ogni ruolo per sezione (avanti-indietro),
// con l'ordine delle sezioni (model.start, model.trans, model.end: log) imparato su Billboard.
export function nameSections(cues, model) {
  const R = model.roles.length;
  const n = cues.length;
  if (!n) return { roles: [], posteriors: [] };
  const emit = cues.map((c) => Array.from({ length: R }, (_, r) => roleLogLik(model, c, r)));
  const lse = (arr) => { const m = Math.max(...arr); return m + Math.log(arr.reduce((a, v) => a + Math.exp(v - m), 0)); };
  // Viterbi
  let delta = emit[0].map((v, r) => v + model.start[r]);
  const back = [];
  for (let i = 1; i < n; i++) {
    const arg = new Array(R);
    delta = Array.from({ length: R }, (_, r) => {
      let best = -Infinity;
      for (let q = 0; q < R; q++) { const v = delta[q] + model.trans[q][r]; if (v > best) { best = v; arg[r] = q; } }
      return best + emit[i][r];
    });
    back.push(arg);
  }
  const last = delta.map((v, r) => v + model.end[r]);
  const path = new Array(n);
  path[n - 1] = last.indexOf(Math.max(...last));
  for (let i = n - 1; i > 0; i--) path[i - 1] = back[i - 1][path[i]];
  // Avanti-indietro
  const alpha = [emit[0].map((v, r) => v + model.start[r])];
  for (let i = 1; i < n; i++) alpha.push(Array.from({ length: R }, (_, r) => lse(alpha[i - 1].map((a, q) => a + model.trans[q][r])) + emit[i][r]));
  const beta = new Array(n);
  beta[n - 1] = model.end.slice();
  for (let i = n - 2; i >= 0; i--) beta[i] = Array.from({ length: R }, (_, q) => lse(Array.from({ length: R }, (__, r) => model.trans[q][r] + emit[i + 1][r] + beta[i + 1][r])));
  const posteriors = alpha.map((a, i) => {
    const v = a.map((x, r) => x + beta[i][r]);
    const z = lse(v);
    return v.map((x) => Math.exp(x - z));
  });
  return { roles: path.map((r) => model.roles[r]), posteriors };
}

// Affidabilità dei nomi: la lettera più probabile come ritornello (media della probabilità di
// "ritornello" sulle sue sezioni) contro la seconda.
export function chorusMargin(sections, posteriors, roles = ROLES) {
  const ci = roles.indexOf('chorus');
  const byLetter = {};
  sections.forEach((s, i) => { (byLetter[s.letter] ||= []).push(posteriors[i][ci]); });
  const scores = Object.entries(byLetter).map(([letter, ps]) => ({ letter, p: ps.reduce((a, b) => a + b, 0) / ps.length, count: ps.length })).sort((a, b) => b.p - a.p);
  return { ...scores[0], margin: scores[0].p - (scores[1] ? scores[1].p : 0) };
}

// Quando mostrare. Lettere: brano di almeno 60 s e 24 battute, almeno due sezioni, e le
// ripetizioni della stessa lettera simili in media almeno 0,45 (su Billboard restano 3 brani su
// 4, con confini e lettere un po' più giusti: lab/structure-eval.mjs). Nomi (strofa,
// ritornello…): spenti. Con le sezioni trovate dall'app il ritornello nominato è giusto circa
// una volta su due anche nei casi più netti (lab/structure-names.mjs); names: true li riaccende
// con un margine ≥ namesMargin sulla seconda lettera, che torni almeno due volte, brano ≥ 90 s.
export const SHOW = { minSeconds: 60, minBars: 24, minWithin: 0.45, names: false, namesMargin: 0.5, namesSeconds: 90 };

const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

// Struttura completa per l'app: sezioni con lettera (ed eventuale ruolo), giro di ogni
// lettera, giro dell'intero brano. models: { structure: structure-model.json,
// progressions: progression-model.json }. null se non c'è abbastanza per dirlo.
export function songStructure({ beats, posteriors, loudness = null, key = null, timbre = null }, models, options = {}) {
  const show = { ...SHOW, ...(options.show || {}) };
  if (!beats || beats.length < 32) return null;
  const seconds = beats[beats.length - 1].end - beats[0].start;
  if (seconds < show.minSeconds) return null;
  const r = analyzeBars(beats, posteriors, loudness, { lengthPrior: models.structure?.lengthPrior, timbre, ...options });
  if (!r || r.bars.length < show.minBars) return null;
  const upb = unitsPerBar(r.meter);
  const units = barUnits(posteriors, r.bars, r.meter).map((u) => u.p);
  const time0 = (k) => beats[r.bars[k].from].start;
  const time1 = (k) => beats[r.bars[k].to - 1].end;
  const counts = {};
  for (const sec of r.sections) counts[sec.letter] = (counts[sec.letter] || 0) + 1;
  const repeated = Object.values(counts).some((c) => c >= 2);
  // Giro di ogni lettera, su tutte le sue ripetizioni.
  const progressions = {};
  const offsetOf = new Map();
  const letterOf = new Map(r.sections.map((sec) => [sec, sec.letter]));
  for (const letter of Object.keys(counts)) {
    const own = r.sections.filter((sec) => sec.letter === letter);
    const p = sectionProgression(own.map((sec) => units.slice(sec.start * upb, sec.end * upb)), r.meter, key, models.progressions, options);
    own.forEach((sec, i) => offsetOf.set(sec, p.offsets[i]));
    progressions[letter] = compact(p);
    // Le ripetizioni che non vanno d'accordo con il giro della lettera sono una variante (A′),
    // con il suo giro: così ogni blocco mostra accordi che ci sono davvero.
    const variants = own.filter((_, i) => p.offsets[i] === null);
    if (variants.length) {
      const name = `${letter}′`;
      const q = sectionProgression(variants.map((sec) => units.slice(sec.start * upb, sec.end * upb)), r.meter, key, models.progressions, options);
      variants.forEach((sec, i) => { letterOf.set(sec, name); offsetOf.set(sec, q.offsets[i]); });
      progressions[name] = compact(q);
    }
  }
  // Giro dell'intero brano: se c'è, tutto gira sullo stesso giro.
  const whole = sectionProgression([units], r.meter, key, models.progressions, options);
  // Ruoli, mostrati solo se il ritornello è netto.
  let roles = null;
  let chorus = null;
  if (models.structure?.names && r.sections.length >= 2) {
    const names = nameSections(sectionCues(r.sections, r.features), models.structure.names);
    chorus = chorusMargin(r.sections, names.posteriors, models.structure.names.roles);
    if (show.names && chorus.margin >= show.namesMargin && chorus.count >= 2 && seconds >= show.namesSeconds) roles = names.roles;
  }
  return {
    meter: r.meter,
    unitsPerBar: upb,
    bars: r.bars.length,
    seconds: round(seconds, 1),
    // Si mostra solo se le ripetizioni della stessa lettera si somigliano davvero (o, senza
    // lettere ripetute, se una sezione gira su un giro fisso).
    shown: r.sections.length >= 2 && ((repeated && r.within >= show.minWithin) || (!repeated && Object.values(progressions).some((p) => p.loop))),
    within: round(r.within),
    sections: r.sections.map((sec, i) => ({ start: round(time0(sec.start)), end: round(time1(sec.end - 1)), bars: sec.end - sec.start, letter: letterOf.get(sec), role: roles ? roles[i] : null, offset: offsetOf.get(sec) })),
    progressions,
    whole: whole.loop ? compact(whole) : null,
    chorus: chorus && { letter: chorus.letter, margin: round(chorus.margin) },
  };
}

function compact(p) {
  return { loop: p.loop, period: p.period, bars: p.bars, repeats: p.repeats, loopScore: p.loopScore, chords: p.chords, named: p.named, alternative: p.alternative };
}
