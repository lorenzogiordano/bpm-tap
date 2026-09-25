// Accordi: per ogni brano, i battiti trovati dall'app, il cromagramma per battito e
// l'accordo annotato a metà di ogni battito. In cache/chords/<raccolta>-<condizione>.json.
// Uso: node lab/chords-extract.mjs <raccolta> <clean|mic> [massimo brani]
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cpus } from 'node:os';
import { pathToFileURL } from 'node:url';
import { CACHE, DATA, loadDataset, loadAudio, conditionAudio } from './common.mjs';
import { RhythmAnalyzer } from '../audio/rhythm.js';
import { ChromaAnalyzer } from '../audio/key.js';
import { tempoCandidates, chooseTempo } from '../audio/tempo-choice.js';
import { beatChroma, NO_CHORD } from '../audio/chords.js';

export const CHORD_CHROMA = { method: 'nnls', hop: 2048 };
const round = (v) => Math.round(v * 1000) / 1000;

function hash(s) {
  let h = 2166136261;
  for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

// Accordo annotato all'istante t: etichetta 0–23, 24 = nessuno, -1 = escluso o fuori.
function labelAt(chords, t) {
  for (const [a, b, lab] of chords) if (t >= a && t < b) return lab;
  return -1;
}

function extract(item, condition) {
  const audio = Float32Array.from(conditionAudio(loadAudio(item), 22050, condition, hash(item.id)));
  const rhythm = new RhythmAnalyzer({ beatSeconds: 1e6 });
  const chroma = new ChromaAnalyzer({ sampleRate: 22050, ...CHORD_CHROMA });
  for (let i = 0; i < audio.length; i += 8192) {
    const part = audio.subarray(i, i + 8192);
    rhythm.push(part);
    chroma.push(part);
  }
  const choice = chooseTempo(tempoCandidates(rhythm));
  const beats = choice ? rhythm.beats(choice.bpm) : [];
  const tuning = chroma.tuningCents();
  const frames = chroma.frames.map((record) => (record.log ? chroma.frameChroma(record, tuning) : { treble: new Float64Array(36), bass: new Float64Array(36) }));
  const centre = (chroma.cfg.frameSize / 2) / 22050;
  const times = frames.map((_, k) => (k * chroma.cfg.hop) / 22050 + centre);
  const per = beatChroma(frames, times, beats);
  return {
    id: item.id,
    key: item.key,
    bpm: choice ? round(choice.bpm) : null,
    beats: per.map((b) => ({
      start: round(b.start),
      end: round(b.end),
      treble: Array.from(b.treble, round),
      bass: Array.from(b.bass, round),
      energy: round(b.energy),
      ref: labelAt(item.chords, (b.start + b.end) / 2),
    })),
    // Quota di tempo di ogni accordo annotato (per le prove "a livello di brano").
    shares: (() => {
      const s = {};
      for (const [a, b, lab] of item.chords) if (lab >= 0 && lab !== NO_CHORD) s[lab] = (s[lab] || 0) + (b - a);
      const total = item.chords.reduce((acc, [a, b]) => acc + (b - a), 0);
      for (const k of Object.keys(s)) s[k] = round(s[k] / total);
      return s;
    })(),
  };
}

if (!isMainThread) {
  parentPort.on('message', (item) => {
    try { parentPort.postMessage(extract(item, workerData.condition)); }
    catch (e) { parentPort.postMessage({ id: item.id, error: String(e.stack || e) }); }
  });
} else if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dataset, condition = 'clean', limit] = process.argv.slice(2);
  const items = loadDataset(dataset).filter((it) => existsSync(join(DATA, dataset, it.file))).slice(0, limit ? Number(limit) : undefined);
  const dir = join(CACHE, 'chords');
  mkdirSync(dir, { recursive: true });
  const out = [];
  let next = 0;
  const started = Date.now();
  await Promise.all(Array.from({ length: cpus().length - 1 }, () => new Promise((resolve) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { condition } });
    const feed = () => { if (next >= items.length) { w.terminate(); resolve(); return; } w.postMessage(items[next++]); };
    w.on('message', (m) => {
      if (m.error) console.error(m.id, m.error.split('\n')[0]);
      else out.push(m);
      if (out.length % 50 === 0) console.log(`  ${out.length}/${items.length} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
      feed();
    });
    feed();
  })));
  const file = join(dir, `${dataset}-${condition}.json`);
  writeFileSync(file, JSON.stringify(out));
  console.log(`${dataset} [${condition}]: ${out.length} brani, ${out.reduce((a, c) => a + c.beats.length, 0)} battiti → ${file} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
}
