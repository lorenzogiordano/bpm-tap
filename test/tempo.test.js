import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TempoEstimator, formatBpm, quality } from '../tempo.js';
import { rng, humanTaps } from './helpers.js';

function run(times, options) {
  const est = new TempoEstimator(options);
  const statuses = times.map((t) => est.addTap(t).status);
  return { est, statuses, result: est.result() };
}

test('taps perfetti danno il tempo esatto', () => {
  const times = Array.from({ length: 8 }, (_, i) => 1000 + i * 500);
  const { result } = run(times);
  assert.ok(Math.abs(result.bpm - 120) < 1e-9);
  assert.equal(result.taps, 8);
  assert.equal(result.valid, true);
});

test('la precisione cresce con il numero di tap (errore ~ n^-1.5)', () => {
  const random = rng(1);
  const rmse = {};
  for (const n of [4, 8, 16, 32]) {
    let sq = 0;
    const trials = 400;
    for (let i = 0; i < trials; i++) {
      const bpm = 90 + random.uniform() * 60;
      const { result } = run(humanTaps({ bpm, n, jitterMs: 15, random }));
      sq += (result.bpm - bpm) ** 2;
    }
    rmse[n] = Math.sqrt(sq / trials);
  }
  assert.ok(rmse[8] < rmse[4] && rmse[16] < rmse[8] && rmse[32] < rmse[16], JSON.stringify(rmse));
  // Raddoppiando i tap l'errore scende di circa 2^1.5 ≈ 2.8 (qui almeno 2.2×).
  assert.ok(rmse[16] / rmse[32] > 2.2, JSON.stringify(rmse));
  // Con 32 tap e 15 ms di scarto l'errore tipico è sotto 0.2 BPM.
  assert.ok(rmse[32] < 0.2, JSON.stringify(rmse));
});

test('la regressione batte la media degli intervalli', () => {
  const random = rng(2);
  let regression = 0;
  let endpoints = 0;
  const trials = 500;
  for (let i = 0; i < trials; i++) {
    const times = humanTaps({ bpm: 128, n: 16, jitterMs: 20, random });
    const { result } = run(times);
    const meanInterval = (times[times.length - 1] - times[0]) / (times.length - 1);
    regression += (result.bpm - 128) ** 2;
    endpoints += (60000 / meanInterval - 128) ** 2;
  }
  assert.ok(regression < endpoints * 0.6, `${regression} vs ${endpoints}`);
});

test('il margine ±95% copre davvero il valore vero circa il 95% delle volte', () => {
  const random = rng(3);
  for (const jitterMs of [8, 20]) {
    let covered = 0;
    let total = 0;
    for (let i = 0; i < 600; i++) {
      const bpm = 80 + random.uniform() * 80;
      const n = 6 + Math.floor(random.uniform() * 30);
      const { result } = run(humanTaps({ bpm, n, jitterMs, random }));
      total += 1;
      if (Math.abs(result.bpm - bpm) <= result.halfWidth) covered += 1;
    }
    const coverage = covered / total;
    assert.ok(coverage > 0.9 && coverage <= 1, `jitter ${jitterMs}: copertura ${coverage}`);
  }
});

test('un battito saltato non falsa la stima', () => {
  const times = [0, 500, 1000, 1500, 2000, 2500, /* salto */ 3500, 4000, 4500].map((t) => t + 1000);
  const { result, statuses } = run(times);
  assert.ok(statuses.every((s) => s === 'start' || s === 'accepted'), statuses.join());
  assert.ok(Math.abs(result.bpm - 120) < 1e-9);
  assert.equal(result.beats, 10);
});

test('secondo tap perso: la misura si riallinea e non resta a metà tempo', () => {
  // Manca il tap a 1500: il primo intervallo vale due battiti.
  const times = [1000, 2000, 2500, 3000, 3500, 4000, 4500, 5000];
  const { result, statuses } = run(times);
  assert.ok(Math.abs(result.bpm - 120) < 1e-9, `${result.bpm} (${statuses.join()})`);
  assert.ok(result.taps >= 6);
});

test('tap perso a inizio misura: si riallinea da solo in pochi tap', () => {
  const times = [1000, 1500, /* perso */ 2500, 3000, 3500, 4000, 4500];
  const { result } = run(times);
  assert.ok(Math.abs(result.bpm - 120) < 1e-9, String(result.bpm));
});

test('a griglia solida un tap perso viene assorbito', () => {
  const times = [1000, 1500, 2000, 2500, /* perso */ 3500, 4000];
  const { result, statuses } = run(times);
  assert.ok(!statuses.includes('restart'), statuses.join());
  assert.equal(result.taps, 6);
  assert.equal(result.beats, 7);
});

// Contano solo i tempi qui: la difesa principale dai colpi falsi è il rilevatore
// (forza, forma, direzione). A misura avviata la griglia non si infittisce mai.
test('a misura avviata, colpi falsi a metà battito non raddoppiano mai il tempo (60 → 120)', () => {
  const random = rng(4);
  for (let trial = 0; trial < 60; trial++) {
    const real = humanTaps({ bpm: 60, n: 20, jitterMs: 20, random });
    const fake = real.slice(3, -1).filter(() => random.uniform() < 0.5).map((t) => t + 500 + 30 * random.gauss());
    const { result } = run([...real, ...fake].sort((a, b) => a - b));
    assert.ok(Math.abs(result.bpm - 60) < 2, `prova ${trial}: ${result.bpm.toFixed(1)} BPM`);
    assert.ok(result.taps >= 16, `prova ${trial}: ${result.taps} tap`);
  }
});

test('colpi falsi sporadici, anche all\'inizio: la misura finisce sul tempo giusto', () => {
  const random = rng(5);
  for (let trial = 0; trial < 60; trial++) {
    const real = humanTaps({ bpm: 60, n: 24, jitterMs: 20, random });
    const fake = real.slice(0, -1).filter(() => random.uniform() < 0.15).map((t) => t + 500 + 30 * random.gauss());
    const { result } = run([...real, ...fake].sort((a, b) => a - b));
    assert.ok(Math.abs(result.bpm - 60) < 2, `prova ${trial}: ${result.bpm.toFixed(1)} BPM`);
  }
});

test('se la griglia nasce troppo fitta per colpi falsi iniziali, si allarga da sola', () => {
  // Colpi falsi esattamente a metà nei primi due battiti, poi solo colpi veri a 60 BPM.
  const times = [0, 500, 1000, 1500, 2000, 3000, 4000, 5000, 6000, 7000, 8000].map((t) => t + 1000);
  const { result } = run(times);
  assert.ok(Math.abs(result.bpm - 60) < 1e-9, String(result.bpm));
});

test('i doppi tap (echi) vengono scartati', () => {
  const base = Array.from({ length: 10 }, (_, i) => 1000 + i * 500);
  const times = [...base.slice(0, 5), base[4] + 40, ...base.slice(5)];
  const { result, statuses } = run(times);
  assert.equal(statuses[5], 'rejected');
  assert.equal(result.taps, 10);
  assert.ok(Math.abs(result.bpm - 120) < 1e-9);
});

test('un tap isolato fuori tempo viene scartato senza spostare la stima', () => {
  const base = Array.from({ length: 12 }, (_, i) => 1000 + i * 500);
  const times = [...base.slice(0, 6), base[5] + 250, ...base.slice(6)];
  const { result, statuses } = run(times);
  assert.equal(statuses[6], 'rejected');
  assert.ok(Math.abs(result.bpm - 120) < 1e-9);
});

test('se il tempo cambia, dopo pochi tap riparte sul nuovo tempo', () => {
  const first = Array.from({ length: 10 }, (_, i) => 1000 + i * 600); // 100 BPM
  const start = first[first.length - 1] + 461.5;
  const second = Array.from({ length: 8 }, (_, i) => start + i * 461.5); // ~130 BPM
  const { result, statuses } = run([...first, ...second]);
  assert.ok(statuses.includes('restart'), statuses.join());
  assert.ok(Math.abs(result.bpm - 60000 / 461.5) < 0.01, String(result.bpm));
});

test('dopo una pausa la sessione riparte da zero', () => {
  const est = new TempoEstimator();
  [1000, 1500, 2000, 2500, 3000].forEach((t) => est.addTap(t));
  assert.equal(est.isExpired(3000 + 1999), false);
  assert.equal(est.isExpired(3000 + 2001), true);
  assert.equal(est.addTap(9000).status, 'start');
  assert.equal(est.count, 1);
});

test('il primo intervallo lento non rompe la misura (bug dei "20 BPM al primo tap")', () => {
  const est = new TempoEstimator();
  est.addTap(0);
  assert.equal(est.addTap(3000).status, 'start'); // pausa troppo lunga: nuova serie
  [3500, 4000, 4500].forEach((t) => est.addTap(t));
  assert.ok(Math.abs(est.result().bpm - 120) < 1e-9);
});

test('formattazione: decimali solo quando la stima è precisa', () => {
  assert.deepEqual(formatBpm(124.36, 3), { int: '124', dec: '', decimals: 0 });
  assert.deepEqual(formatBpm(124.36, 0.4), { int: '124', dec: '.4', decimals: 1 });
  assert.deepEqual(formatBpm(99.96, 0.2), { int: '100', dec: '.0', decimals: 1 });
});

test('etichetta di qualità coerente con il margine', () => {
  assert.equal(quality({ taps: 3, halfWidth: 5 }).label, 'Continua a battere…');
  assert.equal(quality({ taps: 10, halfWidth: 0.3 }).label, 'Precisa');
  assert.ok(quality({ taps: 10, halfWidth: 0.1 }).level === 1);
  assert.ok(quality({ taps: 10, halfWidth: 5 }).level === 0);
});
