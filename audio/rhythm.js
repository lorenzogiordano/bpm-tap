// Tempo (BPM) di un brano dall'audio, in streaming.
//
// 1. Curva degli attacchi (onset strength): spettro su bande mel, compressione
//    logaritmica, aumento di energia tra un frame e il precedente (spectral
//    flux, solo la parte positiva), media sulle bande. È il front-end di
//    librosa.onset.onset_strength e di Percival & Tzanetakis (2014).
// 2. Periodo: autocorrelazione generalizzata (compressione 0.5, Percival) di
//    finestre di 8 s della curva, mediata nel tempo; rinforzo armonico
//    A[i] + A[2i] + A[4i] (Percival) e preferenza log-normale per i tempi
//    intorno a 120 BPM (librosa: start_bpm 120, deviazione di un'ottava).
// 3. Battiti: programmazione dinamica di Ellis (2007), come librosa.beat_track.
// 4. BPM fine: regressione lineare dei tempi dei battiti, la stessa usata per i tap.

import { FFT, hann, Framer } from './dsp.js';

export const RHYTHM_DEFAULTS = {
  sampleRate: 22050,
  frameSize: 1024,       // 46 ms
  hop: 128,              // 5.8 ms → ~172 frame al secondo
  melBands: 40,
  fmin: 30,
  fmax: 8000,
  compression: 1000,     // log(1 + 1000·ampiezza)
  acWindowSeconds: 8,    // finestra dell'autocorrelazione
  acHopSeconds: 1,       // ogni quanto si aggiunge una finestra alla media
  minBpm: 50,
  maxBpm: 210,
  priorBpm: 120,
  priorOctaves: 1,       // deviazione standard della preferenza, in ottave
  harmonics: true,
  tightness: 100,        // rigidità del tracciamento dei battiti (librosa)
  beatSeconds: 60,       // quanta storia usare per i battiti
  bandEdges: [200, 2000],// curve degli attacchi separate: bassi, medi, acuti (Hz)
  spectrumEvery: 0,      // se > 0, media delle bande mel ogni tanti frame (timbro per la struttura)
};

function hzToMel(f) { return 2595 * Math.log10(1 + f / 700); }
function melToHz(m) { return 700 * (10 ** (m / 2595) - 1); }

// Filtri triangolari mel (in ampiezza), come matrice sparsa per bin.
function melFilterbank(bands, frameSize, sampleRate, fmin, fmax) {
  const bins = frameSize / 2 + 1;
  const melMin = hzToMel(fmin);
  const melMax = hzToMel(fmax);
  const edges = Array.from({ length: bands + 2 }, (_, i) => melToHz(melMin + ((melMax - melMin) * i) / (bands + 1)));
  const filters = [];
  for (let b = 0; b < bands; b++) {
    const [lo, mid, hi] = [edges[b], edges[b + 1], edges[b + 2]];
    const weights = [];
    for (let k = 0; k < bins; k++) {
      const f = (k * sampleRate) / frameSize;
      let w = 0;
      if (f > lo && f <= mid) w = (f - lo) / (mid - lo);
      else if (f > mid && f < hi) w = (hi - f) / (hi - mid);
      if (w > 0) weights.push([k, w]);
    }
    const sum = weights.reduce((a, [, w]) => a + w, 0) || 1;
    filters.push(weights.map(([k, w]) => [k, w / sum]));
  }
  return filters;
}

export class RhythmAnalyzer {
  constructor(options = {}) {
    this.cfg = { ...RHYTHM_DEFAULTS, ...options };
    const { frameSize, hop, sampleRate, melBands, fmin, fmax } = this.cfg;
    this.fps = sampleRate / hop;
    this.fft = new FFT(frameSize);
    this.window = hann(frameSize);
    this.norm = 2 / this.window.reduce((a, b) => a + b, 0);
    this.filters = melFilterbank(melBands, frameSize, sampleRate, fmin, fmax);
    this.framer = new Framer(frameSize, hop);
    this.frame = new Float64Array(frameSize);
    this.mags = new Float64Array(frameSize / 2 + 1);
    this.prevBands = null;
    this.onset = [];                 // curva degli attacchi, un valore per frame
    this.bandOnset = [[], [], []];   // la stessa per bassi, medi e acuti
    const centres = this.filters.map((f) => f.reduce((a, [k, w]) => a + k * w, 0) * (sampleRate / frameSize));
    this.bandOf = centres.map((c) => (c < this.cfg.bandEdges[0] ? 0 : c < this.cfg.bandEdges[1] ? 1 : 2));
    this.acSum = null;               // somma delle autocorrelazioni delle finestre
    this.acCount = 0;
    this.nextAcFrame = Math.round(this.cfg.acWindowSeconds * this.fps);
    this.spectra = [];               // bande mel medie (log), una ogni spectrumEvery frame
    this.spectrumSum = null;
    this.spectrumCount = 0;
  }

  get seconds() {
    return this.onset.length / this.fps;
  }

  push(samples) {
    this.framer.push(samples, (f) => this.processFrame(f));
  }

  processFrame(f) {
    const { frame, window, mags, filters, norm } = this;
    for (let i = 0; i < f.length; i++) frame[i] = f[i] * window[i];
    this.fft.magnitudes(frame, mags);
    const bands = new Float64Array(filters.length);
    for (let b = 0; b < filters.length; b++) {
      let v = 0;
      for (const [k, w] of filters[b]) v += mags[k] * w;
      bands[b] = Math.log1p(this.cfg.compression * v * norm);
    }
    let flux = 0;
    const part = [0, 0, 0];
    const count = [0, 0, 0];
    if (this.prevBands) {
      for (let b = 0; b < bands.length; b++) {
        const d = Math.max(0, bands[b] - this.prevBands[b]);
        flux += d;
        part[this.bandOf[b]] += d;
        count[this.bandOf[b]] += 1;
      }
      flux /= bands.length;
    }
    this.prevBands = bands;
    if (this.cfg.spectrumEvery) {
      if (!this.spectrumSum) this.spectrumSum = new Float64Array(bands.length);
      for (let b = 0; b < bands.length; b++) this.spectrumSum[b] += bands[b];
      if (++this.spectrumCount === this.cfg.spectrumEvery) {
        this.spectra.push(Float32Array.from(this.spectrumSum, (v) => v / this.spectrumCount));
        this.spectrumSum.fill(0);
        this.spectrumCount = 0;
      }
    }
    this.onset.push(flux);
    for (let i = 0; i < 3; i++) this.bandOnset[i].push(count[i] ? part[i] / count[i] : 0);

    if (this.onset.length >= this.nextAcFrame) {
      this.addAutocorrelation();
      this.nextAcFrame += Math.round(this.cfg.acHopSeconds * this.fps);
    }
  }

  // Autocorrelazione generalizzata dell'ultima finestra, aggiunta alla media.
  addAutocorrelation() {
    const n = Math.round(this.cfg.acWindowSeconds * this.fps);
    const segment = this.onset.slice(-n);
    const size = 2 ** Math.ceil(Math.log2(2 * segment.length));
    if (!this.acFft || this.acFft.size !== size) this.acFft = new FFT(size);
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    const mean = segment.reduce((a, b) => a + b, 0) / segment.length;
    const w = hann(segment.length);
    for (let i = 0; i < segment.length; i++) re[i] = (segment[i] - mean) * w[i];
    this.acFft.transform(re, im);
    for (let k = 0; k < size; k++) {
      re[k] = Math.hypot(re[k], im[k]) ** 0.5; // compressione 0.5 (|X|^(2·0.5))
      im[k] = 0;
    }
    this.acFft.transform(re, im, true);
    const maxLag = Math.ceil((60 * this.fps) / this.cfg.minBpm) * 4 + 2;
    const ac = new Float64Array(Math.min(maxLag, segment.length));
    const zero = re[0] || 1;
    for (let i = 0; i < ac.length; i++) ac[i] = re[i] / zero;
    if (!this.acSum) this.acSum = new Float64Array(ac.length);
    for (let i = 0; i < Math.min(ac.length, this.acSum.length); i++) this.acSum[i] += ac[i];
    this.acCount += 1;
  }

  // Stima del periodo dall'autocorrelazione media. Restituisce null se non basta l'audio.
  tempo() {
    if (!this.acCount) {
      if (this.seconds < 4) return null;
      // Meno di una finestra intera: si usa quello che c'è.
      const saved = this.cfg.acWindowSeconds;
      this.cfg.acWindowSeconds = this.seconds;
      this.addAutocorrelation();
      this.cfg.acWindowSeconds = saved;
      const result = this.pickTempo();
      this.acSum = null;
      this.acCount = 0;
      return result;
    }
    return this.pickTempo();
  }

  pickTempo() {
    const ac = this.acSum.map((v) => v / this.acCount);
    const { minBpm, maxBpm, priorBpm, priorOctaves, harmonics } = this.cfg;
    const score = new Float64Array(ac.length);
    for (let i = 1; i < ac.length; i++) {
      let v = ac[i];
      if (harmonics) {
        if (2 * i < ac.length) v += ac[2 * i];
        if (4 * i < ac.length) v += ac[4 * i];
      }
      score[i] = v;
    }
    const lagOf = (bpm) => (60 * this.fps) / bpm;
    const lo = Math.max(2, Math.floor(lagOf(maxBpm)));
    const hi = Math.min(ac.length - 2, Math.ceil(lagOf(minBpm)));
    let best = -1;
    let bestValue = -Infinity;
    const weighted = new Float64Array(ac.length);
    for (let i = lo; i <= hi; i++) {
      const bpm = (60 * this.fps) / i;
      const prior = Math.exp(-0.5 * (Math.log2(bpm / priorBpm) / priorOctaves) ** 2);
      weighted[i] = Math.max(0, score[i]) * prior;
      if (weighted[i] > bestValue && score[i] >= score[i - 1] && score[i] >= score[i + 1]) {
        bestValue = weighted[i];
        best = i;
      }
    }
    if (best < 0) return null;
    // Interpolazione parabolica del picco (sulla curva non pesata).
    const [a, b, c] = [score[best - 1], score[best], score[best + 1]];
    const denom = a - 2 * b + c;
    const offset = denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
    const lag = best + offset;
    // Quanto spicca il picco rispetto al resto della curva nel campo di ricerca.
    const inRange = Array.from(weighted.slice(lo, hi + 1)).sort((x, y) => x - y);
    const median = inRange[inRange.length >> 1] || 0;
    return {
      bpm: (60 * this.fps) / lag,
      period: lag / this.fps,
      salience: median > 0 ? bestValue / median : bestValue > 0 ? Infinity : 0,
    };
  }

  // Battiti (in secondi dall'inizio) con la programmazione dinamica di Ellis.
  beats(bpm) {
    const onset = this.onset;
    const start = Math.max(0, onset.length - Math.round(this.cfg.beatSeconds * this.fps));
    const env = onset.slice(start);
    const n = env.length;
    const period = (60 * this.fps) / bpm;
    if (n < 2 * period) return [];

    // Punteggio locale: curva normalizzata e smussata con una gaussiana larga period/32.
    const mean = env.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(env.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 1;
    const sigma = period / 32;
    const radius = Math.max(1, Math.ceil(3 * sigma));
    const kernel = Array.from({ length: 2 * radius + 1 }, (_, i) => Math.exp(-0.5 * ((i - radius) / sigma) ** 2));
    const local = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let j = -radius; j <= radius; j++) {
        const idx = i + j;
        if (idx >= 0 && idx < n) v += (env[idx] / sd) * kernel[j + radius];
      }
      local[i] = v;
    }

    const score = new Float64Array(n);
    const back = new Int32Array(n).fill(-1);
    const minGap = Math.max(1, Math.round(period / 2));
    const maxGap = Math.round(2 * period);
    const tightness = this.cfg.tightness;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestJ = -1;
      for (let gap = minGap; gap <= maxGap && i - gap >= 0; gap++) {
        const j = i - gap;
        const v = score[j] - tightness * Math.log(gap / period) ** 2;
        if (bestJ < 0 || v > best) { best = v; bestJ = j; }
      }
      score[i] = local[i] + (bestJ >= 0 ? Math.max(0, best) : 0);
      back[i] = bestJ >= 0 && best > 0 ? bestJ : -1;
    }

    // Ultimo battito: il massimo locale più tardo tra quelli con punteggio alto.
    const maxima = [];
    for (let i = 1; i < n - 1; i++) if (score[i] >= score[i - 1] && score[i] >= score[i + 1]) maxima.push(score[i]);
    const sorted = [...maxima].sort((x, y) => x - y);
    const threshold = 0.5 * (sorted[sorted.length >> 1] || 0);
    let last = -1;
    for (let i = n - 2; i > 0; i--) {
      if (score[i] >= score[i - 1] && score[i] >= score[i + 1] && score[i] >= threshold) { last = i; break; }
    }
    if (last < 0) return [];
    const frames = [];
    for (let i = last; i >= 0; i = back[i]) frames.push(i);
    frames.reverse();

    // Via i battiti deboli agli estremi (come librosa: sotto metà della mediana del punteggio locale).
    const strengths = frames.map((i) => local[i]);
    const median = [...strengths].sort((x, y) => x - y)[strengths.length >> 1] || 0;
    while (frames.length && local[frames[0]] < 0.5 * median) frames.shift();
    while (frames.length && local[frames[frames.length - 1]] < 0.5 * median) frames.pop();
    return frames.map((i) => (i + start) / this.fps);
  }
}

// BPM fine dai battiti. Regressione lineare tempo ~ indice (come per i tap) su ogni
// tratto regolare: intervalli entro ±10% del periodo scelto. I periodi dei tratti si
// uniscono pesandoli con l'inverso della varianza. Un salto di fase (uno stacco, un
// montaggio, un battito sbagliato del tracciatore) spezza solo il tratto, non azzera la
// misura. Margine al 95%, con una varianza a priori dell'1% del battito come nei tap.
export function fitBeats(beats, bpm, { tolerance = 0.1, minRun = 4, priorJitter = 0.01, priorWeight = 4 } = {}) {
  const period = 60 / bpm;
  const runs = [];
  let run = beats.length ? [beats[0]] : [];
  for (let i = 1; i < beats.length; i++) {
    if (Math.abs((beats[i] - beats[i - 1]) / period - 1) <= tolerance) run.push(beats[i]);
    else { runs.push(run); run = [beats[i]]; }
  }
  runs.push(run);
  let sxxSum = 0;
  let slopeSum = 0;
  let sse = 0;
  let dof = 0;
  let count = 0;
  for (const r of runs) {
    const n = r.length;
    if (n < minRun) continue;
    const km = (n - 1) / 2;
    const tm = r.reduce((a, b) => a + b, 0) / n;
    let sxy = 0;
    let sxx = 0;
    r.forEach((t, k) => { sxy += (k - km) * (t - tm); sxx += (k - km) ** 2; });
    const slope = sxy / sxx;
    r.forEach((t, k) => { sse += (t - tm - slope * (k - km)) ** 2; });
    sxxSum += sxx;
    slopeSum += slope * sxx;
    dof += n - 2;
    count += n;
  }
  if (!sxxSum) return null;
  const p = slopeSum / sxxSum;
  const variance = (sse + priorWeight * (priorJitter * p) ** 2) / (dof + priorWeight);
  const se = Math.sqrt(variance / sxxSum);
  return { bpm: 60 / p, halfWidth: (1.96 * se * 60) / (p * p), beats: count, runs: runs.filter((r) => r.length >= minRun).length };
}
