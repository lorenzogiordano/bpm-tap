// Pulizia del rumore di fondo con profilo del rumore (sottrazione spettrale). Solo per il
// banco di prova: nelle prove non migliora né la tonalità né il tempo (vedi README), quindi
// l'app non la usa.
//
// Prima della canzone si ascoltano alcuni secondi di sola stanza: la media dello spettro
// di ampiezza di quei secondi è il "profilo" del rumore (ventole, condizionatore, ronzio
// della rete elettrica a 50 Hz…). Poi, frame per frame, a ogni frequenza si toglie il
// profilo moltiplicato per un fattore di sicurezza, senza mai scendere sotto una piccola
// frazione del segnale originale (per non creare buchi e artefatti "musicali"); il
// guadagno viene smussato nel tempo. Il segnale pulito si ricostruisce con
// sovrapposizione e somma (STFT inversa), così tutte le analisi a valle ne beneficiano.

import { FFT, hann } from '../audio/dsp.js';

export const DENOISE_DEFAULTS = {
  frameSize: 2048,     // 93 ms a 22050 Hz
  hop: 512,            // sovrapposizione 75%: la finestra di Hann al quadrato si somma a costante
  overSubtraction: 2,  // quanto rumore togliere rispetto al profilo medio (margine per le fluttuazioni)
  floor: 0.08,         // guadagno minimo: il segnale non scende mai sotto l'8%
  smoothing: 0.6,      // media mobile del guadagno nel tempo (0 = nessuna)
};

export class NoiseProfile {
  constructor(options = {}) {
    this.cfg = { ...DENOISE_DEFAULTS, ...options };
    const { frameSize } = this.cfg;
    this.fft = new FFT(frameSize);
    this.window = hann(frameSize);
    this.sum = new Float64Array(frameSize / 2 + 1);
    this.frames = 0;
    this.buffer = [];
  }

  // Accumula campioni di sola stanza.
  push(samples) {
    for (const v of samples) this.buffer.push(v);
    const { frameSize, hop } = this.cfg;
    const frame = new Float64Array(frameSize);
    const mags = new Float64Array(frameSize / 2 + 1);
    while (this.buffer.length >= frameSize) {
      for (let i = 0; i < frameSize; i++) frame[i] = this.buffer[i] * this.window[i];
      this.fft.magnitudes(frame, mags);
      for (let k = 0; k < mags.length; k++) this.sum[k] += mags[k];
      this.frames += 1;
      this.buffer.splice(0, hop);
    }
  }

  get ready() {
    return this.frames >= 8;
  }

  get magnitudes() {
    return this.sum.map((v) => v / Math.max(1, this.frames));
  }
}

// Stima del rumore senza silenzio (statistiche dei minimi, Martin 2001, semplificata):
// per ogni frequenza si segue il minimo della potenza smussata negli ultimi ~4 s.
// Nella musica però una nota può durare secondi e sembrare "rumore costante": per non
// cancellarla, la stima viene spianata lungo le frequenze (mediana su ±1/6 d'ottava, almeno 17 bin).
// Restano il fruscio e i rumori larghi; le righe strette (note, ma anche il ronzio a
// 50 Hz, indistinguibile da un Sol grave) non vengono toccate.
export class MinimumStatistics {
  constructor(bins, { alpha = 0.9, window = 172, subwindows = 8, bias = 1.5 } = {}) {
    this.alpha = alpha;
    this.sub = Math.ceil(window / subwindows);
    this.bias = bias;
    this.smooth = null;
    this.current = new Float64Array(bins).fill(Infinity);   // minimo della sotto-finestra in corso
    this.history = [];                                      // minimi delle sotto-finestre chiuse
    this.subwindows = subwindows;
    this.count = 0;
    this.magnitudes = new Float64Array(bins);
  }

  update(mags) {
    const n = mags.length;
    if (!this.smooth) this.smooth = Float64Array.from(mags, (m) => m * m);
    for (let k = 0; k < n; k++) {
      this.smooth[k] = this.alpha * this.smooth[k] + (1 - this.alpha) * mags[k] * mags[k];
      if (this.smooth[k] < this.current[k]) this.current[k] = this.smooth[k];
    }
    this.count += 1;
    if (this.count % this.sub === 0) {
      this.history.push(this.current);
      if (this.history.length > this.subwindows) this.history.shift();
      this.current = new Float64Array(n).fill(Infinity);
    }
    // Il rumore di fondo cambia lentamente: la spianatura (costosa) si ricalcola ogni 16 frame.
    if (this.count > 1 && this.count % 16 !== 0) return;
    const raw = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      let min = this.current[k];
      for (const h of this.history) if (h[k] < min) min = h[k];
      raw[k] = Math.sqrt(this.bias * min);
    }
    for (let k = 0; k < n; k++) {
      const half = Math.max(8, Math.round(k * 0.12));
      const lo = Math.max(1, k - half);
      const hi = Math.min(n - 1, k + half);
      const around = Array.from(raw.subarray(lo, hi + 1)).sort((a, b) => a - b);
      this.magnitudes[k] = around[around.length >> 1];
    }
  }
}

export class Denoiser {
  // profile: NoiseProfile misurato nel silenzio, oppure null per la stima automatica.
  constructor(profile, options = {}) {
    this.cfg = { ...DENOISE_DEFAULTS, ...options };
    const { frameSize, hop } = this.cfg;
    this.adaptive = profile ? null : new MinimumStatistics(frameSize / 2 + 1, this.cfg.minimum);
    // Senza silenzio si toglie il rumore stimato una volta sola (più prudenti).
    if (!profile && options.overSubtraction === undefined) this.cfg.overSubtraction = 1;
    this.noise = profile ? profile.magnitudes : this.adaptive.magnitudes;
    this.fft = new FFT(frameSize);
    this.window = hann(frameSize);
    // Con finestra di Hann in analisi e sintesi e passo 1/4, la somma delle finestre al quadrato vale 1.5.
    this.synthesisGain = hop / this.window.reduce((a, w) => a + w * w, 0);
    this.input = new Float64Array(frameSize);  // ultimi frameSize campioni in ingresso
    this.output = new Float64Array(frameSize); // accumulo della sovrapposizione in uscita
    this.pending = 0;                          // campioni entrati dall'ultimo frame
    this.gain = new Float64Array(frameSize / 2 + 1).fill(1);
    this.re = new Float64Array(frameSize);
    this.im = new Float64Array(frameSize);
    this.primed = false;
  }

  // Restituisce i campioni puliti (con un ritardo fisso di frameSize − hop campioni).
  process(samples) {
    const { frameSize, hop } = this.cfg;
    const out = [];
    for (const v of samples) {
      this.input.copyWithin(0, 1);
      this.input[frameSize - 1] = v;
      this.pending += 1;
      if (this.pending === hop) {
        this.pending = 0;
        this.processFrame();
        for (let i = 0; i < hop; i++) out.push(this.output[i]);
        this.output.copyWithin(0, hop);
        this.output.fill(0, frameSize - hop);
      }
    }
    return Float64Array.from(out);
  }

  processFrame() {
    const { re, im, window, noise, gain, cfg } = this;
    const n = cfg.frameSize;
    for (let i = 0; i < n; i++) { re[i] = this.input[i] * window[i]; im[i] = 0; }
    this.fft.transform(re, im);
    const half = n / 2;
    if (this.adaptive) {
      const mags = new Float64Array(half + 1);
      for (let k = 0; k <= half; k++) mags[k] = Math.hypot(re[k], im[k]);
      this.adaptive.update(mags);
    }
    for (let k = 0; k <= half; k++) {
      const mag = Math.hypot(re[k], im[k]);
      const target = mag > 0 ? Math.max(cfg.floor, 1 - (cfg.overSubtraction * noise[k]) / mag) : cfg.floor;
      gain[k] = cfg.smoothing * gain[k] + (1 - cfg.smoothing) * target;
      re[k] *= gain[k];
      im[k] *= gain[k];
      if (k > 0 && k < half) {
        re[n - k] = re[k];
        im[n - k] = -im[k];
      }
    }
    this.fft.transform(re, im, true);
    for (let i = 0; i < n; i++) this.output[i] += re[i] * window[i] * this.synthesisGain;
  }
}
