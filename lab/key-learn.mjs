// Modello lineare equivariante alla trasposizione, su caratteristiche più ricche
// del solo cromagramma medio. Uso: node lab/key-learn.mjs [cache] [blocchi separati da virgola]
import { loadKeyData, fold36, labelOf } from './keylab.mjs';
import { keyReport } from './common.mjs';
import { PROFILES, keyScores, bestKey } from '../audio/key.js';

const cache = process.argv[2] || 'h4';
const blockNames = (process.argv[3] || 'treble,bass,active,majtriad,mintriad').split(',');

// ---------- Caratteristiche per brano: blocchi di 12 valori indicizzati per classe di nota ----------

function clipBlocks(clip) {
  const treble = new Float64Array(12);
  const bass = new Float64Array(12);
  const active = new Float64Array(12);
  const majTriad = new Float64Array(12);
  const minTriad = new Float64Array(12);
  const bassRootMaj = new Float64Array(12);
  const bassRootMin = new Float64Array(12);
  let frames = 0;
  for (let f = 0; f < clip.n; f++) {
    const t = fold36(clip.frames, f * 72);
    const b = fold36(clip.frames, f * 72 + 36);
    const tm = Math.max(...t);
    if (!(tm > 0)) continue;
    const bm = Math.max(...b);
    frames += 1;
    for (let i = 0; i < 12; i++) {
      const x = t[i] / tm;
      treble[i] += x;
      if (x > 0.5) active[i] += 1;
      if (bm > 0) bass[i] += b[i] / bm;
    }
    for (let r = 0; r < 12; r++) {
      const root = t[r] / tm;
      const maj = Math.cbrt(root * (t[(r + 4) % 12] / tm) * (t[(r + 7) % 12] / tm));
      const min = Math.cbrt(root * (t[(r + 3) % 12] / tm) * (t[(r + 7) % 12] / tm));
      majTriad[r] += maj;
      minTriad[r] += min;
      if (bm > 0) {
        bassRootMaj[r] += maj * (b[r] / bm);
        bassRootMin[r] += min * (b[r] / bm);
      }
    }
  }
  const all = { treble, bass, active, majtriad: majTriad, mintriad: minTriad, bassmaj: bassRootMaj, bassmin: bassRootMin };
  for (const v of Object.values(all)) for (let i = 0; i < 12; i++) v[i] /= Math.max(1, frames);
  return all;
}

// Centra ogni blocco (somma zero) e lo scala con la deviazione standard globale del tipo di blocco.
function prepare(clips) {
  const raw = clips.map((c) => ({ key: c.key, label: labelOf(c.key), blocks: clipBlocks(c) }));
  const scale = {};
  for (const name of blockNames) {
    let sum = 0;
    let n = 0;
    for (const r of raw) {
      const v = r.blocks[name];
      const m = v.reduce((a, b) => a + b, 0) / 12;
      for (const x of v) { sum += (x - m) ** 2; n += 1; }
    }
    scale[name] = Math.sqrt(sum / n) || 1;
  }
  return raw.map((r) => ({
    key: r.key,
    label: r.label,
    raw: r.blocks,
    x: blockNames.map((name) => {
      const v = r.blocks[name];
      const m = v.reduce((a, b) => a + b, 0) / 12;
      return Float64Array.from(v, (x) => (x - m) / scale[name]);
    }),
  }));
}

// ---------- Modello: punteggio(t, m) = w_m · [blocchi ruotati sulla tonica t] ----------

const DIMS = () => blockNames.length * 12;

function featuresFor(x, t) {
  const out = new Float64Array(x.length * 12);
  x.forEach((v, b) => { for (let i = 0; i < 12; i++) out[b * 12 + i] = v[(i + t) % 12]; });
  return out;
}

function scores(w, x) {
  const s = new Float64Array(24);
  for (let t = 0; t < 12; t++) {
    const f = featuresFor(x, t);
    for (let m = 0; m < 2; m++) {
      let v = 0;
      for (let d = 0; d < f.length; d++) v += w[m][d] * f[d];
      s[t + 12 * m] = v;
    }
  }
  return s;
}

function train(examples, { epochs = 400, lr = 0.3, l2 = 1e-3 } = {}) {
  const dims = DIMS();
  const w = [new Float64Array(dims), new Float64Array(dims)];
  const v = [new Float64Array(dims), new Float64Array(dims)];
  const feats = examples.map((e) => Array.from({ length: 12 }, (_, t) => featuresFor(e.x, t)));
  for (let epoch = 0; epoch < epochs; epoch++) {
    const g = [new Float64Array(dims), new Float64Array(dims)];
    for (let n = 0; n < examples.length; n++) {
      const s = new Float64Array(24);
      for (let k = 0; k < 24; k++) {
        const f = feats[n][k % 12];
        const wm = w[k < 12 ? 0 : 1];
        let acc = 0;
        for (let d = 0; d < dims; d++) acc += wm[d] * f[d];
        s[k] = acc;
      }
      const max = Math.max(...s);
      let z = 0;
      for (let k = 0; k < 24; k++) { s[k] = Math.exp(s[k] - max); z += s[k]; }
      for (let k = 0; k < 24; k++) {
        const p = s[k] / z - (k === examples[n].label ? 1 : 0);
        if (Math.abs(p) < 1e-6) continue;
        const f = feats[n][k % 12];
        const gm = g[k < 12 ? 0 : 1];
        for (let d = 0; d < dims; d++) gm[d] += p * f[d];
      }
    }
    for (let m = 0; m < 2; m++) {
      for (let d = 0; d < dims; d++) {
        const grad = g[m][d] / examples.length + l2 * w[m][d];
        v[m][d] = 0.9 * v[m][d] + grad;
        w[m][d] -= lr * v[m][d];
      }
    }
  }
  return w;
}

const predict = (w, e) => bestKey(scores(w, e.x));

function crossValidate(examples, folds = 5, collect = null) {
  const pairs = [];
  for (let f = 0; f < folds; f++) {
    const w = train(examples.filter((_, i) => i % folds !== f));
    for (const e of examples.filter((_, i) => i % folds === f)) {
      pairs.push({ est: predict(w, e), ref: e.key });
      if (collect) collect.push({ scores: scores(w, e.x), label: e.label, key: e.key });
    }
  }
  return keyReport(pairs);
}

// Prime due, e precisione quando il modello è sicuro (probabilità della prima scelta).
function confidenceReport(collected) {
  const rows = collected.map(({ scores: s, label }) => {
    const max = Math.max(...s);
    const p = Array.from(s, (v) => Math.exp(v - max));
    const z = p.reduce((a, b) => a + b, 0);
    const order = p.map((v, i) => [v / z, i]).sort((a, b) => b[0] - a[0]);
    return { p1: order[0][0], top1: order[0][1] === label, top2: order[0][1] === label || order[1][1] === label };
  });
  const out = { 'prime due': Math.round((1000 * rows.filter((r) => r.top2).length) / rows.length) / 10 };
  for (const t of [0.3, 0.4, 0.5, 0.6, 0.7]) {
    const sel = rows.filter((r) => r.p1 >= t);
    out[`p≥${t}`] = `${Math.round((100 * sel.length) / rows.length)}% dei brani → ${sel.length ? Math.round((1000 * sel.filter((r) => r.top1).length) / sel.length) / 10 : '-'}%`;
  }
  return out;
}

const test = (w, examples) => keyReport(examples.map((e) => ({ est: predict(w, e), ref: e.key })));
const fmt = (r) => ({ esatta: r.exact, mirex: r.mirex, scala: r.scale, quinta: r.fifth, relativa: r.relative, parallela: r.parallel, altro: r.other });

const gtzanClips = loadKeyData('gtzan', cache);
const gsClips = loadKeyData('giantsteps_key', cache);
const both = [...gtzanClips, ...gsClips];
const prepared = prepare(both);
const gtzan = prepared.slice(0, gtzanClips.length);
const gs = prepared.slice(gtzanClips.length);

const baseline = (clips) => keyReport(clips.map((c) => ({ est: bestKey(keyScores(c.raw.treble, PROFILES.bgate)), ref: c.key })));
const collected = [];
const rows = {
  'bgate (riferimento) · GTZAN': fmt(baseline(gtzan)),
  'bgate (riferimento) · GiantSteps': fmt(baseline(gs)),
  'appreso, CV 5 gruppi · GTZAN': fmt(crossValidate(gtzan)),
  'appreso, CV 5 gruppi · GiantSteps': fmt(crossValidate(gs)),
  'appreso su GTZAN → GiantSteps': fmt(test(train(gtzan), gs)),
  'appreso su GiantSteps → GTZAN': fmt(test(train(gs), gtzan)),
  'appreso su entrambi, CV 5 gruppi': fmt(crossValidate(prepared, 5, collected)),
};
console.log(`cache ${cache}, blocchi: ${blockNames.join(', ')}`);
console.table(rows);
console.log('Affidabilità (entrambi, CV):', confidenceReport(collected));
