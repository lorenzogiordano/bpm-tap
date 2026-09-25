// Tonalità di un brano dall'audio, in streaming.
//
// Cromagramma (quanta energia c'è su ciascuna delle 12 classi di nota) calcolato
// come l'HPCP di Essentia: picchi spettrali con interpolazione parabolica,
// stima dell'intonazione (A4 non sempre a 440 Hz), 36 bin per ottava con
// pesatura a coseno; a parte, lo stesso per la sola zona del basso.
// La tonalità si decide confrontando il cromagramma medio con i profili delle
// 24 tonalità (correlazione di Pearson, come Essentia Key).

import { FFT, hann, Framer } from './dsp.js';
import { logMapping, logSpectrum, whitenLog, noteDictionary, transcribe, noteWeights, NOTES, NOTE_MIN_MIDI } from './notes.js';

export const KEY_DEFAULTS = {
  method: 'peaks',        // 'peaks' (HPCP dai picchi spettrali) | 'nnls' (trascrizione delle note)
  sampleRate: 22050,
  frameSize: 8192,        // 0.37 s, 2.7 Hz per bin
  hop: 4096,
  fmin: 55,               // la parte "armonica" (accordi e melodia)
  fmax: 5000,
  bassMin: 30,            // la parte del basso, tenuta separata
  bassMax: 220,
  maxPeaks: 60,
  binsPerSemitone: 3,
  windowSemitones: 1,     // larghezza della pesatura a coseno
  harmonics: 0,           // contributi alle sub-armoniche (Essentia KeyExtractor: 4)
  harmonicDecay: 0.8,
  whitening: false,
  weighting: 'power',     // contributo di un picco: 'power' (ampiezza²) | 'magnitude' | 'log'
  frameNorm: 'max',       // normalizzazione di ogni frame: 'max' | 'sum' | 'none'
  minRms: 1e-4,           // frame più silenziosi di così si ignorano
};

// Profili delle tonalità (tonica, ♭2, 2, ♭3, 3, 4, ♯4, 5, ♭6, 6, ♭7, 7): Essentia key.cpp.
export const PROFILES = {
  krumhansl: {
    major: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
    minor: [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
  },
  temperley: {
    major: [5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0],
    minor: [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0],
  },
  shaath: {
    major: [6.6, 2.0, 3.5, 2.3, 4.6, 4.0, 2.5, 5.2, 2.4, 3.7, 2.3, 3.4],
    minor: [6.5, 2.7, 3.5, 5.4, 2.6, 3.5, 2.5, 5.2, 4.0, 2.7, 4.3, 3.2],
  },
  edma: {
    major: [1, 0.29, 0.50, 0.40, 0.60, 0.56, 0.32, 0.80, 0.31, 0.45, 0.42, 0.39],
    minor: [1, 0.31, 0.44, 0.58, 0.33, 0.49, 0.29, 0.78, 0.43, 0.29, 0.53, 0.32],
  },
  bgate: {
    major: [1, 0, 0.42, 0, 0.53, 0.37, 0, 0.77, 0, 0.38, 0.21, 0.30],
    minor: [1, 0, 0.36, 0.39, 0, 0.38, 0, 0.74, 0.27, 0, 0.42, 0.23],
  },
  aarden: {
    major: [17.7661, 0.145624, 14.9265, 0.160186, 19.8049, 11.3587, 0.291248, 22.062, 0.145624, 8.15494, 0.232998, 4.95122],
    minor: [18.2648, 0.737619, 14.0499, 16.8599, 0.702494, 14.4362, 0.702494, 18.6161, 4.56621, 1.93186, 7.37619, 1.75623],
  },
  tkp: {
    major: [0.748, 0.060, 0.488, 0.082, 0.670, 0.460, 0.096, 0.715, 0.104, 0.366, 0.057, 0.400],
    minor: [0.712, 0.084, 0.474, 0.618, 0.049, 0.460, 0.105, 0.747, 0.404, 0.067, 0.133, 0.330],
  },
};

export const NOTE_NAMES = ['Do', 'Re♭', 'Re', 'Mi♭', 'Mi', 'Fa', 'Fa♯', 'Sol', 'La♭', 'La', 'Si♭', 'Si'];
export const MINOR_NAMES = ['Do', 'Do♯', 'Re', 'Mi♭', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'Si♭', 'Si'];

export function keyName({ tonic, mode }) {
  return mode === 'major' ? `${NOTE_NAMES[tonic]} maggiore` : `${MINOR_NAMES[tonic]} minore`;
}

// Pearson tra un vettore di 12 e un profilo ruotato sulla tonica.
function pearson(x, profile, tonic) {
  let mx = 0;
  let mp = 0;
  for (let i = 0; i < 12; i++) { mx += x[i]; mp += profile[i]; }
  mx /= 12;
  mp /= 12;
  let num = 0;
  let dx = 0;
  let dp = 0;
  for (let i = 0; i < 12; i++) {
    const a = x[(i + tonic) % 12] - mx;
    const b = profile[i] - mp;
    num += a * b;
    dx += a * a;
    dp += b * b;
  }
  return dx > 0 && dp > 0 ? num / Math.sqrt(dx * dp) : 0;
}

// Punteggi delle 24 tonalità: indice tonic + 12·(minore ? 1 : 0).
export function keyScores(chroma12, profile = PROFILES.shaath) {
  const scores = new Float64Array(24);
  for (let t = 0; t < 12; t++) {
    scores[t] = pearson(chroma12, profile.major, t);
    scores[t + 12] = pearson(chroma12, profile.minor, t);
  }
  return scores;
}

export function bestKey(scores) {
  let best = 0;
  for (let i = 1; i < 24; i++) if (scores[i] > scores[best]) best = i;
  let second = best === 0 ? 1 : 0;
  for (let i = 0; i < 24; i++) if (i !== best && scores[i] > scores[second]) second = i;
  const key = (i) => ({ tonic: i % 12, mode: i < 12 ? 'major' : 'minor' });
  return { ...key(best), score: scores[best], second: key(second), margin: scores[best] - scores[second] };
}

// Da 36 (o 12·b) bin a 12, sommando i bin di ogni semitono.
export function fold(chroma, binsPerSemitone) {
  if (binsPerSemitone === 1) return Float64Array.from(chroma);
  const out = new Float64Array(12);
  const half = Math.floor(binsPerSemitone / 2);
  for (let i = 0; i < chroma.length; i++) {
    const pc = Math.floor(((i + half) % chroma.length) / binsPerSemitone);
    out[pc] += chroma[i];
  }
  return out;
}

export class ChromaAnalyzer {
  constructor(options = {}) {
    this.cfg = { ...KEY_DEFAULTS, ...options };
    const { frameSize, hop } = this.cfg;
    this.fft = new FFT(frameSize);
    this.window = hann(frameSize);
    this.norm = 2 / this.window.reduce((a, b) => a + b, 0);
    this.framer = new Framer(frameSize, hop);
    this.frame = new Float64Array(frameSize);
    this.mags = new Float64Array(frameSize / 2 + 1);
    this.frames = [];                 // per frame: { peaks: [[freq, mag]], rms, log? }
    this.tuningHistogram = new Float64Array(100); // scarto dai 440 Hz, un bin per centesimo (-50…+49)
    if (this.cfg.method === 'nnls') {
      this.logMap = logMapping(frameSize, this.cfg.sampleRate);
      this.weights = noteWeights(this.cfg.noteRanges);
      this.dictionaries = new Map();
    }
  }

  dictionary(tuning) {
    const key = Math.round(tuning);
    if (!this.dictionaries.has(key)) this.dictionaries.set(key, noteDictionary(key));
    return this.dictionaries.get(key);
  }

  push(samples) {
    this.framer.push(samples, (f) => this.processFrame(f));
  }

  get seconds() {
    return (this.frames.length * this.cfg.hop) / this.cfg.sampleRate;
  }

  processFrame(f) {
    const { frame, window, mags, norm, cfg } = this;
    let energy = 0;
    for (let i = 0; i < f.length; i++) {
      frame[i] = f[i] * window[i];
      energy += f[i] * f[i];
    }
    const rms = Math.sqrt(energy / f.length);
    if (rms < cfg.minRms) {
      this.frames.push({ peaks: [], rms });
      return;
    }
    this.fft.magnitudes(frame, mags);
    for (let k = 0; k < mags.length; k++) mags[k] *= norm;
    if (cfg.whitening) this.whiten(mags);

    const binHz = cfg.sampleRate / cfg.frameSize;
    const kMin = Math.max(2, Math.floor(Math.min(cfg.fmin, cfg.bassMin) / binHz));
    const kMax = Math.min(mags.length - 2, Math.ceil(cfg.fmax / binHz));
    let peaks = [];
    for (let k = kMin; k <= kMax; k++) {
      const m = mags[k];
      if (m > mags[k - 1] && m >= mags[k + 1]) {
        // Interpolazione parabolica in dB.
        const a = 20 * Math.log10(mags[k - 1] + 1e-12);
        const b = 20 * Math.log10(m + 1e-12);
        const c = 20 * Math.log10(mags[k + 1] + 1e-12);
        const d = a - 2 * b + c;
        const p = d < 0 ? (0.5 * (a - c)) / d : 0;
        const freq = (k + p) * binHz;
        const db = b - 0.25 * (a - c) * p;
        peaks.push([freq, 10 ** (db / 20)]);
      }
    }
    peaks.sort((x, y) => y[1] - x[1]);
    peaks = peaks.slice(0, cfg.maxPeaks);
    // Via i picchi di più di 60 dB sotto il più forte.
    if (peaks.length) {
      const floor = peaks[0][1] * 1e-3;
      peaks = peaks.filter((p) => p[1] > floor);
    }
    for (const [freq, mag] of peaks) {
      if (freq < cfg.fmin) continue;
      const cents = 1200 * Math.log2(freq / 440);
      const dev = ((Math.round(cents) % 100) + 150) % 100; // 0…99, con 50 = -50 centesimi
      this.tuningHistogram[dev] += mag;
    }
    // Tonalità del frame: quota dell'energia che sta nei picchi (note) rispetto a tutto lo
    // spettro della banda; bassa quando suonano solo batteria o rumore.
    let total = 0;
    for (let k = kMin; k <= kMax; k++) total += mags[k] * mags[k];
    let inPeaks = 0;
    for (const [, mag] of peaks) inPeaks += mag * mag;
    const record = { peaks, rms, tonal: total > 0 ? inPeaks / total : 0 };
    if (cfg.method === 'nnls') record.log = logSpectrum(mags, this.logMap);
    this.frames.push(record);
  }

  // Divide lo spettro per un inviluppo smussato (~1/3 d'ottava): le note contano per
  // la loro prominenza locale, non per quanto è forte quella zona di frequenze.
  whiten(mags) {
    const n = mags.length;
    const prefix = new Float64Array(n + 1);
    for (let k = 0; k < n; k++) prefix[k + 1] = prefix[k] + mags[k];
    const out = new Float64Array(n);
    for (let k = 1; k < n; k++) {
      const half = Math.max(2, Math.round(k * 0.12));
      const lo = Math.max(0, k - half);
      const hi = Math.min(n, k + half + 1);
      const env = (prefix[hi] - prefix[lo]) / (hi - lo);
      out[k] = mags[k] / (env + 1e-9);
    }
    mags.set(out);
  }

  // Scarto di intonazione stimato in centesimi (−50…+50): media circolare attorno al massimo.
  tuningCents() {
    const h = this.tuningHistogram;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < 100; i++) {
      const angle = (2 * Math.PI * (i - 50)) / 100;
      sx += h[i] * Math.cos(angle);
      sy += h[i] * Math.sin(angle);
    }
    if (!sx && !sy) return 0;
    return (Math.atan2(sy, sx) / (2 * Math.PI)) * 100;
  }

  // Attività delle 84 note di un frame (solo metodo 'nnls').
  frameNotes(record, tuning) {
    return transcribe(whitenLog(record.log), this.dictionary(tuning));
  }

  // Cromagramma di un frame: { treble, bass } con 12·binsPerSemitone bin ciascuno.
  frameChroma(record, tuning) {
    if (this.cfg.method === 'nnls') {
      const size = 12 * this.cfg.binsPerSemitone;
      const treble = new Float64Array(size);
      const bass = new Float64Array(size);
      if (!record.log) return { treble, bass };
      const x = this.frameNotes(record, tuning);
      for (let n = 0; n < NOTES; n++) {
        const bin = ((NOTE_MIN_MIDI + n) % 12) * this.cfg.binsPerSemitone;
        treble[bin] += x[n] * this.weights.treble[n];
        bass[bin] += x[n] * this.weights.bass[n];
      }
      return { treble, bass };
    }
    const { peaks } = record;
    const { binsPerSemitone: bps, windowSemitones, harmonics, harmonicDecay, fmin, fmax, bassMin, bassMax } = this.cfg;
    const size = 12 * bps;
    const treble = new Float64Array(size);
    const bass = new Float64Array(size);
    const ref = 440 * 2 ** (tuning / 1200);
    const half = windowSemitones / 2;
    const add = (target, freq, weight) => {
      // Semitoni da La, riportati all'ottava; il bin 0 è Do.
      const semis = 12 * Math.log2(freq / ref) + 9; // Do = 0
      for (let b = 0; b < size; b++) {
        let d = semis - b / bps;
        d -= 12 * Math.round(d / 12);
        if (Math.abs(d) < half) target[b] += weight * Math.cos((Math.PI * d) / windowSemitones) ** 2;
      }
    };
    const weighting = this.cfg.weighting;
    for (const [freq, mag] of peaks) {
      const power = weighting === 'power' ? mag * mag : weighting === 'magnitude' ? mag : Math.log1p(1000 * mag);
      if (freq >= fmin && freq <= fmax) {
        for (let h = 1; h <= harmonics + 1; h++) {
          const f = freq / h;
          if (f < fmin) break;
          add(treble, f, power * harmonicDecay ** (h - 1));
        }
      }
      if (freq >= bassMin && freq <= bassMax) add(bass, freq, power);
    }
    return { treble, bass };
  }

  // Cromagrammi medi a 12 classi (dopo normalizzazione per frame) su un intervallo di frame.
  summary({ from = 0, to = this.frames.length, tuning = this.tuningCents() } = {}) {
    const { binsPerSemitone: bps, frameNorm } = this.cfg;
    const treble = new Float64Array(12);
    const bass = new Float64Array(12);
    let used = 0;
    for (let i = from; i < to; i++) {
      const record = this.frames[i];
      if (!record.peaks.length) continue;
      const c = this.frameChroma(record, tuning);
      const t = fold(c.treble, bps);
      const b = fold(c.bass, bps);
      normalize(t, frameNorm);
      normalize(b, frameNorm);
      for (let k = 0; k < 12; k++) { treble[k] += t[k]; bass[k] += b[k]; }
      used += 1;
    }
    return { treble, bass, frames: used, tuning };
  }
}

function normalize(v, how) {
  if (how === 'none') return v;
  const s = how === 'max' ? Math.max(...v) : v.reduce((a, b) => a + b, 0);
  if (s > 0) for (let i = 0; i < v.length; i++) v[i] /= s;
  return v;
}
