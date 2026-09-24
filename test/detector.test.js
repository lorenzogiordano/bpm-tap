import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TapDetector } from '../detector.js';
import { TempoEstimator } from '../tempo.js';
import { rng, humanTaps } from './helpers.js';

const DT = 1000 / 60;

// Segnale z simulato a 60 Hz: rumore della mano + eventuale movimento lento +
// per ogni tap un'oscillazione smorzata (spinta e rimbalzo del telefono nella
// mano) che parte in un istante qualsiasi tra due campioni. Ogni tap ha forza,
// frequenza e smorzamento un po' diversi. È un modello sintetico: i valori
// reali vanno verificati sull'iPhone con "Esporta dati del sensore".
function simulate({ taps, durationMs, noise = 0.02, amplitude = 1.2, sway = 0,
  freq = [12, 22], decayMs = [15, 30], random }) {
  const shapes = taps.map(() => ({
    a: amplitude * (0.7 + 0.6 * random.uniform()),
    f: freq[0] + (freq[1] - freq[0]) * random.uniform(),
    tau: (decayMs[0] + (decayMs[1] - decayMs[0]) * random.uniform()) / 1000,
  }));
  const samples = [];
  for (let t = 0; t < durationMs; t += DT) {
    let z = noise * random.gauss() + sway * Math.sin(2 * Math.PI * 0.8 * t / 1000);
    taps.forEach((tap, i) => {
      const u = (t - tap) / 1000;
      const { a, f, tau } = shapes[i];
      if (u >= 0 && u < 0.2) z += a * Math.exp(-u / tau) * Math.sin(2 * Math.PI * f * u + 0.6);
    });
    samples.push({ t, z });
  }
  return samples;
}

function detect(samples, options) {
  const detector = new TapDetector(options);
  return samples.map((s) => detector.push(s.t, s.z)).filter((tap) => tap !== null).map((tap) => tap.time);
}

// Tap in istanti qualsiasi rispetto alla griglia dei campioni a 60 Hz.
function tapsOffGrid({ bpm, n, random }) {
  return humanTaps({ bpm, n, jitterMs: 0, start: 2000, random }).map((t) => t + random.uniform() * DT);
}

test('rileva ogni tap a 60 Hz senza falsi positivi', () => {
  const random = rng(10);
  const taps = tapsOffGrid({ bpm: 120, n: 30, random });
  const found = detect(simulate({ taps, durationMs: 18000, random }));
  assert.equal(found.length, taps.length);
});

test('errore di temporizzazione piccolo rispetto allo scarto umano (15–25 ms)', () => {
  const random = rng(11);
  const taps = tapsOffGrid({ bpm: 100, n: 40, random });
  const found = detect(simulate({ taps, durationMs: 28000, random }));
  assert.equal(found.length, taps.length);
  // Conta solo la variabilità (un ritardo costante non cambia i BPM).
  const errors = found.map((t, i) => t - taps[i]);
  const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
  const sd = Math.sqrt(errors.reduce((a, e) => a + (e - mean) ** 2, 0) / errors.length);
  assert.ok(sd < 10, `deviazione standard ${sd.toFixed(2)} ms`);
});

test('il movimento lento della mano non genera tap', () => {
  const random = rng(12);
  const found = detect(simulate({ taps: [], durationMs: 20000, sway: 1.5, noise: 0.03, random }));
  assert.equal(found.length, 0);
});

// Un impulso che si smorza in ~10 ms può cadere quasi tutto tra due campioni a
// 60 Hz: è un limite fisico della frequenza di campionamento, non dell'algoritmo.
// I tap persi non falsano i BPM (la stima gestisce i battiti saltati).
test('impulsi brevissimi (caso peggiore a 60 Hz): se ne perde qualcuno ma nessun falso', () => {
  const random = rng(15);
  const taps = tapsOffGrid({ bpm: 120, n: 40, random });
  const found = detect(simulate({ taps, durationMs: 23000, freq: [28, 28], decayMs: [10, 12], random }));
  assert.ok(found.length >= 0.65 * taps.length && found.length <= taps.length, String(found.length));
});

test('tap deboli: la sensibilità alta li prende, quella bassa no', () => {
  const random = rng(13);
  const taps = tapsOffGrid({ bpm: 110, n: 20, random });
  const samples = simulate({ taps, durationMs: 14000, amplitude: 0.35, noise: 0.02, random });
  const high = detect(samples, { sensitivity: 9 }).length;
  assert.ok(high >= 18 && high <= 21, String(high));
  assert.ok(detect(samples, { sensitivity: 1 }).length < taps.length / 2);
});

test('dal sensore ai BPM: 24 tap umani a 124 BPM', () => {
  const random = rng(14);
  const taps = humanTaps({ bpm: 124, n: 24, jitterMs: 15, start: 2000, random });
  const found = detect(simulate({ taps, durationMs: 15000, random }));
  const est = new TempoEstimator();
  found.forEach((t) => est.addTap(t));
  const result = est.result();
  assert.equal(result.taps, 24);
  assert.ok(Math.abs(result.bpm - 124) < 0.6, String(result.bpm));
  assert.ok(Math.abs(result.bpm - 124) <= result.halfWidth * 1.5);
});

test('vicino al battito atteso la soglia si abbassa e prende il colpo debole', () => {
  const random = rng(16);
  const weakTap = 3000.3;
  const samples = simulate({ taps: [weakTap], durationMs: 4000, amplitude: 0.35, freq: [15, 15], decayMs: [20, 20], random });
  assert.equal(detect(samples).length, 0);
  const detector = new TapDetector();
  const found = [];
  for (const s of samples) {
    if (s.t > 2000 && s.t < 2000 + DT) detector.expect(weakTap, 80);
    const tap = detector.push(s.t, s.z);
    if (tap) found.push(tap);
  }
  assert.equal(found.length, 1);
  assert.equal(found[0].assisted, true);
  assert.ok(Math.abs(found[0].time - weakTap) < 40);
});

// Catena completa come nell'app: rilevatore + stima + previsione del battito.
function session(samples) {
  const detector = new TapDetector();
  const est = new TempoEstimator();
  const taps = [];
  for (const { t, z } of samples) {
    const tap = detector.push(t, z);
    if (!tap) continue;
    const { status } = est.addTap(tap.time);
    taps.push({ ...tap, status });
    const next = est.count >= 3 ? est.nextBeat(tap.time) : null;
    if (next) detector.expect(next.time, next.halfWidth, !tap.assisted);
    else detector.expect(null);
  }
  return { taps, result: est.result() };
}

test('tap deboli: con la previsione del battito se ne perdono pochissimi e i BPM restano giusti', () => {
  let found = 0;
  let total = 0;
  let phantoms = 0;
  for (let seed = 0; seed < 8; seed++) {
    const random = rng(700 + seed);
    const bpm = 90 + 60 * random.uniform();
    const truth = tapsOffGrid({ bpm, n: 32, random }).map((t) => t + 15 * random.gauss());
    const end = Math.max(...truth);
    const { taps, result } = session(simulate({ taps: truth, durationMs: end + 4000, amplitude: 0.3, random }));
    found += taps.filter((t) => t.time < end + 100 && t.status !== 'rejected').length;
    phantoms += taps.filter((t) => t.time >= end + 100).length;
    total += truth.length;
    assert.ok(Math.abs(result.bpm - bpm) < 0.6, `seed ${seed}: ${result.bpm} vs ${bpm}`);
  }
  assert.ok(found / total > 0.9, `presi ${found}/${total}`);
  assert.ok(phantoms <= 1, `tap fantasma dopo lo stop: ${phantoms}`);
});
