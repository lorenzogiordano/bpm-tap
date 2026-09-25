import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FFT, hann, Framer, Resampler } from '../audio/dsp.js';

const sine = (freq, rate, seconds, amp = 1) =>
  Float64Array.from({ length: Math.round(rate * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate));

function peakFrequency(signal, rate, size = 8192) {
  const fft = new FFT(size);
  const w = hann(size);
  const frame = signal.slice(signal.length - size).map((v, i) => v * w[i]);
  const mags = fft.magnitudes(frame);
  let best = 0;
  for (let k = 1; k < mags.length; k++) if (mags[k] > mags[best]) best = k;
  return { freq: (best * rate) / size, mags };
}

test('FFT: una sinusoide finisce nel bin giusto e la trasformata inversa torna indietro', () => {
  const { freq } = peakFrequency(sine(440, 22050, 1), 22050);
  assert.ok(Math.abs(freq - 440) < 22050 / 8192);
  const fft = new FFT(64);
  const re = Float64Array.from({ length: 64 }, (_, i) => Math.sin(i) + 0.3 * Math.cos(3 * i));
  const im = new Float64Array(64);
  const orig = re.slice();
  fft.transform(re, im);
  fft.transform(re, im, true);
  re.forEach((v, i) => assert.ok(Math.abs(v - orig[i]) < 1e-9));
});

test('Framer: frame regolari anche quando il passo non divide la lunghezza', () => {
  const framer = new Framer(10, 3);
  const starts = [];
  const data = Float64Array.from({ length: 100 }, (_, i) => i);
  // A pezzi irregolari, come arrivano dal microfono.
  for (let i = 0; i < data.length; i += 7) framer.push(data.subarray(i, i + 7), (f) => starts.push(f[0]));
  assert.deepEqual(starts, Array.from({ length: starts.length }, (_, i) => i * 3));
  assert.equal(starts.length, Math.floor((100 - 10) / 3) + 1);
});

test('Resampler 48000 → 22050: conserva il tono, elimina l\'aliasing, lavora a pezzi', () => {
  const resampler = new Resampler(48000, 22050);
  // Tono esattamente su un bin della FFT di verifica (372 · 22050 / 8192 Hz), per misurarne l'ampiezza.
  const tone = (372 * 22050) / 8192;
  const input = Float64Array.from(sine(tone, 48000, 2)).map((v, i) => v + 0.5 * Math.sin((2 * Math.PI * 15000 * i) / 48000));
  const chunks = [];
  for (let i = 0; i < input.length; i += 1000) chunks.push(resampler.process(input.subarray(i, i + 1000)));
  const out = Float64Array.from(chunks.flatMap((c) => Array.from(c)));
  assert.ok(Math.abs(out.length - 2 * 22050) < 40, String(out.length));
  const { freq, mags } = peakFrequency(out, 22050);
  assert.ok(Math.abs(freq - tone) < 3, String(freq));
  // I 15 kHz non esistono a 22050 Hz: senza filtro ricomparirebbero a 22050 − 15000 = 7050 Hz.
  const aliasBin = Math.round((7050 * 8192) / 22050);
  const toneBin = 372;
  assert.ok(mags[aliasBin] < mags[toneBin] * 0.01, `${mags[aliasBin]} vs ${mags[toneBin]}`);
  // Ampiezza conservata (una sinusoide di ampiezza 1 → picco ≈ somma della finestra / 2).
  const expected = hann(8192).reduce((a, b) => a + b, 0) / 2;
  assert.ok(Math.abs(mags[toneBin] / expected - 1) < 0.05, String(mags[toneBin] / expected));
});
