// Tonalità come la vede l'app mentre ascolta: S-KEY sugli ultimi 30 s ogni 8 s (primo
// passaggio a 6 s), passaggi uniti in vari modi, modello e codice dell'app.
// Uso:
//   node lab/listen-sim.mjs run <raccolta> <condizione> <secondi>   → cache/../listen/<raccolta>-<condizione>.json
//   node lab/listen-sim.mjs eval <raccolta> <condizione> <modello.json>
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cpus } from 'node:os';
import { pathToFileURL } from 'node:url';
import { CACHE, loadDataset, loadAudio, conditionAudio } from './common.mjs';
import { SKey, SKEY_RATE } from '../audio/skey.js';
import { skeyBlocks, standardize, scoreKeys, softmax } from '../audio/key-features.js';

const DIR = join(CACHE, '..', 'listen');
const WINDOW = 30;
const LAYERS = ['b4', 'b5', 'b6'];

function hash(s) {
  let h = 2166136261;
  for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

// Istanti dei passaggi di S-KEY nell'app (listen-worker.js): 6 s, poi ogni 8 s.
export const schedule = (seconds) => { const out = []; for (let t = 6; t <= seconds; t += 8) out.push(t); return out; };

const slim = (res) => ({ p: res.p.map((v) => Math.round(v * 1e6) / 1e6), deep: Object.fromEntries(LAYERS.map((l) => [l, { mean: res.deep[l].mean.map((r) => r.map((v) => Math.round(v * 1e4) / 1e4)) }])) });

if (!isMainThread) {
  const skey = new SKey(JSON.parse(readFileSync(new URL('../audio/skey-graph.json', import.meta.url), 'utf8')));
  const { condition, seconds, prefixes } = workerData;
  parentPort.on('message', (item) => {
    try {
      const audio = Float32Array.from(conditionAudio(loadAudio(item), SKEY_RATE, condition, hash(item.id)));
      const total = audio.length / SKEY_RATE;
      const runs = schedule(Math.min(seconds, total)).map((t) => {
        const end = Math.round(t * SKEY_RATE);
        return { t, len: Math.min(t, WINDOW), ...slim(skey.run(audio.subarray(Math.max(0, end - WINDOW * SKEY_RATE), end))) };
      });
      // Riferimento: S-KEY su tutto l'audio ascoltato fino a quel momento.
      const full = prefixes.filter((t) => t > WINDOW && t <= total).map((t) => ({ t, ...slim(skey.run(audio.subarray(0, Math.round(t * SKEY_RATE)))) }));
      parentPort.postMessage({ id: item.id, runs, full });
    } catch (e) {
      parentPort.postMessage({ id: item.id, error: String(e.message || e) });
    }
  });
} else if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, dataset, condition, arg] = process.argv.slice(2);
  const file = join(DIR, `${dataset}-${condition}.json`);
  if (mode === 'run') {
    mkdirSync(DIR, { recursive: true });
    const seconds = Number(arg);
    const prefixes = schedule(seconds).filter((t) => t > WINDOW);
    const items = loadDataset(dataset).filter((it) => it.key && it.file);
    const out = {};
    let next = 0;
    let done = 0;
    const started = Date.now();
    await Promise.all(Array.from({ length: cpus().length - 1 }, () => new Promise((resolve) => {
      const w = new Worker(new URL(import.meta.url), { workerData: { condition, seconds, prefixes } });
      const feed = () => { if (next >= items.length) { w.terminate(); resolve(); return; } w.postMessage(items[next++]); };
      w.on('message', (m) => {
        if (!m.error) out[m.id] = { key: items.find((i) => i.id === m.id).key, runs: m.runs, full: m.full };
        done += 1;
        if (done % 100 === 0) console.log(`  ${done}/${items.length} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
        feed();
      });
      feed();
    })));
    writeFileSync(file, JSON.stringify(out));
    console.log(`${dataset} [${condition}]: ${Object.keys(out).length} brani → ${file}`);
  } else if (mode === 'eval') {
    const model = JSON.parse(readFileSync(arg, 'utf8'));
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const label = (k) => k.tonic + (k.mode === 'minor' ? 12 : 0);
    const predict = (combined) => {
      // Si salvano solo le medie (le deviazioni non servono al modello).
      const deep = Object.fromEntries(Object.entries(combined.deep).map(([l, d]) => [l, { mean: d.mean, sd: [] }]));
      const probs = softmax(scoreKeys(standardize(skeyBlocks({ p: combined.p, deep }), model.blocks, model.scales), model.weights));
      return probs.indexOf(Math.max(...probs));
    };
    // Unione dei passaggi: media (pesata) dei profili interni.
    const combine = (runs, weight) => {
      const deep = {};
      const wsum = runs.reduce((a, r) => a + weight(r), 0);
      for (const l of LAYERS) {
        deep[l] = { mean: runs[0].deep[l].mean.map((row, c) => row.map((_, pc) => runs.reduce((a, r) => a + weight(r) * r.deep[l].mean[c][pc], 0) / wsum)) };
      }
      return { p: runs[runs.length - 1].p, deep };
    };
    const methods = {
      'ultimo passaggio': (runs) => runs[runs.length - 1],
      'media uguale (app)': (runs) => combine(runs, () => 1),
      'media pesata per durata': (runs) => combine(runs, (r) => r.len),
    };
    const checkpoints = [...new Set(Object.values(data).flatMap((c) => c.runs.map((r) => r.t)))].sort((a, b) => a - b);
    const rows = {};
    for (const t of checkpoints) {
      const clips = Object.values(data).filter((c) => c.runs.some((r) => r.t === t));
      const row = { n: clips.length };
      for (const [name, fn] of Object.entries(methods)) {
        const ok = clips.filter((c) => predict(fn(c.runs.filter((r) => r.t <= t))) === label(c.key)).length;
        row[name] = Math.round((1000 * ok) / clips.length) / 10;
      }
      const withFull = clips.filter((c) => c.full.some((f) => f.t === t));
      if (withFull.length) {
        const ok = withFull.filter((c) => predict(c.full.find((f) => f.t === t)) === label(c.key)).length;
        row['tutto l\'ascoltato'] = Math.round((1000 * ok) / withFull.length) / 10;
      }
      rows[`${t} s`] = row;
    }
    console.log(`${dataset} [${condition}] · modello: ${model.trainedOn}`);
    console.table(rows);
  }
}
