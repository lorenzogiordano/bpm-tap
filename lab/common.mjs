// Strumenti comuni del banco di prova: dataset, metriche, simulazione del microfono.
// I dati (audio e annotazioni) stanno fuori dal repository, in lab/work/data (vedi
// lab/README.md) oppure dove indica BPM_LAB_DATA. Cache e risultati vanno accanto.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FFT, Resampler } from '../audio/dsp.js';
import { NoiseProfile, Denoiser } from './denoise.mjs';

export const DATA = process.env.BPM_LAB_DATA || fileURLToPath(new URL('./work/data', import.meta.url));
export const CACHE = join(DATA, '..', 'cache');

export function loadDataset(name) {
  const path = join(DATA, name, 'index.json');
  if (!existsSync(path)) throw new Error(`Dataset mancante: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8')).map((item) => ({ ...item, dataset: name }));
}

// Audio del brano a 22050 Hz (i file a 11025 Hz vengono ricampionati con lo stesso
// ricampionatore dell'app).
export function loadAudio(item) {
  const buf = readFileSync(join(DATA, item.dataset, item.file));
  let audio;
  if (item.file.endsWith('.s16')) {
    const s = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
    audio = Float32Array.from(s, (v) => v / 32768);
  } else {
    audio = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }
  const rate = item.sampleRate || 22050;
  if (rate === 22050) return audio;
  return Float32Array.from(new Resampler(rate, 22050).process(audio));
}

// ---------- Metriche della tonalità ----------

const same = (a, b) => a.tonic === b.tonic && a.mode === b.mode;

// Categoria dell'errore secondo MIREX: giusta, quinta, relativa, parallela, altro.
export function keyRelation(est, ref) {
  if (same(est, ref)) return 'correct';
  const d = (est.tonic - ref.tonic + 12) % 12;
  if (est.mode === ref.mode && (d === 7 || d === 5)) return 'fifth';
  if (ref.mode === 'major' && est.mode === 'minor' && d === 9) return 'relative';
  if (ref.mode === 'minor' && est.mode === 'major' && d === 3) return 'relative';
  if (est.mode !== ref.mode && d === 0) return 'parallel';
  return 'other';
}

export const MIREX_WEIGHTS = { correct: 1, fifth: 0.5, relative: 0.3, parallel: 0.2, other: 0 };

// Stessa scala (stesse 7 note): la tonalità giusta o la sua relativa.
export function sameScale(est, ref) {
  const r = keyRelation(est, ref);
  return r === 'correct' || r === 'relative';
}

export function keyReport(pairs) {
  const counts = { correct: 0, fifth: 0, relative: 0, parallel: 0, other: 0 };
  let weighted = 0;
  for (const { est, ref } of pairs) {
    const r = keyRelation(est, ref);
    counts[r] += 1;
    weighted += MIREX_WEIGHTS[r];
  }
  const n = pairs.length || 1;
  const pct = (v) => Math.round((1000 * v) / n) / 10;
  return {
    n: pairs.length,
    exact: pct(counts.correct),
    mirex: pct(weighted),
    scale: pct(counts.correct + counts.relative),
    fifth: pct(counts.fifth),
    relative: pct(counts.relative),
    parallel: pct(counts.parallel),
    other: pct(counts.other),
  };
}

// ---------- Metriche del tempo ----------

export function tempoReport(pairs, tolerance = 0.04) {
  let acc1 = 0;
  let acc2 = 0;
  for (const { est, ref } of pairs) {
    if (!est) continue;
    const ok = (f) => Math.abs(est - ref * f) <= tolerance * ref * f;
    if (ok(1)) acc1 += 1;
    if ([1, 2, 0.5, 3, 1 / 3].some(ok)) acc2 += 1;
  }
  const n = pairs.length || 1;
  return { n: pairs.length, acc1: Math.round((1000 * acc1) / n) / 10, acc2: Math.round((1000 * acc2) / n) / 10 };
}

// ---------- Simulazione dell'ascolto dal microfono ----------

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Biquad (RBJ) passa-alto o passa-basso del secondo ordine, applicato in place.
function biquad(x, sampleRate, type, freq, q = Math.SQRT1_2) {
  const w = (2 * Math.PI * freq) / sampleRate;
  const alpha = Math.sin(w) / (2 * q);
  const cos = Math.cos(w);
  let b0, b1, b2;
  if (type === 'highpass') { b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2; }
  else { b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2; }
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
    x[i] = y;
  }
  return x;
}

function convolve(x, h) {
  const size = 2 ** Math.ceil(Math.log2(x.length + h.length));
  const fft = new FFT(size);
  const ar = new Float64Array(size); const ai = new Float64Array(size);
  const br = new Float64Array(size); const bi = new Float64Array(size);
  ar.set(x); br.set(h);
  fft.transform(ar, ai); fft.transform(br, bi);
  for (let k = 0; k < size; k++) {
    const r = ar[k] * br[k] - ai[k] * bi[k];
    const i = ar[k] * bi[k] + ai[k] * br[k];
    ar[k] = r; ai[k] = i;
  }
  fft.transform(ar, ai, true);
  return ar.subarray(0, x.length);
}

// Canzone che suona da una cassa nella stanza e viene ripresa dal telefono:
// banda della cassa/microfono, riverbero della stanza, rumore di fondo.
export function simulateMic(audio, sampleRate, { seed = 1, highpass = 150, lowpass = 8000, rt60 = 0.5, drr = 3, snr = 20 } = {}) {
  const random = rng(seed);
  let x = Float64Array.from(audio);
  biquad(x, sampleRate, 'highpass', highpass);
  biquad(x, sampleRate, 'highpass', highpass);
  biquad(x, sampleRate, 'lowpass', lowpass);
  // Risposta all'impulso della stanza: suono diretto + coda di rumore che decade (RT60).
  const irLength = Math.round(rt60 * sampleRate);
  const ir = new Float64Array(irLength);
  const decay = Math.log(1000) / (rt60 * sampleRate);
  let tail = 0;
  for (let i = Math.round(0.005 * sampleRate); i < irLength; i++) {
    ir[i] = (random() * 2 - 1) * Math.exp(-decay * i);
    tail += ir[i] ** 2;
  }
  const scale = Math.sqrt(10 ** (-drr / 10) / tail);
  for (let i = 0; i < irLength; i++) ir[i] *= scale;
  ir[0] = 1;
  x = Float64Array.from(convolve(x, ir));
  // Rumore rosa approssimato (filtro di Paul Kellet economico) al rapporto segnale/rumore voluto.
  const noise = new Float64Array(x.length);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < noise.length; i++) {
    const white = random() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.963 * b1 + white * 0.2965164;
    b2 = 0.57 * b2 + white * 1.0526913;
    noise[i] = b0 + b1 + b2 + white * 0.1848;
  }
  const power = (v) => v.reduce((a, b) => a + b * b, 0) / v.length;
  const k = Math.sqrt(power(x) / (power(noise) * 10 ** (snr / 10)));
  for (let i = 0; i < x.length; i++) x[i] += k * noise[i];
  return x;
}

// ---------- Situazioni d'ascolto realistiche (per le prove "da stanza") ----------

// Rumori d'ambiente, stessa lunghezza richiesta. Tipi: fan, hum, babble, pink.
function ambientNoise(type, length, sampleRate, random) {
  const out = new Float64Array(length);
  let b0 = 0, b1 = 0, b2 = 0, brown = 0;
  const pink = () => {
    const white = random() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.963 * b1 + white * 0.2965164;
    b2 = 0.57 * b2 + white * 1.0526913;
    return b0 + b1 + b2 + white * 0.1848;
  };
  if (type === 'fan') {
    // Rumore basso e cupo (ventola, condizionatore) più un filo di fruscio.
    for (let i = 0; i < length; i++) { brown = 0.995 * brown + 0.1 * (random() * 2 - 1); out[i] = brown + 0.3 * pink(); }
  } else if (type === 'hum') {
    // Ronzio della rete elettrica a 50 Hz con armoniche, leggermente fluttuante, più fruscio.
    const phase = random() * 6.28;
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const wobble = 1 + 0.05 * Math.sin(2 * Math.PI * 0.3 * t);
      out[i] = wobble * (Math.sin(2 * Math.PI * 50 * t + phase) + 0.5 * Math.sin(2 * Math.PI * 100 * t) + 0.3 * Math.sin(2 * Math.PI * 150 * t) + 0.15 * Math.sin(2 * Math.PI * 200 * t)) + 0.2 * pink();
    }
  } else if (type === 'babble') {
    // Chiacchiericcio: alcune "voci" (rumore in banda vocale) che si accendono a ritmo di sillaba.
    const voices = Array.from({ length: 5 }, () => ({ rate: 3 + random() * 3, phase: random() * 6.28, lp: 0, hp: 0 }));
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      let v = 0;
      for (const voice of voices) {
        const env = Math.max(0, Math.sin(2 * Math.PI * voice.rate * t + voice.phase)) ** 2 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.2 * t + voice.phase));
        const w = random() * 2 - 1;
        voice.lp = 0.7 * voice.lp + 0.3 * w;        // taglia gli acuti
        voice.hp = voice.lp - 0.9 * voice.hp * 0;   // (semplice banda vocale)
        v += env * voice.lp;
      }
      out[i] = v + 0.1 * pink();
    }
  } else {
    for (let i = 0; i < length; i++) out[i] = pink();
  }
  return out;
}

const power = (v) => v.reduce((a, b) => a + b * b, 0) / (v.length || 1);

// Canzone che suona da una cassa nella stanza, ripresa dal telefono, con `lead` secondi di
// solo rumore prima. Restituisce { lead, mix } (mix = rumore + musica, senza il lead).
// near: telefono vicino alla cassa (~30 cm): più suono diretto rispetto all'eco (+10 dB)
// e musica più forte rispetto al rumore della stanza (+10 dB).
export function micScenario(audio, sampleRate, { seed = 1, lead = 3, factors = { speaker: true, reverb: true, noise: true }, near = false } = {}) {
  const random = rng(seed);
  const pickOf = (list) => list[Math.floor(random() * list.length)];
  const noiseType = pickOf(['fan', 'hum', 'babble', 'pink']);
  const snr = 10 + 10 * random() + (near ? 10 : 0);
  const highpass = pickOf([120, 250, 400]);
  const rt60 = 0.3 + 0.4 * random();
  let music = Float64Array.from(audio);
  if (factors.speaker) {
    biquad(music, sampleRate, 'highpass', highpass);
    biquad(music, sampleRate, 'highpass', highpass);
    biquad(music, sampleRate, 'lowpass', 8000);
  }
  const irLength = Math.round(rt60 * sampleRate);
  const ir = new Float64Array(irLength);
  const decay = Math.log(1000) / (rt60 * sampleRate);
  let tail = 0;
  for (let i = Math.round(0.005 * sampleRate); i < irLength; i++) { ir[i] = (random() * 2 - 1) * Math.exp(-decay * i); tail += ir[i] ** 2; }
  const scale = Math.sqrt(10 ** ((near ? -13 : -3) / 10) / tail);
  for (let i = 0; i < irLength; i++) ir[i] *= scale;
  ir[0] = 1;
  if (factors.reverb) music = Float64Array.from(convolve(music, ir));
  const leadLength = Math.round(lead * sampleRate);
  const noise = ambientNoise(noiseType, leadLength + music.length, sampleRate, random);
  const k = factors.noise ? Math.sqrt(power(music) / (power(noise) * 10 ** (snr / 10))) : 0;
  const lead_ = Float64Array.from(noise.subarray(0, leadLength), (v) => k * v);
  const mix = Float64Array.from(music, (v, i) => v + k * noise[leadLength + i]);
  return { lead: lead_, mix, scenario: { noiseType, snr: Math.round(snr), highpass, rt60: Math.round(rt60 * 100) / 100 } };
}

// Audio da analizzare in una condizione: clean | mic | mic-calib | mic-auto.
export function conditionAudio(audio, sampleRate, condition, seed) {
  if (condition === 'clean') return audio;
  // Fattori isolati: solo-cassa, solo-eco, solo-rumore.
  const only = { 'only-speaker': 'speaker', 'only-reverb': 'reverb', 'only-noise': 'noise' }[condition];
  if (only) return micScenario(audio, sampleRate, { seed, factors: { speaker: false, reverb: false, noise: false, [only]: true } }).mix;
  const pair = { 'speaker-noise': ['speaker', 'noise'], 'reverb-noise': ['reverb', 'noise'], 'speaker-reverb': ['speaker', 'reverb'] }[condition];
  if (pair) return micScenario(audio, sampleRate, { seed, factors: { speaker: pair.includes('speaker'), reverb: pair.includes('reverb'), noise: pair.includes('noise') } }).mix;
  if (condition === 'mic-near') return micScenario(audio, sampleRate, { seed, near: true }).mix;
  const { lead, mix } = micScenario(audio, sampleRate, { seed });
  if (condition === 'mic') return mix;
  if (condition === 'mic-calib') {
    const profile = new NoiseProfile();
    profile.push(lead);
    return new Denoiser(profile).process(mix);
  }
  if (condition === 'mic-auto') return new Denoiser(null).process(mix);
  throw new Error(`condizione sconosciuta: ${condition}`);
}
