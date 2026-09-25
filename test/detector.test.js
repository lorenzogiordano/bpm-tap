import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TapDetector } from '../detector.js';
import { TempoEstimator } from '../tempo.js';
import { rng, humanTaps } from './helpers.js';

const DT = 1000 / 60;

// Segnale simulato a 60 Hz sui tre assi, più la velocità di rotazione (°/s).
// È un modello sintetico: i valori reali vanno verificati sull'iPhone con
// "Esporta dati del sensore".
// - rumore della mano su tutti gli assi;
// - colpi: oscillazione smorzata (spinta e rimbalzo del telefono nella mano),
//   soprattutto lungo `axis` (z = retro), con forza, frequenza e smorzamento
//   un po' diversi da colpo a colpo e un istante qualsiasi tra due campioni;
// - shakes: scossoni sinusoidali che crescono in 0.3 s (come un polso che parte);
// - bumps: spostamenti bruschi ma lisci (mezzo seno di 150 ms).
function simulate({ taps = [], durationMs, random, noise = 0.02, amplitude = 1.2, axis = 'z',
  freq = [12, 22], decayMs = [15, 30], shakes = [], bumps = [], sway = 0 }) {
  const shapes = taps.map((tap) => {
    const t = typeof tap === 'number' ? tap : tap.t;
    const a = (typeof tap === 'number' ? amplitude : tap.amplitude) * (0.7 + 0.6 * random.uniform());
    return {
      t, a,
      axis: typeof tap === 'number' ? axis : tap.axis || axis,
      f: freq[0] + (freq[1] - freq[0]) * random.uniform(),
      tau: (decayMs[0] + (decayMs[1] - decayMs[0]) * random.uniform()) / 1000,
      side: [random.gauss() * 0.15, random.gauss() * 0.15],
    };
  });
  const samples = [];
  for (let t = 0; t < durationMs; t += DT) {
    const v = {
      x: noise * random.gauss(),
      y: noise * random.gauss() + sway * Math.sin(2 * Math.PI * 0.8 * t / 1000),
      z: noise * random.gauss(),
    };
    let rot = 5 + 3 * Math.abs(random.gauss());
    for (const sh of shapes) {
      const u = (t - sh.t) / 1000;
      if (u < 0 || u >= 0.2) continue;
      const w = sh.a * Math.exp(-u / sh.tau) * Math.sin(2 * Math.PI * sh.f * u + 0.6);
      const [o1, o2] = sh.axis === 'z' ? ['x', 'y'] : sh.axis === 'x' ? ['y', 'z'] : ['x', 'z'];
      v[sh.axis] += w;
      v[o1] += sh.side[0] * w;
      v[o2] += sh.side[1] * w;
      rot += 20 * Math.exp(-u / 0.05);
    }
    for (const sk of shakes) {
      if (t < sk.from || t > sk.to) continue;
      const ramp = Math.min(1, (t - sk.from) / 300);
      const phase = 2 * Math.PI * sk.hz * (t - sk.from) / 1000;
      v[sk.axis] += sk.amplitude * ramp * Math.sin(phase);
      if (sk.axis !== 'z') v.z += 0.3 * sk.amplitude * ramp * Math.sin(phase + 1);
      rot += sk.rotation * ramp * Math.abs(Math.sin(phase));
    }
    for (const b of bumps) {
      const u = t - b.t;
      if (u >= 0 && u < 150) v.z += b.amplitude * Math.sin(Math.PI * u / 150);
    }
    samples.push({ t, ...v, rot });
  }
  return samples;
}

function run(samples, options) {
  const detector = new TapDetector(options);
  return samples.map((s) => detector.push(s.t, s.x, s.y, s.z, s.rot)).filter(Boolean);
}

function detect(samples, options) {
  return run(samples, options).filter((e) => e.ok).map((e) => e.time);
}

// Tap in istanti qualsiasi rispetto alla griglia dei campioni a 60 Hz.
function tapsOffGrid({ bpm, n, random, start = 2000 }) {
  return humanTaps({ bpm, n, jitterMs: 0, start, random }).map((t) => t + random.uniform() * DT);
}

test('rileva ogni colpo sul retro a 60 Hz senza falsi positivi', () => {
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

test('il movimento lento della mano non genera colpi', () => {
  const random = rng(12);
  assert.equal(detect(simulate({ durationMs: 20000, sway: 1.5, noise: 0.03, random })).length, 0);
});

test('scuotere il telefono non conta come colpo, in nessuna direzione', () => {
  for (const [seed, axis, hz] of [[20, 'y', 5], [21, 'x', 4], [22, 'z', 5], [23, 'y', 7], [24, 'z', 3]]) {
    const random = rng(seed);
    const shakes = [{ from: 2000, to: 5000, axis, hz, amplitude: 15, rotation: 350 }];
    const taps = detect(simulate({ durationMs: 7000, shakes, random }));
    assert.equal(taps.length, 0, `asse ${axis} a ${hz} Hz: ${taps.length} colpi falsi`);
  }
});

test('uno spostamento brusco (appoggiare il telefono) non conta come colpo', () => {
  const random = rng(25);
  const bumps = [{ t: 2000, amplitude: 4 }, { t: 3500, amplitude: -6 }, { t: 5000, amplitude: 8 }];
  assert.equal(detect(simulate({ durationMs: 6500, bumps, random })).length, 0);
});

test('un colpo sul fianco invece che sul retro viene scartato', () => {
  const random = rng(26);
  const taps = tapsOffGrid({ bpm: 90, n: 6, random }).map((t) => ({ t, amplitude: 1.2, axis: 'x' }));
  assert.equal(detect(simulate({ taps, durationMs: 8000, random })).length, 0);
});

test('i tocchi leggeri tra un colpo forte e l\'altro vengono scartati', () => {
  const random = rng(27);
  const strong = tapsOffGrid({ bpm: 80, n: 12, random });
  const light = strong.slice(3, 11).map((t) => ({ t: t + 370, amplitude: 0.25 }));
  const taps = [...strong.map((t) => ({ t, amplitude: 1.2 })), ...light];
  const counted = detect(simulate({ taps, durationMs: 12000, random }));
  assert.equal(counted.length, strong.length, `contati ${counted.length}`);
  assert.ok(counted.every((t) => strong.some((s) => Math.abs(t - s) < 60)));
});

// Un impulso che si smorza in ~10 ms può cadere quasi tutto tra due campioni a
// 60 Hz: è un limite fisico della frequenza di campionamento. Con la forza minima
// di default (solo colpi decisi) se ne perdono circa metà; alzando la
// sensibilità se ne prendono di più. In nessun caso compaiono colpi falsi.
test('impulsi brevissimi (caso peggiore a 60 Hz): se ne perde una parte ma nessun falso', () => {
  const random = rng(15);
  const taps = tapsOffGrid({ bpm: 120, n: 40, random });
  const samples = simulate({ taps, durationMs: 23000, freq: [28, 28], decayMs: [10, 12], random });
  for (const [sensitivity, min] of [[5, 0.5], [8, 0.6]]) {
    const found = detect(samples, { sensitivity });
    assert.ok(found.length >= min * taps.length, `sensibilità ${sensitivity}: ${found.length}`);
    assert.ok(found.every((t) => taps.some((x) => Math.abs(t - x) < 60)));
  }
});

test('sensibilità: al minimo servono colpi forti, al massimo passano anche quelli leggeri', () => {
  const random = rng(13);
  const taps = tapsOffGrid({ bpm: 110, n: 20, random });
  const samples = simulate({ taps, durationMs: 14000, amplitude: 0.35, random });
  const high = detect(samples, { sensitivity: 9 }).length;
  assert.ok(high >= 18 && high <= 20, String(high));
  assert.equal(detect(samples, { sensitivity: 1 }).length, 0);
});

test('sessione simulata: colpi a 60 BPM con tocchi leggeri e uno scossone in mezzo', () => {
  for (let seed = 0; seed < 6; seed++) {
    const random = rng(300 + seed);
    const strong = humanTaps({ bpm: 60, n: 24, jitterMs: 15, start: 2000, random });
    const light = strong.filter((_, i) => i % 3 === 1)
      .map((t) => ({ t: t + 480 + 40 * random.gauss(), amplitude: 0.3 }));
    const shakes = [{ from: strong[12] + 150, to: strong[12] + 850, axis: 'y', hz: 5, amplitude: 12, rotation: 300 }];
    const samples = simulate({
      taps: [...strong.map((t) => ({ t, amplitude: 1.2 })), ...light], shakes, durationMs: strong[23] + 3000, random,
    });
    const detector = new TapDetector();
    const est = new TempoEstimator();
    for (const s of samples) {
      const e = detector.push(s.t, s.x, s.y, s.z, s.rot);
      if (e && e.ok) est.addTap(e.time);
    }
    const result = est.result();
    assert.ok(Math.abs(result.bpm - 60) < 1, `seed ${seed}: ${result.bpm.toFixed(2)} BPM`);
    assert.ok(result.taps >= 20 && result.taps <= 24, `seed ${seed}: ${result.taps} tap`);
  }
});
