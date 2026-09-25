// Impara a scegliere il tempo tra i candidati (softmax lineare sui candidati di ogni brano).
// Uso: node lab/tempo-learn.mjs [--mic]
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { cpus } from 'node:os';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CACHE, loadDataset, loadAudio, simulateMic, conditionAudio, tempoReport } from './common.mjs';
import { RhythmAnalyzer } from '../audio/rhythm.js';
import { tempoCandidates, chooseTempo } from '../audio/tempo-choice.js';

function hash(s) {
  let h = 2166136261;
  for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

function candidatesFor(item, mic, condition) {
  let audio = loadAudio(item);
  if (mic) audio = simulateMic(audio, 22050, { seed: item.id.length * 131 + 7 });
  if (condition && condition !== 'clean') audio = Float32Array.from(conditionAudio(audio, 22050, condition, hash(item.id)));
  const ra = new RhythmAnalyzer();
  for (let i = 0; i < audio.length; i += 8192) ra.push(audio.subarray(i, i + 8192));
  const prior = ra.tempo();
  return { candidates: tempoCandidates(ra), prior: prior ? prior.bpm : null };
}

// Un candidato è giusto se sta entro il 4% dal tempo di riferimento.
export const hit = (bpm, ref) => Math.abs(bpm / ref - 1) <= 0.04;
export function train(set, { epochs = 400, lr = 0.05, l2 = 1e-3 } = {}) {
  const dims = set[0].candidates[0].features.length;
  // Standardizzazione delle caratteristiche sui candidati del set di allenamento.
  const all = set.flatMap((c) => c.candidates.map((x) => x.features));
  const mu = Array.from({ length: dims }, (_, d) => all.reduce((a, f) => a + f[d], 0) / all.length);
  const sd = Array.from({ length: dims }, (_, d) => Math.sqrt(all.reduce((a, f) => a + (f[d] - mu[d]) ** 2, 0) / all.length) || 1);
  const norm = (f) => f.map((v, d) => (v - mu[d]) / sd[d]);
  const usable = set.filter((c) => c.candidates.some((x) => hit(x.bpm, c.tempo)));
  const w = new Float64Array(dims);
  const m = new Float64Array(dims);
  const v = new Float64Array(dims);
  for (let e = 1; e <= epochs; e++) {
    const g = new Float64Array(dims);
    for (const c of usable) {
      const fs = c.candidates.map((x) => norm(x.features));
      const s = fs.map((f) => f.reduce((a, x, d) => a + x * w[d], 0));
      const mx = Math.max(...s);
      const p = s.map((x) => Math.exp(x - mx));
      const z = p.reduce((a, b) => a + b, 0);
      const target = c.candidates.map((x) => (hit(x.bpm, c.tempo) ? 1 : 0));
      const tz = target.reduce((a, b) => a + b, 0);
      fs.forEach((f, i) => { const gi = p[i] / z - target[i] / tz; for (let d = 0; d < dims; d++) g[d] += gi * f[d]; });
    }
    for (let d = 0; d < dims; d++) {
      const gd = g[d] / usable.length + l2 * w[d];
      m[d] = 0.9 * m[d] + 0.1 * gd;
      v[d] = 0.999 * v[d] + 0.001 * gd * gd;
      w[d] -= (lr * m[d] / (1 - 0.9 ** e)) / (Math.sqrt(v[d] / (1 - 0.999 ** e)) + 1e-8);
    }
  }
  // Pesi sulle caratteristiche grezze (la standardizzazione viene incorporata).
  const raw = Array.from(w, (x, d) => x / sd[d]);
  return { raw, bias: -raw.reduce((a, x, d) => a + x * mu[d], 0) };
}

const isMain = isMainThread && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isMainThread) {
  parentPort.on('message', (item) => {
    try { parentPort.postMessage({ id: item.id, ...candidatesFor(item, workerData.mic, workerData.condition) }); }
    catch (e) { parentPort.postMessage({ id: item.id, error: String(e.stack || e) }); }
  });
} else if (isMain) {
  const mic = process.argv.includes('--mic');
  const ci = process.argv.indexOf('--condition');
  const condition = ci > 0 ? process.argv[ci + 1] : 'clean';
  const dir = join(CACHE, 'tempo');
  mkdirSync(dir, { recursive: true });
  const data = {};
  for (const ds of ['gtzan', 'giantsteps_tempo']) {
    const file = join(dir, `${ds}${mic ? '-mic' : ''}${condition !== 'clean' ? `-${condition}` : ''}.json`);
    if (existsSync(file)) { data[ds] = JSON.parse(readFileSync(file, 'utf8')); continue; }
    const items = loadDataset(ds).filter((it) => it.tempo && it.file);
    const out = {};
    let next = 0;
    await Promise.all(Array.from({ length: cpus().length - 1 }, () => new Promise((resolve) => {
      const w = new Worker(new URL(import.meta.url), { workerData: { mic, condition } });
      const feed = () => { if (next >= items.length) { w.terminate(); resolve(); return; } w.postMessage(items[next++]); };
      w.on('message', (m) => { if (!m.error) out[m.id] = { ...m, tempo: items.find((i) => i.id === m.id).tempo }; feed(); });
      feed();
    })));
    writeFileSync(file, JSON.stringify(out));
    data[ds] = out;
  }

  const examples = (ds) => Object.values(data[ds]).filter((c) => c.candidates && c.candidates.length);
  const pick = (model, c) => chooseTempo(c.candidates, model ? model.raw : null)?.bpm ?? null;
  const report = (model, set) => tempoReport(set.map((c) => ({ est: pick(model, c), ref: c.tempo })));
  const cv = (set, folds = 5) => {
    const pairs = [];
    for (let f = 0; f < folds; f++) {
      const model = train(set.filter((_, i) => i % folds !== f));
      for (const c of set.filter((_, i) => i % folds === f)) pairs.push({ est: pick(model, c), ref: c.tempo });
    }
    return tempoReport(pairs);
  };
  const gt = examples('gtzan');
  const gs = examples('giantsteps_tempo');
  const priorPick = (set) => tempoReport(set.map((c) => ({ est: c.prior, ref: c.tempo })));
  const reach = (set) => Math.round((1000 * set.filter((c) => c.candidates.some((x) => hit(x.bpm, c.tempo))).length) / set.length) / 10;
  console.log(`candidati: il tempo giusto è tra i candidati nel ${reach(gt)}% (GTZAN) e ${reach(gs)}% (GiantSteps)`);
  console.table({
    'attuale (preferenza 120) · GTZAN': priorPick(gt),
    'attuale · GiantSteps': priorPick(gs),
    'appreso CV · GTZAN': cv(gt),
    'appreso CV · GiantSteps': cv(gs),
    'appreso su GTZAN → GiantSteps': report(train(gt), gs),
    'appreso su GiantSteps → GTZAN': report(train(gs), gt),
    'appreso CV · entrambi': cv([...gt, ...gs]),
  });
  const final = train([...gt, ...gs]);
  writeFileSync(join(dir, `weights${mic ? '-mic' : ''}${condition !== 'clean' ? `-${condition}` : ''}.json`), JSON.stringify(final.raw.map((x) => Math.round(x * 1e6) / 1e6)));
  // Modello allenato su audio pulito, provato sulla condizione scelta (se diversa).
  if (condition !== 'clean' && existsSync(join(dir, 'gtzan.json'))) {
    const cleanData = { gtzan: JSON.parse(readFileSync(join(dir, 'gtzan.json'), 'utf8')), giantsteps_tempo: JSON.parse(readFileSync(join(dir, 'giantsteps_tempo.json'), 'utf8')) };
    const cleanSets = [...Object.values(cleanData.gtzan), ...Object.values(cleanData.giantsteps_tempo)].filter((c) => c.candidates && c.candidates.length);
    const cleanModel = train(cleanSets);
    console.table({
      [`allenato su pulito → prova ${condition} · GTZAN`]: report(cleanModel, gt),
      [`allenato su pulito → prova ${condition} · GiantSteps`]: report(cleanModel, gs),
      [`nessun modello (preferenza 120) → ${condition} · GTZAN`]: priorPick(gt),
    });
  }
}
