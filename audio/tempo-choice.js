// Scelta del tempo tra i candidati (metà, doppio, 2/3, 3/2 …) con indizi dalle curve
// degli attacchi complessiva e per bande. Stesso codice per il banco di prova e per l'app:
// i pesi del modello vengono imparati in lab/ e copiati in TEMPO_WEIGHTS.

import { FFT, hann } from './dsp.js';

// Autocorrelazione generalizzata (compressione 0.5, Percival) media su finestre di `win` s
// della curva `env`, normalizzata a 1 in zero.
export function windowedAC(env, fps, { win = 8, hop = 2, maxLag } = {}) {
  const n = Math.min(env.length, Math.round(win * fps));
  if (n < fps * 3) return null;
  const size = 2 ** Math.ceil(Math.log2(2 * n));
  const fft = new FFT(size);
  const w = hann(n);
  const lags = Math.min(maxLag ?? n, n);
  const acc = new Float64Array(lags);
  let count = 0;
  const step = Math.max(1, Math.round(hop * fps));
  for (let start = Math.max(0, env.length - n); start >= 0; start -= step) {
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    let mean = 0;
    for (let i = 0; i < n; i++) mean += env[start + i];
    mean /= n;
    for (let i = 0; i < n; i++) re[i] = (env[start + i] - mean) * w[i];
    fft.transform(re, im);
    for (let k = 0; k < size; k++) { re[k] = Math.hypot(re[k], im[k]) ** 0.5; im[k] = 0; }
    fft.transform(re, im, true);
    const zero = re[0] || 1;
    for (let i = 0; i < lags; i++) acc[i] += re[i] / zero;
    count += 1;
    if (start === 0) break;
  }
  for (let i = 0; i < lags; i++) acc[i] /= count;
  return acc;
}

// Valore interpolato (lineare) dell'autocorrelazione a un ritardo frazionario.
function at(ac, lag) {
  if (!ac || lag < 1 || lag >= ac.length - 1) return 0;
  const i = Math.floor(lag);
  const f = lag - i;
  return ac[i] * (1 - f) + ac[i + 1] * f;
}

// Picchi locali del punteggio armonico A[i] + A[2i] + A[4i] nel campo [minBpm, maxBpm].
function peaks(ac, fps, minBpm, maxBpm, count) {
  const lo = Math.max(2, Math.floor((60 * fps) / maxBpm));
  const hi = Math.min(ac.length - 2, Math.ceil((60 * fps) / minBpm));
  const score = (i) => ac[i] + at(ac, 2 * i) + at(ac, 4 * i);
  const out = [];
  for (let i = lo; i <= hi; i++) {
    const v = score(i);
    if (v >= score(i - 1) && v >= score(i + 1)) {
      const a = score(i - 1);
      const c = score(i + 1);
      const d = a - 2 * v + c;
      const off = d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : 0;
      out.push({ lag: i + off, value: v });
    }
  }
  return out.sort((x, y) => y.value - x.value).slice(0, count);
}

export const RATIOS = [1, 2, 0.5, 1.5, 2 / 3, 3, 1 / 3];

// Candidati di tempo con le loro caratteristiche.
export function tempoCandidates({ onset, bandOnset, fps }, { minBpm = 45, maxBpm = 240 } = {}) {
  const maxLag = Math.ceil((60 * fps) / minBpm) * 4 + 4;
  const full = windowedAC(onset, fps, { maxLag });
  if (!full) return null;
  const bands = bandOnset.map((b) => windowedAC(b, fps, { maxLag }));
  const found = peaks(full, fps, minBpm, maxBpm, 3);
  const bpms = [];
  for (const p of found) {
    const base = (60 * fps) / p.lag;
    for (const r of RATIOS) {
      const bpm = base * r;
      if (bpm < minBpm || bpm > maxBpm) continue;
      if (bpms.some((b) => Math.abs(b / bpm - 1) < 0.03)) continue;
      bpms.push(bpm);
    }
  }
  // Caratteristiche globali del brano.
  const mean = (v) => v.reduce((a, b) => a + b, 0) / (v.length || 1);
  const density = mean(onset);
  const low = mean(bandOnset[0]);
  const high = mean(bandOnset[2]);
  const tilt = Math.log((high + 1e-6) / (low + 1e-6));
  const top = found.length ? (60 * fps) / found[0].lag : 120;
  return bpms.map((bpm) => {
    const lag = (60 * fps) / bpm;
    const oct = Math.log2(bpm / 120);
    const f = [
      oct, oct * oct, Math.abs(oct),
      at(full, lag), at(full, 2 * lag), at(full, lag / 2), at(full, 3 * lag), at(full, 1.5 * lag),
      at(full, lag) + at(full, 2 * lag) + at(full, 4 * lag),
      ...bands.flatMap((ac) => [at(ac, lag), at(ac, 2 * lag), at(ac, lag / 2)]),
      Math.log(density + 1e-6) * oct, tilt * oct,
      Math.abs(Math.log2(bpm / top)) < 0.02 ? 1 : 0,
    ];
    return { bpm, features: f };
  });
}

// Pesi imparati su GTZAN + GiantSteps, audio pulito e da stanza simulata (lab/tempo-final.mjs).
// Con weights = null si usa il candidato con il miglior punteggio armonico pesato dalla
// preferenza per i 120 BPM.
export const TEMPO_WEIGHTS = [1.673788,-1.106718,-0.703334,13.658948,-1.2287,25.405068,26.585388,29.939725,46.71169,7.248063,-0.797536,-6.926765,-7.593704,3.425813,-6.583942,-20.990578,-1.335138,2.434035,0.453431,0.74145,0.416739];

export function chooseTempo(candidates, weights = TEMPO_WEIGHTS) {
  if (!candidates || !candidates.length) return null;
  const score = (c) => {
    if (!weights) return c.features[8] * Math.exp(-0.5 * c.features[0] ** 2);
    let s = 0;
    for (let i = 0; i < weights.length; i++) s += weights[i] * c.features[i];
    return s;
  };
  let best = candidates[0];
  let bestScore = score(best);
  const scores = candidates.map((c) => score(c));
  candidates.forEach((c, i) => { if (scores[i] > bestScore) { best = c; bestScore = scores[i]; } });
  const max = Math.max(...scores);
  const z = scores.reduce((a, s) => a + Math.exp(s - max), 0);
  return { bpm: best.bpm, confidence: 1 / z };
}
