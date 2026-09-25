// S-KEY (Kong et al., ICASSP 2025, codice e pesi Deezer con licenza MIT) eseguito con
// l'interprete ONNX in JavaScript. Restituisce le probabilità delle 24 tonalità e i
// profili interni degli ultimi strati, usati come indizi dal modello della tonalità.

import { OnnxLite } from './onnx-lite.js';

const NAMES = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
// Ordine delle uscite del modello (dal manifest della conversione ONNX).
const LABELS = ['A Major', 'Bb Major', 'B Major', 'C Major', 'C# Major', 'D Major', 'D# Major', 'E Major', 'F Major', 'F# Major', 'G Major', 'G# Major',
  'B minor', 'C minor', 'C# minor', 'D minor', 'D# minor', 'E minor', 'F minor', 'F# minor', 'G minor', 'G# minor', 'A minor', 'Bb minor'];
// Indice nel nostro ordine: tonica (Do = 0) + 12 se minore.
const ORDER = LABELS.map((l) => { const [n, m] = l.split(' '); return NAMES[n] + (m === 'Major' ? 0 : 12); });

export const SKEY_LAYERS = [3, 4, 5, 6];
export const SKEY_RATE = 22050;

// Profili sulle 12 note di un'uscita di blocco [1, canali, 84 bin CQT, tempo]:
// media sulle 7 ottave, poi media e deviazione nel tempo. Il bin 0 della CQT è La (27.5 Hz).
// from: frazione iniziale della finestra da saltare (0 = tutti i frame).
export function poolLayer(t, from = 0) {
  const [, C, H, T] = t.dims;
  const octaves = H / 12;
  const x0 = Math.min(T - 1, Math.max(0, Math.round(from * T)));
  const frames = T - x0;
  const mean = [];
  const sd = [];
  const series = new Float64Array(T);
  for (let c = 0; c < C; c++) {
    const m = new Array(12).fill(0);
    const q = new Array(12).fill(0);
    for (let pc = 0; pc < 12; pc++) {
      series.fill(0);
      for (let o = 0; o < octaves; o++) {
        const row = (c * H + o * 12 + ((pc - 9 + 12) % 12)) * T;
        for (let x = x0; x < T; x++) series[x] += t.data[row + x] / octaves;
      }
      let mu = 0;
      for (let x = x0; x < T; x++) mu += series[x];
      mu /= frames;
      let v = 0;
      for (let x = x0; x < T; x++) v += (series[x] - mu) ** 2;
      m[pc] = mu;
      q[pc] = Math.sqrt(v / frames);
    }
    mean.push(m);
    sd.push(q);
  }
  return { mean, sd, frames };
}

// Profili interni medi su tutto l'audio ascoltato. S-KEY gira sugli ultimi 30 s: finché
// la finestra copre tutto l'ascolto, conta solo l'ultimo passaggio (ha il contesto
// intero); dopo, ogni passaggio aggiunge solo i frame dei secondi nuovi. Media e
// deviazione si uniscono in modo esatto (somme dei valori e dei quadrati).
export class DeepAverage {
  constructor() {
    this.layers = null;
  }

  // run: risultato di SKey.run; covering: la finestra copre tutto l'ascoltato.
  add(run, covering) {
    if (covering || !this.layers) this.layers = {};
    for (const [layer, { mean, sd, frames }] of Object.entries(run.deep)) {
      const acc = (this.layers[layer] ||= { s1: mean.map((r) => r.map(() => 0)), s2: mean.map((r) => r.map(() => 0)), n: 0 });
      mean.forEach((row, c) => row.forEach((mu, pc) => {
        acc.s1[c][pc] += mu * frames;
        acc.s2[c][pc] += (sd[c][pc] ** 2 + mu * mu) * frames;
      }));
      acc.n += frames;
    }
  }

  get deep() {
    const out = {};
    for (const [layer, { s1, s2, n }] of Object.entries(this.layers || {})) {
      const mean = s1.map((r) => r.map((v) => v / n));
      out[layer] = { mean, sd: s2.map((r, c) => r.map((v, pc) => Math.sqrt(Math.max(0, v / n - mean[c][pc] ** 2)))) };
    }
    return out;
  }
}

export class SKey {
  constructor(graph) {
    this.net = new OnnxLite(graph);
    this.net.extraOutputs = SKEY_LAYERS.map((i) => `/chromanet/convnext_blocks.${i}/Add_1_output_0`);
  }

  // audio: Float32Array a 22050 Hz (almeno 3 s). Restituisce { p: 24 probabilità, deep: { b3…b6 } }.
  // from: secondi iniziali della finestra da escludere dai profili (già contati prima).
  run(audio, { from = 0 } = {}) {
    const res = this.net.run({ audio: { dims: [1, audio.length], data: audio, dtype: 'float32' } });
    const s = res.scores.data;
    const p = new Array(24).fill(0);
    ORDER.forEach((k, i) => { p[k] = s[i]; });
    const deep = {};
    const fraction = from / (audio.length / SKEY_RATE);
    SKEY_LAYERS.forEach((l, i) => { deep[`b${l}`] = poolLayer(res[this.net.extraOutputs[i]], fraction); });
    return { p, deep };
  }
}
