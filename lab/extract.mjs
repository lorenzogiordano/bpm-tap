// Estrae e salva le caratteristiche di ogni brano di un dataset, in parallelo.
// Uso: node lab/extract.mjs <dataset> [--variant nome] [--mic] [--seconds N] [--limit N]
// Per ogni brano salva in cache/<dataset>/<variant>[-mic]/<id>.bin i cromagrammi
// per frame (36 bin acuti + 36 bin del basso, float32) e in <id>.json i metadati.

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { cpus } from 'node:os';
import { pathToFileURL } from 'node:url';
import { CACHE, loadDataset, loadAudio, simulateMic, conditionAudio } from './common.mjs';
import { ChromaAnalyzer } from '../audio/key.js';
import { RhythmAnalyzer } from '../audio/rhythm.js';

export const VARIANTS = {
  base: {},
  white: { whitening: true },
  harm: { harmonics: 3 },
  whiteharm: { whitening: true, harmonics: 3 },
};

function extract(item, { mic, seconds, options, condition }) {
  let audio = loadAudio(item);
  const sr = 22050;
  if (seconds) audio = audio.subarray(0, Math.min(audio.length, Math.round(seconds * sr)));
  if (mic) audio = simulateMic(audio, sr, { seed: hash(item.id) });
  if (condition && condition !== 'clean') audio = conditionAudio(audio, sr, condition, hash(item.id));
  const ca = new ChromaAnalyzer(options);
  for (let i = 0; i < audio.length; i += 8192) ca.push(audio.subarray(i, i + 8192));
  const tuning = ca.tuningCents();
  const frames = ca.frames.map((record) => {
    const c = record.peaks.length ? ca.frameChroma(record, tuning) : { treble: new Float64Array(36), bass: new Float64Array(36) };
    return { c, rms: record.rms };
  });
  const bin = new Float32Array(frames.length * 72);
  frames.forEach(({ c }, i) => { bin.set(c.treble, i * 72); bin.set(c.bass, i * 72 + 36); });
  // Battiti e forza degli attacchi, per le caratteristiche metriche.
  const ra = new RhythmAnalyzer();
  for (let i = 0; i < audio.length; i += 8192) ra.push(audio.subarray(i, i + 8192));
  const tempo = ra.tempo();
  const beats = tempo ? ra.beats(tempo.bpm) : [];
  const onsetAt = (t) => ra.onset[Math.min(ra.onset.length - 1, Math.max(0, Math.round(t * ra.fps)))] || 0;
  return {
    bin,
    meta: {
      id: item.id,
      frames: frames.length,
      hop: ca.cfg.hop / ca.cfg.sampleRate,
      tuning,
      rms: frames.map((f) => Math.round(f.rms * 1e5) / 1e5),
      tonal: ca.frames.map((r) => Math.round((r.tonal || 0) * 1e4) / 1e4),
      bpm: tempo ? tempo.bpm : null,
      beats: beats.map((t) => Math.round(t * 1000) / 1000),
      beatStrength: beats.map((t) => Math.round(onsetAt(t) * 1e4) / 1e4),
    },
  };
}

function hash(s) {
  let h = 2166136261;
  for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

if (isMainThread && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const dataset = args[0];
  const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i < 0 ? fallback : args[i + 1];
  };
  const variant = opt('variant', 'base');
  if (opt('opts', null)) VARIANTS[variant] = JSON.parse(opt('opts', '{}'));
  const mic = args.includes('--mic');
  const condition = opt('condition', 'clean');
  const seconds = Number(opt('seconds', 0)) || 0;
  const limit = Number(opt('limit', 0)) || Infinity;
  const items = loadDataset(dataset).filter((it) => it.key || it.tempo).slice(0, limit);
  const dir = join(CACHE, dataset, `${variant}${mic ? '-mic' : ''}${condition !== 'clean' ? `-${condition}` : ''}${seconds ? `-${seconds}s` : ''}`);
  mkdirSync(dir, { recursive: true });
  const todo = items.filter((it) => !existsSync(join(dir, `${it.id}.json`)));
  const threads = Math.min(cpus().length - 1, todo.length);
  let next = 0;
  let done = 0;
  const started = Date.now();
  console.log(`${dataset}: ${todo.length} brani da estrarre (${items.length - todo.length} già in cache) → ${dir}`);
  await Promise.all(Array.from({ length: threads }, () => new Promise((resolve) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { variant, mic, seconds, condition, options: VARIANTS[variant] } });
    const feed = () => {
      if (next >= todo.length) { worker.terminate(); resolve(); return; }
      worker.postMessage(todo[next++]);
    };
    worker.on('message', ({ id, bin, meta, error }) => {
      if (error) console.error(`${id}: ${error}`);
      else {
        writeFileSync(join(dir, `${id}.bin`), Buffer.from(bin.buffer));
        writeFileSync(join(dir, `${id}.json`), JSON.stringify(meta));
      }
      done += 1;
      if (done % 100 === 0) console.log(`  ${done}/${todo.length} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
      feed();
    });
    feed();
  })));
  console.log(`fatto in ${((Date.now() - started) / 1000).toFixed(1)} s`);
} else if (!isMainThread) {
  parentPort.on('message', (item) => {
    try {
      const { bin, meta } = extract(item, workerData);
      parentPort.postMessage({ id: item.id, bin, meta }, [bin.buffer]);
    } catch (error) {
      parentPort.postMessage({ id: item.id, error: String(error && error.stack || error) });
    }
  });
}
