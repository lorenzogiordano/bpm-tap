// Struttura su Billboard: battute (primo battito), confini, lettere, con i battiti di Echo Nest
// e il cromagramma di Chordino passati per il modello degli accordi dell'app.
// Uso: node lab/structure-eval.mjs <downbeats|segment|lengths> [chiave=valore …]
//   downbeats: primi battiti entro un quarto di battito da un inizio di battuta annotato
//   segment:   confini (HR.5F, HR3F: entro 0,5 e 3 s, senza inizio e fine) e lettere (F a
//              coppie), gruppi di sviluppo (0–2) e di prova (3–4), anche solo sui brani che
//              l'app mostrerebbe (somiglianza tra ripetizioni ≥ soglia)
//   lengths:   lunghezze delle sezioni annotate, in battute
// Le opzioni chiave=valore passano a analyzeBars (es. refine=0). Il timbro è quello di Echo
// Nest (12 coefficienti per segmento, senza il primo), al posto di quello dell'app;
// noTimbre=true lo toglie.
import { loadBillboard, foldOf } from './billboard.mjs';
import { posteriorsFor, boundaryF, pairwiseF, mean, pct, lengthPrior, sectionBars } from './structure-common.mjs';
import { findDownbeats, changeCurve, analyzeBars, STRUCTURE_DEFAULTS } from '../audio/structure.js';

const [mode = 'segment', ...rest] = process.argv.slice(2);
const overrides = Object.fromEntries(rest.map((a) => a.split('=')).map(([k, v]) => [k, JSON.parse(v)]));

const songs = loadBillboard().filter((s) => s.beats.length > 64 && s.sections.length >= 2);
for (const s of songs) s.post = posteriorsFor(s.beats, s.key).posteriors;

// Quota dei primi battiti stimati entro un quarto di battito da un inizio di battuta annotato.
function hitRate(times, refStarts, win) {
  let h = 0;
  let j = 0;
  for (const t of times) {
    while (j + 1 < refStarts.length && refStarts[j + 1] <= t) j += 1;
    const near = Math.min(Math.abs(refStarts[j] - t), j + 1 < refStarts.length ? Math.abs(refStarts[j + 1] - t) : Infinity);
    if (near <= win) h += 1;
  }
  return times.length ? h / times.length : 0;
}

if (mode === 'downbeats') {
  const rows = {};
  const variants = {
    'fase unica (4/4)': (s) => ({ meter: 4, starts: bestPhase(s.post) }),
    'HMM 4/4': (s) => findDownbeats(s.post, { meters: [4], ...overrides }),
    'HMM 4/4 o 3/4 (margine 0,02)': (s) => findDownbeats(s.post, { meters: [4, 3], threeMargin: 0.02, ...overrides }),
    'HMM 4/4 o 3/4 (margine 0,1)': (s) => findDownbeats(s.post, { meters: [4, 3], threeMargin: 0.1, ...overrides }),
  };
  for (const [name, fn] of Object.entries(variants)) {
    const hits = [];
    let three = 0;
    let threeRight = 0;
    for (const s of songs) {
      const d = fn(s);
      if (d.meter === 3) { three += 1; if (/^(3\/4|6\/8)$/.test(s.metre)) threeRight += 1; }
      const beatLen = mean(s.beats.map((b) => b.end - b.start));
      hits.push(hitRate(d.starts.map((i) => s.beats[i].start), s.bars.map((b) => b.start), 0.25 * beatLen));
    }
    rows[name] = { brani: songs.length, 'primi battiti giusti': pct(mean(hits)), 'brani ≥ 70%': pct(hits.filter((x) => x >= 0.7).length / hits.length), '3/4 scelti (giusti)': `${three} (${threeRight})` };
  }
  console.table(rows);
}

// Fase unica per tutto il brano (per confronto): quella con più cambi sul primo battito.
function bestPhase(post) {
  const ch = changeCurve(post);
  let best = 0;
  let bestV = -Infinity;
  for (let ph = 0; ph < 4; ph++) {
    let v = 0;
    for (let i = ph; i < ch.length; i += 4) v += ch[i];
    if (v > bestV) { bestV = v; best = ph; }
  }
  const out = [];
  for (let i = best; i < post.length; i += 4) out.push(i);
  return out;
}

// Sezioni stimate in secondi, con lettera.
export function estimate(song, cfg) {
  const r = analyzeBars(song.beats, song.post, song.beats.map((b) => b.loud), { ...cfg, timbre: cfg.noTimbre ? null : song.beats.map((b) => b.timbre.slice(1)) });
  if (!r) return null;
  const t0 = (k) => song.beats[r.bars[k].from].start;
  const t1 = (k) => song.beats[r.bars[k].to - 1].end;
  let secs = r.sections;
  if (cfg.mergeSame) {
    const merged = [];
    for (const sec of secs) {
      const last = merged[merged.length - 1];
      if (last && last.letter === sec.letter && (cfg.mergeSame === 'all' || sec.novelty < cfg.mergeSame)) last.end = sec.end;
      else merged.push({ ...sec });
    }
    secs = merged;
  }
  const out = secs.map((sec) => ({ start: t0(sec.start), end: t1(sec.end - 1), label: sec.letter, bars: sec.end - sec.start }));
  out.within = r.within;
  return out;
}

export function evaluateSegmentation(list, cfg, minWithin = -Infinity) {
  const out = { hr05: [], hr3: [], pw: [], nEst: [], nRef: [] };
  for (const s of list) {
    const est = estimate(s, cfg);
    if (!est || est.within < minWithin) continue;
    const ref = s.sections.map((x) => ({ start: x.start, end: x.end, label: x.letter }));
    const rb = [...ref.map((x) => x.start), ref[ref.length - 1].end];
    const eb = [...est.map((x) => x.start), est[est.length - 1].end];
    out.hr05.push(boundaryF(rb, eb, 0.5).f);
    out.hr3.push(boundaryF(rb, eb, 3).f);
    out.pw.push(pairwiseF(ref, est).f);
    out.nEst.push(est.length);
    out.nRef.push(ref.length);
  }
  return { brani: out.hr05.length, 'HR.5F': pct(mean(out.hr05)), HR3F: pct(mean(out.hr3)), 'F coppie': pct(mean(out.pw)), 'sezioni (stimate/vere)': `${mean(out.nEst).toFixed(1)}/${mean(out.nRef).toFixed(1)}` };
}

const dev = songs.filter((s) => foldOf(s) <= 2);
const test = songs.filter((s) => foldOf(s) > 2);

if (mode === 'segment') {
  const prior = lengthPrior(dev);
  const cfg = { ...STRUCTURE_DEFAULTS, lengthPrior: prior, ...overrides };
  const rows = { sviluppo: evaluateSegmentation(dev, cfg), prova: evaluateSegmentation(test, cfg) };
  for (const w of [0.45, 0.5, 0.55]) rows[`prova, somiglianza ≥ ${w}`] = evaluateSegmentation(test, cfg, w);
  console.table(rows);
}

if (mode === 'lengths') {
  const counts = {};
  for (const s of songs) for (const n of sectionBars(s)) counts[n] = (counts[n] || 0) + 1;
  console.log(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 25));
}
