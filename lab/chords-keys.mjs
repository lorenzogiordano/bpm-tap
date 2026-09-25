// Tonalità stimata dall'app (S-KEY + modello della tonalità) per i brani delle prove sugli
// accordi, come nell'ascolto: finestre di 30 s unite con DeepAverage.
// Uso: node lab/chords-keys.mjs <raccolta> <clean|mic>  → cache/chords/<raccolta>-<condizione>.keys.json
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { cpus } from 'node:os';
import { pathToFileURL } from 'node:url';
import { CACHE, DATA, loadDataset, loadAudio, conditionAudio } from './common.mjs';
import { SKey, SKEY_RATE, DeepAverage } from '../audio/skey.js';
import { skeyBlocks, standardize, scoreKeys, softmax } from '../audio/key-features.js';

function hash(s) {
  let h = 2166136261;
  for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

if (!isMainThread) {
  const skey = new SKey(JSON.parse(readFileSync(new URL('../audio/skey-graph.json', import.meta.url), 'utf8')));
  const model = JSON.parse(readFileSync(new URL('../audio/key-model.json', import.meta.url), 'utf8'));
  parentPort.on('message', (item) => {
    try {
      const audio = Float32Array.from(conditionAudio(loadAudio(item), SKEY_RATE, workerData.condition, hash(item.id)));
      const avg = new DeepAverage();
      const step = 30 * SKEY_RATE;
      let run;
      for (let start = 0; start < audio.length; start += step) {
        const part = audio.subarray(start, Math.min(audio.length, start + step));
        if (part.length < 3 * SKEY_RATE && start > 0) break;
        run = skey.run(part);
        avg.add(run, start === 0);
      }
      const probs = softmax(scoreKeys(standardize(skeyBlocks({ p: run.p, deep: avg.deep }), model.blocks, model.scales), model.weights));
      const best = probs.indexOf(Math.max(...probs));
      parentPort.postMessage({ id: item.id, key: { tonic: best % 12, mode: best < 12 ? 'major' : 'minor' }, p: Math.round(probs[best] * 1000) / 1000 });
    } catch (e) {
      parentPort.postMessage({ id: item.id, error: String(e.message || e) });
    }
  });
} else if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dataset, condition] = process.argv.slice(2);
  const cached = JSON.parse(readFileSync(join(CACHE, 'chords', `${dataset}-${condition}.json`), 'utf8'));
  const wanted = new Set(cached.map((c) => c.id));
  const items = loadDataset(dataset).filter((it) => wanted.has(it.id) && existsSync(join(DATA, dataset, it.file)));
  const out = {};
  let next = 0;
  await Promise.all(Array.from({ length: cpus().length - 1 }, () => new Promise((resolve) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { condition } });
    const feed = () => { if (next >= items.length) { w.terminate(); resolve(); return; } w.postMessage(items[next++]); };
    w.on('message', (m) => { if (!m.error) out[m.id] = m; feed(); });
    feed();
  })));
  writeFileSync(join(CACHE, 'chords', `${dataset}-${condition}.keys.json`), JSON.stringify(out));
  const exact = items.filter((it) => out[it.id] && out[it.id].key.tonic === it.key.tonic && out[it.id].key.mode === it.key.mode).length;
  console.log(`${dataset} [${condition}]: tonalità esatta ${(100 * exact / items.length).toFixed(1)}% su ${items.length}`);
}
