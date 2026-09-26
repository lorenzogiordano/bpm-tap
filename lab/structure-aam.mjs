// Struttura e giri dall'audio, dall'inizio alla fine, sulle canzoni AAM: lo stesso percorso
// dell'app (battiti, cromagramma NNLS, tonalità stimata da S-KEY, accordi, struttura) su audio
// pulito o ripreso in una stanza simulata. Le sezioni annotate sono i segni A/B/C dei file
// *_segments.arff (le ripetizioni consecutive dello stesso segno sono una sezione sola).
// Uso: node lab/structure-aam.mjs <clean|mic> [massimo brani]
//   → confini (HR.5F, HR3F), lettere (F a coppie), giri e accordi per battito.
// Serve la tonalità stimata in cache (node lab/chords-keys.mjs aam <condizione>).
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cpus } from 'node:os';
import { pathToFileURL } from 'node:url';
import { CACHE, DATA, loadDataset, loadAudio, conditionAudio } from './common.mjs';
import { boundaryF, pairwiseF, mean, pct } from './structure-common.mjs';
import { RhythmAnalyzer } from '../audio/rhythm.js';
import { ChromaAnalyzer } from '../audio/key.js';
import { tempoCandidates, chooseTempo } from '../audio/tempo-choice.js';
import { beatChroma, chordScores, transitionMatrix, decode, keyBonus, NO_CHORD } from '../audio/chords.js';
import { songStructure, beatLoudness } from '../audio/structure.js';
import { PERIODS } from '../audio/progressions.js';

const RATE = 22050;
const HOP = 2048;
const load = (name) => JSON.parse(readFileSync(new URL(`../audio/${name}`, import.meta.url), 'utf8'));

function hash(s) {
  let h = 2166136261;
  for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

// Sezioni annotate: segni consecutivi uguali uniti; per ognuna la lunghezza del segmento in battute.
function refSections(id) {
  const rows = readFileSync(join(DATA, 'aam', 'ann', `${id}_segments.arff`), 'utf8').split('\n').filter((l) => /^\d/.test(l)).map((l) => {
    const p = l.split(',');
    return { start: Number(p[0]), mark: p[1].replace(/'/g, '') };
  });
  const out = [];
  rows.forEach((r, i) => {
    if (r.mark === 'end') return;
    const end = rows[i + 1].start;
    const last = out[out.length - 1];
    if (last && last.label === r.mark) { last.end = end; last.segments += 1; }
    else out.push({ start: r.start, end, label: r.mark, segments: 1 });
  });
  return out;
}

// Accordi annotati per battito (beatinfo): per mezza battuta (primo e terzo battito).
function refUnits(id) {
  const rows = readFileSync(join(DATA, 'aam', 'ann', `${id}_beatinfo.arff`), 'utf8').split('\n').filter((l) => /^\d/.test(l)).map((l) => {
    const p = l.split(',');
    return { t: Number(p[0]), quarter: Number(p[2]) };
  });
  return rows;
}

function labelAt(chords, t) {
  for (const [a, b, lab] of chords) if (t >= a && t < b) return lab;
  return -1;
}

// Periodo annotato di una sezione: il più corto (in battute) con il 90% delle mezze battute uguali.
function refPeriod(item, sec, beatRows) {
  const units = [];
  for (const r of beatRows) {
    if (r.t < sec.start - 0.01 || r.t >= sec.end - 0.01) continue;
    if (r.quarter === 1 || r.quarter === 3) units.push(labelAt(item.chords, r.t + 0.01));
  }
  for (const p of [...PERIODS, 12, 16]) {
    const lag = 2 * p;
    let same = 0;
    let n = 0;
    for (let k = lag; k < units.length; k++) { if (units[k] < 0 || units[k - lag] < 0) continue; n += 1; if (units[k] === units[k - lag]) same += 1; }
    if (n >= lag && same / n >= 0.9) return p;
  }
  return null;
}

function analyze(item, condition, keys) {
  const audio = Float32Array.from(conditionAudio(loadAudio(item), RATE, condition, hash(item.id)));
  const rhythm = new RhythmAnalyzer({ sampleRate: RATE, beatSeconds: 1e6 });
  const chroma = new ChromaAnalyzer({ sampleRate: RATE, method: 'nnls', hop: HOP });
  for (let i = 0; i < audio.length; i += 8192) {
    const part = audio.subarray(i, i + 8192);
    rhythm.push(part);
    chroma.push(part);
  }
  const choice = chooseTempo(tempoCandidates(rhythm));
  const beatTimes = choice ? rhythm.beats(choice.bpm) : [];
  const tuning = chroma.tuningCents();
  const frames = chroma.frames.map((r) => (r.log ? chroma.frameChroma(r, tuning) : { treble: new Float64Array(36), bass: new Float64Array(36) }));
  const centre = chroma.cfg.frameSize / 2 / RATE;
  const times = frames.map((_, k) => (k * HOP) / RATE + centre);
  const beats = beatChroma(frames, times, beatTimes);
  const loudness = beatLoudness(chroma.frames.map((r) => r.rms), times, beats);
  const model = load('chord-model.json');
  const key = keys[item.id]?.key || null;
  const scores = chordScores(beats, model.emission, keyBonus(key, model.keyPrior, model.keyWeight)).map((row) => row.map((x) => x / model.temperature));
  const { path, posteriors } = decode(scores, transitionMatrix(model.transitions));
  const r3 = (x) => Math.round(x * 1000) / 1000;
  // In cache ciò che serve alla struttura: battiti con cromagramma, probabilità, volume.
  return {
    id: item.id,
    key,
    beats: beats.map((b) => ({ start: r3(b.start), end: r3(b.end), treble: Array.from(b.treble, r3), bass: Array.from(b.bass, r3), energy: r3(b.energy) })),
    posteriors: posteriors.map((p) => Array.from(p, (x) => Math.round(x * 1e4) / 1e4)),
    loudness: loudness.map((x) => Math.round(x * 100) / 100),
    path,
  };
}

if (!isMainThread) {
  const keys = JSON.parse(readFileSync(join(CACHE, 'chords', `aam-${workerData.condition}.keys.json`), 'utf8'));
  parentPort.on('message', (item) => {
    try { parentPort.postMessage(analyze(item, workerData.condition, keys)); }
    catch (e) { parentPort.postMessage({ id: item.id, error: String(e.stack || e) }); }
  });
} else if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [condition = 'clean', limit] = process.argv.slice(2).filter((a) => !a.includes('=') && !a.startsWith('--'));
  const items = loadDataset('aam').filter((it) => existsSync(join(DATA, 'aam', it.file))).slice(0, limit ? Number(limit) : undefined);
  const byId = Object.fromEntries(items.map((it) => [it.id, it]));
  const cacheFile = join(CACHE, 'structure', `aam-${condition}.json`);
  let results = [];
  if (existsSync(cacheFile) && !process.argv.includes('--fresh')) results = JSON.parse(readFileSync(cacheFile, 'utf8')).filter((r) => byId[r.id]);
  const done = new Set(results.map((r) => r.id));
  const todo = items.filter((it) => !done.has(it.id));
  const started = Date.now();
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, cpus().length - 2) }, () => new Promise((resolve) => {
    if (!todo.length) { resolve(); return; }
    const w = new Worker(new URL(import.meta.url), { workerData: { condition } });
    const feed = () => { if (next >= todo.length) { w.terminate(); resolve(); return; } w.postMessage(todo[next++]); };
    w.on('message', (m) => {
      if (m.error) console.error(m.id, m.error.split('\n').slice(0, 3).join(' | '));
      else results.push(m);
      if (results.length % 50 === 0) console.log(`  ${results.length}/${items.length} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
      feed();
    });
    feed();
  })));
  mkdirSync(join(CACHE, 'structure'), { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(results));

  // ---------- Metriche ----------
  const models = { structure: load('structure-model.json'), progressions: load('progression-model.json') };
  const options = Object.fromEntries(process.argv.slice(2).filter((a) => a.includes('=')).map((a) => a.split('=')).map(([k, v]) => [k, JSON.parse(v)]));
  const shownOnly = process.argv.includes('--shown');
  const m = { hr05: [], hr3: [], pw: [], nEst: [], nRef: [], shown: 0, named: 0, beats: 0, raw: 0, tiled: 0, loopRef: 0, loopEst: 0, loopBoth: 0, periodSame: 0, refSecs: 0, wholeLoop: 0 };
  for (const r of results) {
    const item = byId[r.id];
    const ref = refSections(r.id);
    const beatRows = refUnits(r.id);
    const st = songStructure({ beats: r.beats, posteriors: r.posteriors, loudness: r.loudness, key: r.key }, models, options);
    if (!st) continue;
    if (st.shown) m.shown += 1;
    else if (shownOnly) continue;
    if (st.sections.some((s) => s.role)) m.named += 1;
    if (st.whole) m.wholeLoop += 1;
    // Sezioni stimate con lettere uguali consecutive unite (i confini veri sono i cambi di segno).
    const est = [];
    for (const s of st.sections) {
      const label = s.letter.replace(/′/g, ''); // le varianti (A′) sono la stessa lettera
      const last = est[est.length - 1];
      if (last && last.label === label) last.end = s.end;
      else est.push({ start: s.start, end: s.end, label });
    }
    const rb = [...ref.map((x) => x.start), ref[ref.length - 1].end];
    const eb = [...est.map((x) => x.start), est[est.length - 1].end];
    m.hr05.push(boundaryF(rb, eb, 0.5).f);
    m.hr3.push(boundaryF(rb, eb, 3).f);
    m.pw.push(pairwiseF(ref, est).f);
    m.nEst.push(est.length);
    m.nRef.push(ref.length);
    // Giri: per ogni sezione annotata, la sezione stimata che la copre di più.
    for (const sec of ref) {
      let best = null;
      let bestO = 0;
      for (const s of st.sections) { const o = Math.min(s.end, sec.end) - Math.max(s.start, sec.start); if (o > bestO) { bestO = o; best = s; } }
      if (!best || bestO < 0.5 * (sec.end - sec.start)) continue;
      const prog = st.progressions[best.letter];
      const rp = refPeriod(item, sec, beatRows);
      m.refSecs += 1;
      if (rp && PERIODS.includes(rp)) m.loopRef += 1;
      if (prog.loop) m.loopEst += 1;
      if (rp && PERIODS.includes(rp) && prog.loop) { m.loopBoth += 1; if (rp === prog.period) m.periodSame += 1; }
    }
    // Accordi per battito: HMM grezzo contro il giro della sezione ripetuto sul tempo.
    const upb = st.unitsPerBar;
    for (const s of st.sections) {
      const prog = st.progressions[s.letter];
      const unitChords = prog.chords.flatMap((c) => Array(c.units).fill(c.chord));
      const lag = unitChords.length;
      const beatsIn = r.beats.map((b, i) => [[b.start, b.end], i]).filter(([b]) => b[0] >= s.start - 0.01 && b[1] <= s.end + 0.01);
      const perUnit = beatsIn.length / (s.bars * upb);
      beatsIn.forEach(([b, i], k) => {
        const ref = labelAt(item.chords, (b[0] + b[1]) / 2);
        if (ref < 0 || ref === NO_CHORD) return;
        const u = Math.floor(k / perUnit);
        m.beats += 1;
        if (r.path[i] === ref) m.raw += 1;
        const pos = u + (s.offset ?? 0); // ripetizione non allineata: come la vedrebbe chi legge, dall'inizio
        const inside = pos >= 0 && (prog.loop || pos < lag);
        const predicted = inside ? unitChords[prog.loop ? pos % lag : pos] : r.path[i];
        if (predicted === ref) m.tiled += 1;
      });
    }
  }
  const n = results.length;
  console.table({
    [`AAM ${condition}${shownOnly ? ' (solo mostrati)' : ''}`]: {
      brani: shownOnly ? m.hr05.length : n,
      'HR.5F': pct(mean(m.hr05)),
      HR3F: pct(mean(m.hr3)),
      'F coppie': pct(mean(m.pw)),
      'sezioni (stimate/vere)': `${mean(m.nEst).toFixed(1)}/${mean(m.nRef).toFixed(1)}`,
      'struttura mostrata': pct(m.shown / n),
      'con i nomi': pct(m.named / n),
      'giro su tutto il brano': pct(m.wholeLoop / n),
    },
  });
  console.table({
    [`AAM ${condition}: giri`]: {
      'sezioni annotate': m.refSecs,
      'con giro (≤ 8 battute)': pct(m.loopRef / m.refSecs),
      'giro trovato': pct(m.loopEst / m.refSecs),
      'giro trovato: precisione': pct(m.loopBoth / Math.max(1, m.loopEst)),
      'giro annotato: richiamo': pct(m.loopBoth / Math.max(1, m.loopRef)),
      'stesso periodo': pct(m.periodSame / Math.max(1, m.loopBoth)),
      'battiti: HMM': pct(m.raw / m.beats),
      'battiti: giro della sezione': pct(m.tiled / m.beats),
    },
  });
}
