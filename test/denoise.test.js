import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NoiseProfile, Denoiser } from '../lab/denoise.mjs';

const SR = 22050;
function rng(seed) { let s = seed; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
const tone = (f, n, amp) => Float64Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / SR));
function hum(n, random) {
  // Ronzio di rete a 50 Hz con armoniche, più fruscio.
  return Float64Array.from({ length: n }, (_, i) =>
    0.2 * Math.sin((2 * Math.PI * 50 * i) / SR) + 0.1 * Math.sin((2 * Math.PI * 100 * i) / SR) + 0.05 * (random() * 2 - 1));
}
function energyAt(x, f) {
  let re = 0; let im = 0;
  for (let i = 0; i < x.length; i++) { re += x[i] * Math.cos((2 * Math.PI * f * i) / SR); im += x[i] * Math.sin((2 * Math.PI * f * i) / SR); }
  return Math.hypot(re, im) / x.length;
}

test('senza rumore da togliere, il pulitore restituisce il segnale (a meno del ritardo)', () => {
  const profile = new NoiseProfile();
  profile.push(new Float64Array(SR)); // silenzio vero
  const d = new Denoiser(profile);
  const x = tone(440, SR * 2, 0.5);
  const y = d.process(x);
  const delay = 2048 - 512;
  let err = 0;
  for (let i = 4096; i < y.length - 100; i++) err = Math.max(err, Math.abs(y[i] - x[i - delay]));
  assert.ok(err < 1e-6, String(err));
});

test('con il profilo misurato nel silenzio, il ronzio a 50 Hz sparisce e la nota resta', () => {
  const random = rng(3);
  const profile = new NoiseProfile();
  profile.push(hum(SR * 3, random));
  const d = new Denoiser(profile);
  const x = tone(392, SR * 4, 0.3).map((v, i, a) => v + hum(1, random)[0] * 0 + 0.2 * Math.sin((2 * Math.PI * 50 * i) / SR) + 0.1 * Math.sin((2 * Math.PI * 100 * i) / SR));
  const y = d.process(x).subarray(SR);
  const before = energyAt(x.subarray(SR), 50) / energyAt(x.subarray(SR), 392);
  const after = energyAt(y, 50) / energyAt(y, 392);
  assert.ok(after < before * 0.15, `50 Hz / nota: prima ${before.toFixed(3)}, dopo ${after.toFixed(3)}`);
  assert.ok(energyAt(y, 392) > 0.8 * energyAt(x.subarray(SR), 392));
});

test('senza silenzio: toglie il fruscio ma non le note tenute a lungo', () => {
  const random = rng(5);
  const d = new Denoiser(null);
  // Una nota tenuta per 8 secondi (come un accordo lungo) sopra un fruscio costante.
  const x = Float64Array.from({ length: SR * 8 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 392 * i) / SR) + 0.05 * (random() * 2 - 1));
  const y = d.process(x).subarray(SR * 4);
  const ref = x.subarray(SR * 4);
  assert.ok(energyAt(y, 392) > 0.85 * energyAt(ref, 392), `nota: ${energyAt(y, 392).toFixed(4)} vs ${energyAt(ref, 392).toFixed(4)}`);
  // Il fruscio lontano dalla nota cala.
  const band = (s) => [2500, 3100, 3700, 4300].reduce((a, f) => a + energyAt(s, f), 0);
  assert.ok(band(y) < 0.6 * band(ref), `fruscio: ${band(y).toExponential(2)} vs ${band(ref).toExponential(2)}`);
});
