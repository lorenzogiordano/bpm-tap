// Modelli equivarianti alla trasposizione per la tonalità: lineare o piccola rete (MLP).
// Punteggio della tonalità (t, m) = f_m(caratteristiche ruotate sulla tonica t); softmax sulle 24.
// Uso: node lab/key-model.mjs <cache> <blocchi> [linear|mlp] [hidden]
import { loadKeyData } from './keylab.mjs';
import { keyReport } from './common.mjs';
import { bestKey } from '../audio/key.js';
import { prepare, rotated, expandBlocks } from './keyfeat.mjs';

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

export function createModel(dims, { kind = 'linear', hidden = 16, seed = 1 } = {}) {
  const r = rng(seed);
  const init = (n, scale) => Float64Array.from({ length: n }, () => (r() * 2 - 1) * scale);
  if (kind === 'linear') return { kind, dims, w: [new Float64Array(dims), new Float64Array(dims)] };
  const s1 = Math.sqrt(1 / dims);
  const s2 = Math.sqrt(1 / hidden);
  return {
    kind, dims, hidden,
    // Primo strato condiviso tra i modi; uscita separata per maggiore e minore.
    W1: init(hidden * dims, s1), b1: new Float64Array(hidden),
    w2: [init(hidden, s2), init(hidden, s2)], lin: [new Float64Array(dims), new Float64Array(dims)],
  };
}

// Punteggi delle 24 tonalità (e cache dello strato nascosto per l'allenamento).
export function forward(model, feats) {
  const scores = new Float64Array(24);
  const cache = [];
  for (let t = 0; t < 12; t++) {
    const x = feats[t];
    if (model.kind === 'linear') {
      for (let m = 0; m < 2; m++) {
        let s = 0;
        for (let d = 0; d < model.dims; d++) s += model.w[m][d] * x[d];
        scores[t + 12 * m] = s;
      }
      continue;
    }
    const h = new Float64Array(model.hidden);
    for (let j = 0; j < model.hidden; j++) {
      let s = model.b1[j];
      const row = j * model.dims;
      for (let d = 0; d < model.dims; d++) s += model.W1[row + d] * x[d];
      h[j] = Math.tanh(s);
    }
    cache.push(h);
    for (let m = 0; m < 2; m++) {
      let s = 0;
      for (let j = 0; j < model.hidden; j++) s += model.w2[m][j] * h[j];
      for (let d = 0; d < model.dims; d++) s += model.lin[m][d] * x[d];
      scores[t + 12 * m] = s;
    }
  }
  return { scores, cache };
}

export function train(model, examples, { epochs = 300, lr = 0.02, l2 = 1e-3, batch = 64, seed = 7 } = {}) {
  const params = model.kind === 'linear' ? [...model.w] : [model.W1, model.b1, ...model.w2, ...model.lin];
  const m1 = params.map((p) => new Float64Array(p.length));
  const m2 = params.map((p) => new Float64Array(p.length));
  const feats = examples.map((e) => Array.from({ length: 12 }, (_, t) => rotated(e.x, t)));
  const r = rng(seed);
  let step = 0;
  const order = examples.map((_, i) => i);
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    for (let start = 0; start < order.length; start += batch) {
      const grads = params.map((p) => new Float64Array(p.length));
      const idx = order.slice(start, start + batch);
      for (const n of idx) {
        const { scores, cache } = forward(model, feats[n]);
        const max = Math.max(...scores);
        let z = 0;
        const p = Array.from(scores, (s) => { const e = Math.exp(s - max); z += e; return e; });
        for (let k = 0; k < 24; k++) {
          const g = p[k] / z - (k === examples[n].label ? 1 : 0);
          if (Math.abs(g) < 1e-7) continue;
          const t = k % 12;
          const mode = k < 12 ? 0 : 1;
          const x = feats[n][t];
          if (model.kind === 'linear') {
            const gw = grads[mode];
            for (let d = 0; d < model.dims; d++) gw[d] += g * x[d];
            continue;
          }
          const h = cache[t];
          const [gW1, gb1, gw2a, gw2b, gla, glb] = grads;
          const gw2 = mode === 0 ? gw2a : gw2b;
          const gl = mode === 0 ? gla : glb;
          for (let d = 0; d < model.dims; d++) gl[d] += g * x[d];
          for (let j = 0; j < model.hidden; j++) {
            gw2[j] += g * h[j];
            const back = g * model.w2[mode][j] * (1 - h[j] * h[j]);
            if (back === 0) continue;
            gb1[j] += back;
            const row = j * model.dims;
            for (let d = 0; d < model.dims; d++) gW1[row + d] += back * x[d];
          }
        }
      }
      step += 1;
      params.forEach((prm, pi) => {
        const g = grads[pi];
        for (let d = 0; d < prm.length; d++) {
          const gd = g[d] / idx.length + l2 * prm[d];
          m1[pi][d] = 0.9 * m1[pi][d] + 0.1 * gd;
          m2[pi][d] = 0.999 * m2[pi][d] + 0.001 * gd * gd;
          const mh = m1[pi][d] / (1 - 0.9 ** step);
          const vh = m2[pi][d] / (1 - 0.999 ** step);
          prm[d] -= (lr * mh) / (Math.sqrt(vh) + 1e-8);
        }
      });
    }
  }
  return model;
}

export const scoresOf = (model, e) => forward(model, Array.from({ length: 12 }, (_, t) => rotated(e.x, t))).scores;

export function probabilities(scores) {
  const max = Math.max(...scores);
  const p = Array.from(scores, (s) => Math.exp(s - max));
  const z = p.reduce((a, b) => a + b, 0);
  return p.map((v) => v / z);
}

// ---------- Esecuzione diretta: valutazione ----------

if (process.argv[1] && process.argv[1].endsWith('key-model.mjs')) {
  const cache = process.argv[2] || 'nnls';
  const blockNames = expandBlocks((process.argv[3] || 'treble,bass,active,majtriad,mintriad').split(','));
  const kind = process.argv[4] || 'linear';
  const hidden = Number(process.argv[5] || 16);
  const opts = { kind, hidden };
  const featureOptions = JSON.parse(process.env.FEAT || '{}');
  const attachAlt = (clips, dataset) => {
    if (!process.env.CACHE2) return clips;
    const alt = new Map(loadKeyData(dataset, process.env.CACHE2).map((c) => [c.item.id, c]));
    return clips.filter((c) => alt.has(c.item.id)).map((c) => ({ ...c, alt: alt.get(c.item.id) }));
  };
  const gtzanClips = attachAlt(loadKeyData('gtzan', cache), 'gtzan');
  const gsClips = attachAlt(loadKeyData('giantsteps_key', cache), 'giantsteps_key');
  const all = prepare([...gtzanClips, ...gsClips], blockNames, featureOptions);
  const gtzan = all.slice(0, gtzanClips.length);
  const gs = all.slice(gtzanClips.length);
  const dims = blockNames.length * 12;
  const fit = (ex) => train(createModel(dims, opts), ex);
  const evaluate = (model, ex, sink) => ex.map((e) => {
    const s = scoresOf(model, e);
    sink?.push({ p: probabilities(s), label: e.label, genre: e.genre });
    return { est: bestKey(s), ref: e.key };
  });
  const cv = (ex, folds = 5, sink) => {
    const pairs = [];
    for (let f = 0; f < folds; f++) pairs.push(...evaluate(fit(ex.filter((_, i) => i % folds !== f)), ex.filter((_, i) => i % folds === f), sink));
    return keyReport(pairs);
  };
  const fmt = (r) => ({ esatta: r.exact, mirex: r.mirex, scala: r.scale, quinta: r.fifth, relativa: r.relative, parallela: r.parallel, altro: r.other });
  const sink = [];
  const t0 = Date.now();
  const rows = {
    'CV · GTZAN': fmt(cv(gtzan)),
    'CV · GiantSteps': fmt(cv(gs)),
    'GTZAN → GiantSteps': fmt(keyReport(evaluate(fit(gtzan), gs))),
    'GiantSteps → GTZAN': fmt(keyReport(evaluate(fit(gs), gtzan))),
    'CV · entrambi': fmt(cv(all, 5, sink)),
  };
  console.log(`${kind}${kind === 'mlp' ? ` (${hidden} neuroni)` : ''} · cache ${cache} · ${process.argv[3]} (${blockNames.length} blocchi) · ${JSON.stringify(featureOptions)} · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  console.table(rows);
  const top2 = sink.filter((r) => { const o = r.p.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]); return o[0][1] === r.label || o[1][1] === r.label; }).length;
  const sure = sink.filter((r) => Math.max(...r.p) >= 0.5);
  console.log(`prime due: ${(100 * top2 / sink.length).toFixed(1)}% · sicuri (p≥0.5): ${(100 * sure.length / sink.length).toFixed(0)}% dei brani → ${(100 * sure.filter((r) => r.p.indexOf(Math.max(...r.p)) === r.label).length / sure.length).toFixed(1)}%`);
}
