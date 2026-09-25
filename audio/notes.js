// Trascrizione approssimata delle note (cromagramma NNLS, Mauch & Dixon 2010,
// lo stesso principio di Chordino).
//
// Un picco a 392 Hz può essere un Sol, ma anche la terza armonica di un Do:
// sommando i picchi, le armoniche gonfiano quinte e terze. Qui invece lo spettro
// di ogni frame viene spiegato come somma di note, ciascuna con la sua serie
// armonica (ampiezze che calano come 0.7^(h−1)), con coefficienti non negativi.
// Le attività delle note, piegate sulle 12 classi, danno un cromagramma più pulito.

export const LOG_MIN_MIDI = 20;           // un semitono sotto il La più grave del pianoforte
export const LOG_BINS_PER_SEMITONE = 3;
export const LOG_BINS = 88 * LOG_BINS_PER_SEMITONE;
export const NOTE_MIN_MIDI = 21;          // La0
export const NOTES = 84;                  // fino al Sol♯7

const midiToHz = (m) => 440 * 2 ** ((m - 69) / 12);

// Pesi sparsi per portare lo spettro lineare su bin logaritmici (1/3 di semitono).
// Dove i bin lineari sono più fitti di quelli logaritmici si media con un
// triangolo largo un bin logaritmico; dove sono più radi si interpola.
export function logMapping(frameSize, sampleRate) {
  const binHz = sampleRate / frameSize;
  const maxBin = frameSize / 2;
  const map = [];
  for (let j = 0; j < LOG_BINS; j++) {
    const midi = LOG_MIN_MIDI + j / LOG_BINS_PER_SEMITONE;
    const f = midiToHz(midi);
    const lo = midiToHz(midi - 1 / LOG_BINS_PER_SEMITONE);
    const hi = midiToHz(midi + 1 / LOG_BINS_PER_SEMITONE);
    const weights = [];
    for (let k = Math.ceil(lo / binHz); k <= Math.floor(hi / binHz) && k <= maxBin; k++) {
      const m = 12 * Math.log2((k * binHz) / 440) + 69;
      const w = 1 - Math.abs(m - midi) * LOG_BINS_PER_SEMITONE;
      if (w > 0) weights.push([k, w]);
    }
    if (weights.length < 2) {
      const x = f / binHz;
      const k0 = Math.floor(x);
      if (k0 + 1 <= maxBin) weights.splice(0, weights.length, [k0, 1 - (x - k0)], [k0 + 1, x - k0]);
    }
    const sum = weights.reduce((a, [, w]) => a + w, 0) || 1;
    map.push(weights.map(([k, w]) => [k, w / sum]));
  }
  return map;
}

export function logSpectrum(mags, map, out = new Float32Array(LOG_BINS)) {
  for (let j = 0; j < map.length; j++) {
    let v = 0;
    for (const [k, w] of map[j]) v += mags[k] * w;
    out[j] = v;
  }
  return out;
}

// Standardizzazione locale (media e deviazione su un'ottava): conta quanto una nota
// spicca rispetto ai dintorni, non quanto è forte quella zona di frequenze.
export function whitenLog(y, radius = 18) {
  const n = y.length;
  const s1 = new Float64Array(n + 1);
  const s2 = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) { s1[i + 1] = s1[i] + y[i]; s2[i + 1] = s2[i] + y[i] * y[i]; }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(n, i + radius + 1);
    const cnt = hi - lo;
    const mean = (s1[hi] - s1[lo]) / cnt;
    const sd = Math.sqrt(Math.max(0, (s2[hi] - s2[lo]) / cnt - mean * mean));
    out[i] = y[i] > mean && sd > 0 ? (y[i] - mean) / sd : 0;
  }
  return out;
}

// Dizionario delle note (colonne sparse) per un certo scarto d'intonazione in centesimi.
export function noteDictionary(tuningCents = 0, { harmonics = 20, shape = 0.7 } = {}) {
  const columns = [];
  for (let n = 0; n < NOTES; n++) {
    const col = new Map();
    for (let h = 1; h <= harmonics; h++) {
      const midi = NOTE_MIN_MIDI + n + 12 * Math.log2(h) + tuningCents / 100;
      const pos = (midi - LOG_MIN_MIDI) * LOG_BINS_PER_SEMITONE;
      const j = Math.floor(pos);
      if (j < 0 || j + 1 >= LOG_BINS) break;
      const a = shape ** (h - 1);
      const frac = pos - j;
      col.set(j, (col.get(j) || 0) + a * (1 - frac));
      col.set(j + 1, (col.get(j + 1) || 0) + a * frac);
    }
    columns.push([...col.entries()]);
  }
  // Gram EᵀE (NOTES × NOTES) per gli aggiornamenti moltiplicativi.
  const gram = new Float64Array(NOTES * NOTES);
  const dense = columns.map((c) => { const v = new Float64Array(LOG_BINS); for (const [j, a] of c) v[j] = a; return v; });
  for (let a = 0; a < NOTES; a++) {
    for (let b = a; b < NOTES; b++) {
      let s = 0;
      for (const [j, x] of columns[a]) s += x * dense[b][j];
      gram[a * NOTES + b] = s;
      gram[b * NOTES + a] = s;
    }
  }
  return { columns, gram };
}

// Minimi quadrati non negativi con aggiornamenti moltiplicativi (Lee & Seung).
export function transcribe(y, dict, iterations = 40) {
  const { columns, gram } = dict;
  const ety = new Float64Array(NOTES);
  for (let n = 0; n < NOTES; n++) {
    let s = 0;
    for (const [j, a] of columns[n]) s += a * y[j];
    ety[n] = s;
  }
  const x = new Float64Array(NOTES).fill(1e-3);
  let peak = 0;
  for (let n = 0; n < NOTES; n++) if (ety[n] > peak) peak = ety[n];
  if (peak <= 0) return x.fill(0);
  for (let n = 0; n < NOTES; n++) x[n] = Math.max(0, ety[n]) / peak;
  const gx = new Float64Array(NOTES);
  for (let it = 0; it < iterations; it++) {
    for (let a = 0; a < NOTES; a++) {
      let s = 0;
      const row = a * NOTES;
      for (let b = 0; b < NOTES; b++) s += gram[row + b] * x[b];
      gx[a] = s;
    }
    for (let n = 0; n < NOTES; n++) x[n] *= Math.max(0, ety[n]) / (gx[n] + 1e-9);
  }
  return x;
}

// Pesi per piegare le note in cromagramma degli acuti e del basso (in MIDI).
export function noteWeights({ bassLow = 28, bassHigh = 55, trebleLow = 43, trebleHigh = 100 } = {}) {
  const bass = new Float64Array(NOTES);
  const treble = new Float64Array(NOTES);
  for (let n = 0; n < NOTES; n++) {
    const m = NOTE_MIN_MIDI + n;
    bass[n] = m >= bassLow && m <= bassHigh ? 1 : 0;
    treble[n] = m >= trebleLow && m <= trebleHigh ? 1 : 0;
  }
  return { bass, treble };
}
