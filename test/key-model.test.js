import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OnnxLite } from '../audio/onnx-lite.js';
import { chromaBlocks, skeyBlocks, standardize, scoreKeys, softmax } from '../audio/key-features.js';

const b64 = (arr) => Buffer.from(new Float32Array(arr).buffer).toString('base64');

test('interprete ONNX: convoluzione, matmul, broadcasting e softmax come nel calcolo diretto', () => {
  // x [1,1,6] → Conv(k=3, stride 1, pad 1) → [1,2,6] → Transpose → [1,6,2] → MatMul [2,3] → Add bias [3] → Softmax
  const graph = {
    inputs: ['x'],
    outputs: ['y'],
    tensors: {
      w: { dtype: 'float32', dims: [2, 1, 3], data: b64([1, 0, -1, 0.5, 0.5, 0.5]) },
      b: { dtype: 'float32', dims: [2], data: b64([0.1, -0.2]) },
      m: { dtype: 'float32', dims: [2, 3], data: b64([1, 2, 3, -1, 0, 1]) },
      bias: { dtype: 'float32', dims: [3], data: b64([0, 1, 2]) },
    },
    nodes: [
      { op: 'Conv', in: ['x', 'w', 'b'], out: ['c'], attrs: { pads: [1, 1], strides: [1] } },
      { op: 'Transpose', in: ['c'], out: ['t'], attrs: { perm: [0, 2, 1] } },
      { op: 'MatMul', in: ['t', 'm'], out: ['mm'], attrs: {} },
      { op: 'Add', in: ['bias', 'mm'], out: ['a'], attrs: {} },
      { op: 'Softmax', in: ['a'], out: ['y'], attrs: { axis: -1 } },
    ],
  };
  const x = [1, 2, 3, 4, 5, 6];
  const out = new OnnxLite(graph).run({ x: { dims: [1, 1, 6], data: Float32Array.from(x), dtype: 'float32' } }).y;
  assert.deepEqual(out.dims, [1, 6, 3]);
  // Calcolo diretto.
  const at = (i) => (i >= 0 && i < 6 ? x[i] : 0);
  for (let t = 0; t < 6; t++) {
    const c0 = at(t - 1) * 1 + at(t) * 0 + at(t + 1) * -1 + 0.1;
    const c1 = 0.5 * (at(t - 1) + at(t) + at(t + 1)) - 0.2;
    const a = [c0 * 1 + c1 * -1 + 0, c0 * 2 + c1 * 0 + 1, c0 * 3 + c1 * 1 + 2];
    const e = a.map((v) => Math.exp(v - Math.max(...a)));
    const z = e.reduce((p, q) => p + q, 0);
    e.forEach((v, j) => assert.ok(Math.abs(out.data[t * 3 + j] - v / z) < 1e-5));
  }
});

test('indizi della tonalità: trasporre la musica sposta i punteggi della stessa quantità', () => {
  const random = (() => { let s = 7; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); })();
  const frames = Array.from({ length: 40 }, () => {
    const t = Array.from({ length: 12 }, () => random());
    const b = Array.from({ length: 12 }, () => random());
    const tm = Math.max(...t);
    const bm = Math.max(...b);
    return { t: t.map((v) => v / tm), b: b.map((v) => v / bm), tonal: 0.5 + 0.5 * random() };
  });
  const p = softmax(Array.from({ length: 24 }, () => random() * 3));
  const deep = { b6: { mean: [Array.from({ length: 12 }, () => random())], sd: [Array.from({ length: 12 }, () => random())] } };
  const names = ['treble', 'bass', 'majtriad', 'mintriad', 'gbass', 'skmaj', 'skmin', 'd6m_0'];
  const scales = Object.fromEntries(names.map((n) => [n, 0.5]));
  const weights = [Float64Array.from({ length: names.length * 12 }, () => random() - 0.5), Float64Array.from({ length: names.length * 12 }, () => random() - 0.5)];
  const score = (shift) => {
    const rot = (v) => Array.from({ length: 12 }, (_, i) => v[(i - shift + 12) % 12]);
    const f = frames.map((fr) => ({ t: rot(fr.t), b: rot(fr.b), tonal: fr.tonal }));
    const pp = [...rot(p.slice(0, 12)), ...rot(p.slice(12))];
    const d = { b6: { mean: [rot(deep.b6.mean[0])], sd: [rot(deep.b6.sd[0])] } };
    const blocks = { ...chromaBlocks(f), ...skeyBlocks({ p: pp, deep: d }) };
    return scoreKeys(standardize(blocks, names, scales), weights);
  };
  const base = score(0);
  const shifted = score(5);
  for (let k = 0; k < 24; k++) {
    const mode = k < 12 ? 0 : 12;
    const moved = mode + ((k % 12) + 5) % 12;
    assert.ok(Math.abs(shifted[moved] - base[k]) < 1e-9, `tonalità ${k}`);
  }
});
