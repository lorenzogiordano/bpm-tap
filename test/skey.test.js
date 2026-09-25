import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SKey, SKEY_RATE, poolLayer, DeepAverage } from '../audio/skey.js';
import { skeyBlocks, standardize, scoreKeys, softmax } from '../audio/key-features.js';

function rng(seed) { let s = seed; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

// Uscita di strato finta [1, C, 84, T] e una sua fetta nel tempo [a, b).
const C = 2;
const H = 84;
function tensor(T, random) {
  return { dims: [1, C, H, T], data: Float32Array.from({ length: C * H * T }, () => random() * 2 - 1) };
}
function slice(t, a, b) {
  const T = t.dims[3];
  const data = new Float32Array(C * H * (b - a));
  for (let row = 0; row < C * H; row++) data.set(t.data.subarray(row * T + a, row * T + b), row * (b - a));
  return { dims: [1, C, H, b - a], data };
}

test('media sui frame nuovi: due finestre sovrapposte danno la media e la deviazione di tutto', () => {
  const full = tensor(30, rng(1));
  // Prima finestra: frame 0–19 (copre tutto l'ascoltato). Seconda: frame 10–29, di cui nuovi 20–29.
  const first = { deep: { b6: poolLayer(slice(full, 0, 20)) } };
  const second = { deep: { b6: poolLayer(slice(full, 10, 30), 0.5) } };
  assert.equal(second.deep.b6.frames, 10);
  const avg = new DeepAverage();
  avg.add(first, true);
  avg.add(second, false);
  const ref = poolLayer(full);
  const got = avg.deep.b6;
  for (let c = 0; c < C; c++) {
    for (let pc = 0; pc < 12; pc++) {
      assert.ok(Math.abs(got.mean[c][pc] - ref.mean[c][pc]) < 1e-9);
      assert.ok(Math.abs(got.sd[c][pc] - ref.sd[c][pc]) < 1e-9);
    }
  }
});

test('una finestra che copre tutto l\'ascoltato sostituisce i passaggi precedenti', () => {
  const random = rng(2);
  const avg = new DeepAverage();
  avg.add({ deep: { b6: poolLayer(tensor(6, random)) } }, true);
  const later = poolLayer(tensor(14, random));
  avg.add({ deep: { b6: later } }, true);
  assert.deepEqual(avg.deep.b6.mean.map((r) => r.map((v) => v.toFixed(9))), later.mean.map((r) => r.map((v) => v.toFixed(9))));
});

// Cadenza sintetica (accordi con armoniche e basso), ripetuta tre volte in 12 s.
function cadence(chords, bass, shift = 0, seconds = 12) {
  const midi = (m) => 440 * 2 ** ((m + shift - 69) / 12);
  const n = seconds * SKEY_RATE;
  const out = new Float32Array(n);
  const per = n / chords.length / 3;
  for (let rep = 0; rep < 3; rep++) {
    chords.forEach((chord, i) => {
      const start = Math.round((rep * chords.length + i) * per);
      for (let j = 0; j < per; j++) {
        const t = j / SKEY_RATE;
        let v = 0;
        for (const m of [...chord, bass[i]]) for (let h = 1; h <= 5; h++) v += Math.sin(2 * Math.PI * midi(m) * h * t) / h ** 1.5;
        out[start + j] = 0.08 * Math.min(1, j / 200) * Math.exp(-1.5 * t) * v;
      }
    });
  }
  return out;
}

test('catena completa della tonalità (S-KEY + modello dell\'app) su cadenze sintetiche', () => {
  const skey = new SKey(JSON.parse(readFileSync(new URL('../audio/skey-graph.json', import.meta.url), 'utf8')));
  const model = JSON.parse(readFileSync(new URL('../audio/key-model.json', import.meta.url), 'utf8'));
  const major = [[[60, 64, 67], [65, 69, 72], [67, 71, 74], [60, 64, 67]], [48, 41, 43, 48]]; // I–IV–V–I
  const minor = [[[57, 60, 64], [62, 65, 69], [64, 68, 71], [57, 60, 64]], [45, 38, 40, 45]]; // i–iv–V–i
  for (const [[chords, bass], shift, expected] of [[major, 0, 0], [minor, 0, 9 + 12], [major, 3, 3]]) {
    const run = skey.run(cadence(chords, bass, shift));
    const avg = new DeepAverage();
    avg.add(run, true);
    const probs = softmax(scoreKeys(standardize(skeyBlocks({ p: run.p, deep: avg.deep }), model.blocks, model.scales), model.weights));
    assert.equal(probs.indexOf(Math.max(...probs)), expected);
    assert.ok(probs[expected] > 0.5, String(probs[expected]));
  }
});
