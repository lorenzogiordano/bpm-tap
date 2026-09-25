// Come unire i passaggi di S-KEY quando l'ascolto supera la finestra? I brani del banco
// sono da 30 s, quindi si prova in scala: finestra da 10 s, passaggi a 6, 14, 22, 30 s,
// confrontati con S-KEY sui 30 s interi (quello su cui il modello è allenato).
// Uso: node lab/listen-proxy.mjs <raccolta> <condizione> <modello.json>
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { pathToFileURL } from 'node:url';
import { loadDataset, loadAudio, conditionAudio } from './common.mjs';
import { SKey, SKEY_RATE, DeepAverage } from '../audio/skey.js';
import { skeyBlocks, standardize, scoreKeys, softmax } from '../audio/key-features.js';

const WINDOW = 10;
const TIMES = [6, 14, 22, 30];

function hash(s) {
  let h = 2166136261;
  for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

if (!isMainThread) {
  const skey = new SKey(JSON.parse(readFileSync(new URL('../audio/skey-graph.json', import.meta.url), 'utf8')));
  const model = JSON.parse(readFileSync(workerData.model, 'utf8'));
  const predict = (p, deep) => {
    const probs = softmax(scoreKeys(standardize(skeyBlocks({ p, deep }), model.blocks, model.scales), model.weights));
    return probs.indexOf(Math.max(...probs));
  };
  const average = (runs) => Object.fromEntries(Object.keys(runs[0].deep).map((l) => [l, {
    mean: runs[0].deep[l].mean.map((row, c) => row.map((_, pc) => runs.reduce((a, r) => a + r.deep[l].mean[c][pc], 0) / runs.length)),
    sd: runs[0].deep[l].sd.map((row, c) => row.map((_, pc) => runs.reduce((a, r) => a + r.deep[l].sd[c][pc], 0) / runs.length)),
  }]));
  parentPort.on('message', (item) => {
    try {
      const audio = Float32Array.from(conditionAudio(loadAudio(item), SKEY_RATE, workerData.condition, hash(item.id)));
      const acc = new DeepAverage();
      const whole = [];
      let until = 0;
      for (const t of TIMES) {
        const end = Math.min(audio.length, Math.round(t * SKEY_RATE));
        const start = Math.max(0, end - WINDOW * SKEY_RATE);
        const covering = start === 0;
        whole.push(skey.run(audio.subarray(start, end)));
        acc.add(skey.run(audio.subarray(start, end), { from: covering ? 0 : until - start / SKEY_RATE }), covering);
        until = end / SKEY_RATE;
      }
      const last = whole[whole.length - 1];
      const full = skey.run(audio);
      parentPort.postMessage({
        id: item.id,
        pred: {
          'ultimo passaggio': predict(last.p, last.deep),
          'media uguale': predict(last.p, average(whole)),
          'frame nuovi (DeepAverage)': predict(last.p, acc.deep),
          'S-KEY su tutti i 30 s': predict(full.p, full.deep),
        },
      });
    } catch (e) {
      parentPort.postMessage({ id: item.id, error: String(e.stack || e) });
    }
  });
} else if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dataset, condition, model] = process.argv.slice(2);
  const items = loadDataset(dataset).filter((it) => it.key && it.file);
  const hits = {};
  let n = 0;
  let next = 0;
  await Promise.all(Array.from({ length: cpus().length - 1 }, () => new Promise((resolve) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { condition, model } });
    const feed = () => { if (next >= items.length) { w.terminate(); resolve(); return; } w.postMessage(items[next++]); };
    w.on('message', (m) => {
      if (m.error) console.error(m.error);
      else {
        const it = items.find((i) => i.id === m.id);
        const label = it.key.tonic + (it.key.mode === 'minor' ? 12 : 0);
        n += 1;
        for (const [k, v] of Object.entries(m.pred)) hits[k] = (hits[k] || 0) + (v === label ? 1 : 0);
      }
      feed();
    });
    feed();
  })));
  console.log(`${dataset} [${condition}] · finestra ${WINDOW} s, ${n} brani`);
  console.table(Object.fromEntries(Object.entries(hits).map(([k, v]) => [k, { esatta: Math.round((1000 * v) / n) / 10 }])));
}
