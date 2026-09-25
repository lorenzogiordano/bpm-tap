// Accordi: allenamento del modello (pesi di emissione e transizioni) e prove.
// Uso: node lab/chords-learn.mjs <prova> [--write]
//   prove: gs-cv (GuitarSet, lasciando fuori un chitarrista alla volta),
//          aam-cv (AAM, 5 gruppi di brani), aam2gs / gs2aam (una raccolta per allenare, l'altra per provare),
//          final (tutto → audio/chord-model.json con --write)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE } from './common.mjs';
import { chordFeatures, chordScores, transitionMatrix, decode, chordShares, keyBonus, NO_CHORD, CHORD_STATES } from '../audio/chords.js';

// KEY_SOURCE=est: la tonalità stimata dall'app (lab/chords-keys.mjs) invece di quella annotata.
const load = (ds, cond) => {
  const file = join(CACHE, 'chords', `${ds}-${cond}.json`);
  if (!existsSync(file)) return [];
  const keysFile = file.replace(/\.json$/, '.keys.json');
  const keys = process.env.KEY_SOURCE === 'est' && existsSync(keysFile) ? JSON.parse(readFileSync(keysFile, 'utf8')) : {};
  return JSON.parse(readFileSync(file, 'utf8')).map((c) => ({ ...c, dataset: ds, condition: cond, estimatedKey: keys[c.id]?.key }));
};

// ---------- Allenamento ----------

function examples(clips) {
  const out = [];
  for (const c of clips) {
    c.beats.forEach((b, i) => {
      if (b.ref < 0) return;
      const f = chordFeatures(c.beats, i);
      out.push({ x: f.blocks, none: f.none, y: b.ref });
    });
  }
  return out;
}

export function trainEmission(clips, { epochs = 60, lr = 0.05, l2 = 1e-4, batch = 256 } = {}) {
  const data = examples(clips);
  const dims = data[0].x.length * 12;
  const params = { maj: new Float64Array(dims), min: new Float64Array(dims), bias: new Float64Array(2), none: new Float64Array(4) };
  const flat = [params.maj, params.min, params.bias, params.none];
  const m = flat.map((p) => new Float64Array(p.length));
  const v = flat.map((p) => new Float64Array(p.length));
  let step = 0;
  const random = (() => { let s = 7; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); })();
  for (let e = 0; e < epochs; e++) {
    const order = data.map((_, i) => i).sort(() => random() - 0.5);
    for (let start = 0; start < order.length; start += batch) {
      const g = flat.map((p) => new Float64Array(p.length));
      const idx = order.slice(start, start + batch);
      for (const i of idx) {
        const { x, none, y } = data[i];
        const s = new Float64Array(CHORD_STATES);
        for (let r = 0; r < 12; r++) {
          for (const [q, w, off] of [[0, params.maj, 0], [1, params.min, 12]]) {
            let val = params.bias[q];
            for (let b = 0; b < x.length; b++) for (let p = 0; p < 12; p++) val += w[b * 12 + p] * x[b][(p + r) % 12];
            s[r + off] = val;
          }
        }
        s[NO_CHORD] = none.reduce((a, f, k) => a + f * params.none[k], 0);
        const mx = Math.max(...s);
        const ex = s.map((val) => Math.exp(val - mx));
        const z = ex.reduce((a, b) => a + b, 0);
        for (let st = 0; st < CHORD_STATES; st++) {
          const d = ex[st] / z - (st === y ? 1 : 0);
          if (Math.abs(d) < 1e-6) continue;
          if (st === NO_CHORD) { none.forEach((f, k) => { g[3][k] += d * f; }); continue; }
          const q = st < 12 ? 0 : 1;
          const r = st % 12;
          const gw = g[q];
          for (let b = 0; b < x.length; b++) for (let p = 0; p < 12; p++) gw[b * 12 + p] += d * x[b][(p + r) % 12];
          g[2][q] += d;
        }
      }
      step += 1;
      flat.forEach((p, k) => {
        for (let j = 0; j < p.length; j++) {
          const gj = g[k][j] / idx.length + l2 * p[j];
          m[k][j] = 0.9 * m[k][j] + 0.1 * gj;
          v[k][j] = 0.999 * v[k][j] + 0.001 * gj * gj;
          p[j] -= (lr * m[k][j] / (1 - 0.9 ** step)) / (Math.sqrt(v[k][j] / (1 - 0.999 ** step)) + 1e-8);
        }
      });
    }
  }
  return { weights: { maj: Array.from(params.maj), min: Array.from(params.min) }, bias: { maj: params.bias[0], min: params.bias[1] }, none: Array.from(params.none) };
}

// Transizioni tra battiti consecutivi, contate sulle etichette annotate (invarianti per trasposizione).
export function trainTransitions(clips, smoothing = 1) {
  let same = 0;
  let total = 0;
  let toNone = 0;
  let changes = 0;
  const change = [0, 1].map(() => [0, 1].map(() => new Float64Array(12).fill(smoothing)));
  for (const c of clips) {
    for (let i = 1; i < c.beats.length; i++) {
      const a = c.beats[i - 1].ref;
      const b = c.beats[i].ref;
      if (a < 0 || b < 0) continue;
      total += 1;
      if (a === b) { same += 1; continue; }
      changes += 1;
      if (b === NO_CHORD) { toNone += 1; continue; }
      if (a === NO_CHORD) continue;
      change[a < 12 ? 0 : 1][b < 12 ? 0 : 1][(b - a + 24) % 12] += 1;
    }
  }
  // Nella stessa qualità l'intervallo 0 è "restare": non è un cambio.
  change[0][0][0] = 0;
  change[1][1][0] = 0;
  for (const qa of [0, 1]) {
    const z = change[qa][0].reduce((a, x) => a + x, 0) + change[qa][1].reduce((a, x) => a + x, 0);
    for (const qb of [0, 1]) change[qa][qb] = Array.from(change[qa][qb], (x) => x / z);
  }
  return { stay: same / total, toNone: toNone / Math.max(1, changes), change };
}

// log P(qualità, distanza dalla tonica | modo), contata sui battiti annotati.
export function trainKeyPrior(clips, smoothing = 1) {
  const counts = [0, 1].map(() => [0, 1].map(() => new Float64Array(12).fill(smoothing)));
  for (const c of clips) {
    if (!c.key) continue;
    const mode = c.key.mode === 'minor' ? 1 : 0;
    for (const b of c.beats) {
      if (b.ref < 0 || b.ref === NO_CHORD) continue;
      counts[mode][b.ref < 12 ? 0 : 1][(b.ref - c.key.tonic + 12) % 12] += 1;
    }
  }
  return counts.map((m) => {
    const z = m[0].reduce((a, x) => a + x, 0) + m[1].reduce((a, x) => a + x, 0);
    // Centrato: conta la preferenza relativa tra gli accordi, non il livello.
    const logs = m.map((row) => Array.from(row, (x) => Math.log(x / z)));
    const mean = (logs[0].reduce((a, x) => a + x, 0) + logs[1].reduce((a, x) => a + x, 0)) / 24;
    return logs.map((row) => row.map((x) => x - mean));
  });
}

// ---------- Prove ----------

const KEY_WEIGHT = Number(process.env.KEY_WEIGHT ?? 0);
const TEMPERATURE = Number(process.env.TEMPERATURE ?? 1);
// Più coppie (modello, brani mai visti da quel modello): conteggi sommati.
function evaluateMany(pairs, options) {
  return evaluate(null, null, { ...options, pairs });
}

function evaluate(model, clips, { temperature = TEMPERATURE, thresholds = [0.1, 0.15, 0.2], pairs = [[model, clips]] } = {}) {
  let beatOk = 0;
  let beatOkRaw = 0;
  let beatN = 0;
  const song = thresholds.map(() => ({ shown: 0, right: 0, refMain: 0, found: 0, songs: 0, songsAllRight: 0 }));
  for (const [model, clips] of pairs) for (const c of clips) {
    if (c.beats.length < 4) continue;
    const T = transitionMatrix(model.transitions);
    const bonus = keyBonus(c.estimatedKey || c.key, model.keyPrior, model.keyWeight ?? KEY_WEIGHT);
    const scores = chordScores(c.beats, model.emission, bonus).map((s) => s.map((x) => x / temperature));
    const { path, posteriors } = decode(scores, T);
    c.beats.forEach((b, i) => {
      if (b.ref < 0) return;
      beatN += 1;
      if (path[i] === b.ref) beatOk += 1;
      const s = scores[i];
      if (s.indexOf(Math.max(...s)) === b.ref) beatOkRaw += 1;
    });
    const shares = chordShares(c.beats, posteriors);
    thresholds.forEach((th, k) => {
      const shown = shares.filter((x) => x.share >= th).map((x) => x.chord);
      const inSong = (ch) => (c.shares[ch] || 0) >= 0.05;
      const right = shown.filter(inSong).length;
      const main = Object.entries(c.shares).filter(([, sh]) => sh >= 0.1).map(([ch]) => Number(ch));
      song[k].shown += shown.length;
      song[k].right += right;
      song[k].refMain += main.length;
      song[k].found += main.filter((ch) => shown.includes(ch)).length;
      song[k].songs += 1;
      if (shown.length && right === shown.length) song[k].songsAllRight += 1;
    });
  }
  const pct = (a, b) => Math.round((1000 * a) / (b || 1)) / 10;
  const row = { 'battiti: esatti (HMM)': pct(beatOk, beatN), 'senza HMM': pct(beatOkRaw, beatN) };
  thresholds.forEach((th, k) => {
    const s = song[k];
    row[`≥${Math.round(th * 100)}%: giusti`] = pct(s.right, s.shown);
    row[`≥${Math.round(th * 100)}%: trovati`] = pct(s.found, s.refMain);
    row[`≥${Math.round(th * 100)}%: brani tutti giusti`] = pct(s.songsAllRight, s.songs);
  });
  return row;
}

function train(clips) {
  return { emission: trainEmission(clips), transitions: trainTransitions(clips), keyPrior: trainKeyPrior(clips) };
}

const [mode = 'gs-cv'] = process.argv.slice(2);
const conds = ['clean', 'mic'];
const gs = conds.flatMap((c) => load('guitarset', c));
const aam = conds.flatMap((c) => load('aam', c));
const rows = {};
const report = (name, model, clips) => {
  for (const c of conds) rows[`${name} · ${c}`] = evaluate(model, clips.filter((x) => x.condition === c));
};

if (mode === 'gs-cv') {
  // Lascia fuori un giro di accordi (es. "BN1", suonato da 6 chitarristi in 2 tonalità) alla
  // volta: il modello non ha mai sentito quella successione, da nessuno.
  const progression = (c) => c.id.split('_')[1].split('-')[0];
  const groups = [...new Set(gs.map(progression))];
  for (const c of conds) {
    const pairs = [];
    for (const g of groups) {
      const model = train(gs.filter((x) => progression(x) !== g));
      pairs.push([model, gs.filter((x) => progression(x) === g && x.condition === c)]);
    }
    rows[`GuitarSet (CV per giro di accordi) · ${c}`] = evaluateMany(pairs);
  }
} else if (mode === 'aam-cv') {
  const folds = 5;
  const ids = [...new Set(aam.map((c) => c.id))];
  const foldOf = (id) => ids.indexOf(id) % folds;
  const models = Array.from({ length: folds }, (_, f) => train(aam.filter((x) => foldOf(x.id) !== f)));
  for (const c of conds) rows[`AAM (CV) · ${c}`] = evaluateMany(models.map((m, f) => [m, aam.filter((x) => foldOf(x.id) === f && x.condition === c)]));
} else if (mode === 'mixed-cv') {
  // 5 gruppi: canzoni AAM e giri di GuitarSet lasciati fuori insieme; allenamento su tutto il
  // resto delle due raccolte. Si provano più valori di temperatura (forza dell'HMM rispetto ai
  // punteggi) e di peso della tonalità, con gli stessi modelli.
  const folds = 5;
  const aamIds = [...new Set(aam.map((c) => c.id))];
  const progs = [...new Set(gs.map((c) => c.id.split('_')[1].split('-')[0]))];
  const foldOf = (c) => (c.dataset === 'aam' ? aamIds.indexOf(c.id) : progs.indexOf(c.id.split('_')[1].split('-')[0])) % folds;
  const all = [...aam, ...gs];
  const models = Array.from({ length: folds }, (_, f) => train(all.filter((c) => foldOf(c) !== f)));
  const temps = (process.env.TEMPS || '0.5,1,2').split(',').map(Number);
  const weights = (process.env.WEIGHTS || '0,0.25,0.5').split(',').map(Number);
  for (const temperature of temps) {
    for (const w of weights) {
      for (const ds of ['guitarset', 'aam']) {
        for (const c of conds) {
          const pairs = models.map((m, f) => [{ ...m, keyWeight: w }, all.filter((x) => foldOf(x) === f && x.dataset === ds && x.condition === c)]);
          rows[`τ ${temperature} · tonalità ${w} · ${ds} · ${c}`] = evaluateMany(pairs, { temperature, thresholds: [0.1, 0.15] });
        }
      }
    }
  }
} else if (mode === 'aam2gs') {
  report('AAM → GuitarSet', train(aam), gs);
} else if (mode === 'gs2aam') {
  report('GuitarSet → AAM', train(gs), aam);
} else if (mode === 'final') {
  const model = train([...aam, ...gs]);
  if (process.argv.includes('--write')) {
    const round = (x) => Math.round(x * 1e5) / 1e5;
    const out = {
      version: 1,
      trainedOn: `AAM (${new Set(aam.map((c) => c.id)).size} brani) + GuitarSet (${new Set(gs.map((c) => c.id)).size}), pulito e microfono`,
      emission: { weights: { maj: model.emission.weights.maj.map(round), min: model.emission.weights.min.map(round) }, bias: { maj: round(model.emission.bias.maj), min: round(model.emission.bias.min) }, none: model.emission.none.map(round) },
      transitions: { stay: round(model.transitions.stay), toNone: round(model.transitions.toNone), change: model.transitions.change.map((a) => a.map((b) => b.map(round))) },
      keyPrior: model.keyPrior.map((m) => m.map((row) => row.map(round))),
      keyWeight: KEY_WEIGHT,
      temperature: TEMPERATURE,
    };
    writeFileSync(new URL('../audio/chord-model.json', import.meta.url), JSON.stringify(out));
    console.log('scritto audio/chord-model.json');
  }
  report('tutto (sui dati di allenamento)', model, [...aam, ...gs]);
}
console.table(rows);
