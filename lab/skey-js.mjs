// Probabilità di S-KEY (interprete JS) per ogni brano di un dataset in una condizione d'ascolto.
// Uso: node lab/skey-js.mjs <dataset> <condizione>   → cache/../skey/<dataset>-<condizione>.json
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cpus } from 'node:os';
import { pathToFileURL } from 'node:url';
import { CACHE, loadDataset, loadAudio, conditionAudio } from './common.mjs';
import { OnnxLite } from '../audio/onnx-lite.js';

const SKEY = join(CACHE, '..', 'skey');
const NAMES = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };

function hash(s) {
  let h = 2166136261;
  for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

if (!isMainThread) {
  const graph = JSON.parse(readFileSync(join(SKEY, 'skey-graph.json'), 'utf8'));
  const labels = JSON.parse(readFileSync(join(SKEY, 'manifest.json'), 'utf8')).labels;
  const order = labels.map((l) => { const [n, m] = l.split(' '); return NAMES[n] + (m === 'Major' ? 0 : 12); });
  const net = new OnnxLite(graph);
  // Strati interni: uscite dei blocchi ConvNeXt 3–6 ([1, canali, 84 bin CQT, tempo]).
  const LAYERS = [3, 4, 5, 6];
  net.extraOutputs = LAYERS.map((i) => `/chromanet/convnext_blocks.${i}/Add_1_output_0`);
  // Per ogni canale: profilo sulle 12 note (ottave mediate) medio nel tempo e sua deviazione.
  // Il bin 0 della CQT è La (27.5 Hz): classe di nota (Do = 0) = (bin + 9) % 12.
  const pool = (t) => {
    const [, C, H, T] = t.dims;
    const mean = [];
    const sd = [];
    for (let c = 0; c < C; c++) {
      const m = new Array(12).fill(0);
      const q = new Array(12).fill(0);
      for (let pc = 0; pc < 12; pc++) {
        const series = new Array(T).fill(0);
        for (let o = 0; o < H / 12; o++) {
          const bin = o * 12 + ((pc - 9 + 12) % 12);
          for (let x = 0; x < T; x++) series[x] += t.data[((c * H) + bin) * T + x] / (H / 12);
        }
        const mu = series.reduce((a, b) => a + b, 0) / T;
        m[pc] = Math.round(mu * 1e4) / 1e4;
        q[pc] = Math.round(Math.sqrt(series.reduce((a, b) => a + (b - mu) ** 2, 0) / T) * 1e4) / 1e4;
      }
      mean.push(m);
      sd.push(q);
    }
    return { mean, sd };
  };
  parentPort.on('message', (item) => {
    try {
      let audio = loadAudio(item);
      audio = Float32Array.from(conditionAudio(audio, 22050, workerData.condition, hash(item.id)));
      let peak = 0;
      for (const v of audio) peak = Math.max(peak, Math.abs(v));
      if (!peak) throw new Error('silenzio');
      const res = net.run({ audio: { dims: [1, audio.length], data: audio, dtype: 'float32' } });
      const s = res.scores.data;
      const p = new Array(24).fill(0);
      order.forEach((k, i) => { p[k] = s[i]; });
      const deep = {};
      LAYERS.forEach((l, i) => { deep[`b${l}`] = pool(res[net.extraOutputs[i]]); });
      parentPort.postMessage({ id: item.id, p, deep });
    } catch (e) {
      parentPort.postMessage({ id: item.id, error: String(e.message || e) });
    }
  });
} else if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dataset, condition = 'clean'] = process.argv.slice(2);
  const items = loadDataset(dataset).filter((it) => it.key && it.file);
  const out = {};
  const deepOut = {};
  let next = 0;
  let done = 0;
  const started = Date.now();
  await Promise.all(Array.from({ length: cpus().length - 1 }, () => new Promise((resolve) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { condition } });
    const feed = () => { if (next >= items.length) { w.terminate(); resolve(); return; } w.postMessage(items[next++]); };
    w.on('message', (m) => {
      if (!m.error) { out[m.id] = m.p; deepOut[m.id] = m.deep; }
      done += 1;
      if (done % 200 === 0) console.log(`  ${done}/${items.length} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
      feed();
    });
    feed();
  })));
  const file = join(SKEY, `${dataset}${condition === 'clean' ? '' : `-${condition}`}.json`);
  writeFileSync(file, JSON.stringify(out));
  writeFileSync(file.replace(/\.json$/, '.deep.json'), JSON.stringify(deepOut));
  const ok = items.filter((it) => out[it.id] && out[it.id].indexOf(Math.max(...out[it.id])) === it.key.tonic + (it.key.mode === 'minor' ? 12 : 0)).length;
  console.log(`${dataset} [${condition}]: S-KEY esatta ${(100 * ok / items.length).toFixed(1)}% · ${((Date.now() - started) / 1000).toFixed(0)} s → ${file}`);
}
