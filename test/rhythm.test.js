import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitBeats } from '../audio/rhythm.js';

function rng(seed) { let s = seed; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
function gauss(random) { return Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random()); }
const grid = (bpm, n, jitter, random, t0 = 1) => Array.from({ length: n }, (_, k) => t0 + (k * 60) / bpm + jitter * gauss(random));

test('battiti regolari: BPM preciso e margine stretto', () => {
  const r = fitBeats(grid(126, 60, 0.005, rng(1)), 125);
  assert.ok(Math.abs(r.bpm - 126) < 0.1, String(r.bpm));
  assert.ok(r.halfWidth < 0.3, String(r.halfWidth));
  assert.equal(r.beats, 60);
});

test('un salto di fase e un battito spurio spezzano il tratto ma non azzerano la misura', () => {
  const random = rng(2);
  const first = grid(126, 30, 0.005, random);
  // La canzone "riparte" a metà battito (montaggio o ripetizione) e il tracciatore aggiunge un colpo in mezzo.
  const second = grid(126, 30, 0.005, random, first[29] + 1.5 * (60 / 126));
  const beats = [...first, first[29] + 0.21, ...second];
  const r = fitBeats(beats, 126);
  assert.ok(Math.abs(r.bpm - 126) < 0.15, String(r.bpm));
  assert.ok(r.beats >= 58, String(r.beats));
  assert.ok(r.halfWidth < 0.5, String(r.halfWidth));
});

test('il margine al 95% contiene il valore vero in oltre il 90% dei casi', () => {
  const random = rng(3);
  let inside = 0;
  const trials = 400;
  for (let i = 0; i < trials; i++) {
    const bpm = 80 + 80 * random();
    const r = fitBeats(grid(bpm, 12 + Math.floor(40 * random()), 0.004 + 0.012 * random(), random), bpm * (1 + 0.02 * (random() - 0.5)));
    if (Math.abs(r.bpm - bpm) <= r.halfWidth) inside += 1;
  }
  assert.ok(inside / trials > 0.9, `${inside}/${trials}`);
});

test('troppo pochi battiti regolari: nessuna stima', () => {
  assert.equal(fitBeats([1, 1.5, 3.1], 120), null);
});
