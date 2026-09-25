// Valuta la stima del tempo dall'audio sui brani annotati, in parallelo.
// Uso: node lab/tempo-eval.mjs <dataset> [--mic] [--seconds N] [--limit N] [--opts '{"priorOctaves":1.5}']
// Riporta Acc1 (entro il 4%) e Acc2 (anche ×2, ×½, ×3, ×⅓), a vari tempi di ascolto.

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { cpus } from 'node:os';
import { loadDataset, loadAudio, simulateMic, tempoReport } from './common.mjs';
import { RhythmAnalyzer } from '../audio/rhythm.js';
import { TempoEstimator } from '../tempo.js';

const CHECKPOINTS = [6, 10, 15, 20, 30];

function analyze(item, { mic, seconds, opts }) {
  let audio = loadAudio(item);
  const sr = 22050;
  if (seconds) audio = audio.subarray(0, Math.min(audio.length, Math.round(seconds * sr)));
  if (mic) audio = simulateMic(audio, sr, { seed: item.id.length * 7919 });
  const ra = new RhythmAnalyzer(opts);
  const out = {};
  let next = 0;
  for (let i = 0; i < audio.length; i += 2048) {
    ra.push(audio.subarray(i, i + 2048));
    const t = (i + 2048) / sr;
    while (next < CHECKPOINTS.length && t >= CHECKPOINTS[next]) {
      out[CHECKPOINTS[next]] = estimate(ra);
      next += 1;
    }
  }
  out.end = estimate(ra);
  return out;
}

function estimate(ra) {
  const coarse = ra.tempo();
  if (!coarse) return null;
  const beats = ra.beats(coarse.bpm);
  const est = new TempoEstimator({ priorJitter: 0.02 });
  for (const b of beats) est.addTap(b * 1000);
  const r = est.result();
  // Se la regressione dei battiti si allontana troppo dalla stima grezza, vale quella grezza.
  const fine = r && r.valid && Math.abs(r.bpm / coarse.bpm - 1) < 0.04 ? r.bpm : coarse.bpm;
  return { coarse: coarse.bpm, fine, salience: coarse.salience, beats: beats.length };
}

if (isMainThread) {
  const args = process.argv.slice(2);
  const dataset = args[0];
  const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
  const mic = args.includes('--mic');
  const seconds = Number(opt('seconds', 0)) || 0;
  const limit = Number(opt('limit', 0)) || Infinity;
  const opts = JSON.parse(opt('opts', '{}'));
  const items = loadDataset(dataset).filter((it) => it.tempo).slice(0, limit);
  const results = [];
  let next = 0;
  const started = Date.now();
  await Promise.all(Array.from({ length: Math.min(cpus().length - 1, items.length) }, () => new Promise((resolve) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { mic, seconds, opts } });
    const feed = () => {
      if (next >= items.length) { worker.terminate(); resolve(); return; }
      worker.postMessage(items[next++]);
    };
    worker.on('message', (msg) => { results.push(msg); feed(); });
    feed();
  })));
  const byId = new Map(items.map((it) => [it.id, it]));
  const rows = [];
  for (const cp of [...CHECKPOINTS, 'end']) {
    const pairsFine = results.map((r) => ({ est: r.out?.[cp]?.fine ?? null, ref: byId.get(r.id).tempo }));
    const pairsCoarse = results.map((r) => ({ est: r.out?.[cp]?.coarse ?? null, ref: byId.get(r.id).tempo }));
    rows.push({ ascolto: cp === 'end' ? 'tutto' : `${cp} s`, ...tempoReport(pairsFine), grezzo_acc1: tempoReport(pairsCoarse).acc1 });
  }
  console.log(`${dataset}${mic ? ' (microfono simulato)' : ''} — ${results.length} brani, ${((Date.now() - started) / 1000).toFixed(0)} s`);
  console.table(rows);
  const errors = results.filter((r) => r.error);
  if (errors.length) console.log('errori:', errors.slice(0, 3));
  if (args.includes('--dump')) {
    for (const r of results) console.log(r.id, byId.get(r.id).tempo, r.out?.end?.fine?.toFixed(1));
  }
} else {
  parentPort.on('message', (item) => {
    try {
      parentPort.postMessage({ id: item.id, out: analyze(item, workerData) });
    } catch (error) {
      parentPort.postMessage({ id: item.id, error: String(error && error.stack || error) });
    }
  });
}
