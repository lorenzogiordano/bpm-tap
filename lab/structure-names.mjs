// Ruoli delle sezioni (strofa, ritornello…) su Billboard, in validazione incrociata a 5 gruppi:
// il modello (ordine delle sezioni + indizi) si allena sulle sezioni TROVATE dall'app nei brani
// di allenamento, con il ruolo della sezione annotata che le copre di più, e si prova sugli altri.
// Uso: node lab/structure-names.mjs [cv|oracle|export] [--write]
//   cv:     sezioni trovate dall'app; accuratezza per istante, ritornello, affidabilità
//   oracle: sezioni e lettere annotate (il limite superiore del modello dei ruoli)
//   export: modello su tutto Billboard → audio/structure-model.json (con --write)
import { writeFileSync } from 'node:fs';
import { loadBillboard, foldOf } from './billboard.mjs';
import { posteriorsFor, mean, pct, lengthPrior } from './structure-common.mjs';
import { analyzeBars, sectionCues, nameSections, ROLES, findDownbeats, makeBars, barFeatures, STRUCTURE_DEFAULTS } from '../audio/structure.js';

const [mode = 'cv'] = process.argv.slice(2);
const FOLDS = 5;

const songs = loadBillboard().filter((s) => s.beats.length > 64 && s.sections.length >= 2);
for (const s of songs) { s.post = posteriorsFor(s.beats, s.key).posteriors; s.fold = foldOf(s, FOLDS); }

const roleIndex = (kind) => ROLES.indexOf(kind || 'other');

// Ruolo annotato di una sezione trovata: quello della sezione annotata che la copre di più.
function refRole(song, start, end) {
  let best = null;
  let bestOverlap = 0;
  for (const sec of song.sections) {
    const o = Math.min(end, sec.end) - Math.max(start, sec.start);
    if (o > bestOverlap) { bestOverlap = o; best = sec.kind; }
  }
  return best;
}

// Sezioni (trovate o annotate) di un brano, con indizi, tempi e ruolo annotato.
function analyze(song, prior, oracle = false) {
  let bars;
  let features;
  let sections;
  if (oracle) {
    const d = findDownbeats(song.post);
    bars = makeBars(song.beats.length, d.starts, d.meter);
    if (bars.length < 8) return null;
    features = barFeatures(song.beats, song.post, bars, d.meter, song.beats.map((b) => b.loud));
    const times = bars.map((b) => song.beats[b.from].start);
    const nearest = (t) => times.reduce((best, x, k) => (Math.abs(x - t) < Math.abs(times[best] - t) ? k : best), 0);
    const starts = [];
    const letters = [];
    for (const sec of song.sections) {
      const k = nearest(sec.start);
      if (starts.length && k <= starts[starts.length - 1]) continue;
      starts.push(k);
      letters.push(sec.letter.replace(/'+$/, ''));
    }
    starts[0] = 0;
    sections = starts.map((a, i) => ({ start: a, end: i + 1 < starts.length ? starts[i + 1] : bars.length, letter: letters[i] })).filter((x) => x.end > x.start);
  } else {
    const r = analyzeBars(song.beats, song.post, song.beats.map((b) => b.loud), { lengthPrior: prior });
    if (!r) return null;
    ({ bars, features, sections } = r);
    song.within = r.within;
  }
  const cues = sectionCues(sections, features);
  const t0 = (k) => song.beats[bars[k].from].start;
  const t1 = (k) => song.beats[bars[k].to - 1].end;
  return sections.map((sec, i) => {
    const start = t0(sec.start);
    const end = t1(sec.end - 1);
    return { start, end, letter: sec.letter, cue: cues[i], ref: refRole(song, start, end) };
  });
}

// ---------- Allenamento ----------

export function train(examples, { smoothing = 1 } = {}) {
  const R = ROLES.length;
  const start = new Array(R).fill(smoothing);
  const end = new Array(R).fill(smoothing);
  const trans = Array.from({ length: R }, () => new Array(R).fill(smoothing));
  const cont = { loud: [], letterLoud: [], pos: [], len: [] };
  for (const k of Object.keys(cont)) cont[k] = Array.from({ length: R }, () => []);
  const cat = { count: Array.from({ length: R }, () => new Array(4).fill(smoothing)) };
  for (const f of ['top', 'first', 'last', 'firstOf']) cat[f] = Array.from({ length: R }, () => [smoothing, smoothing]);
  for (const song of examples) {
    song.forEach((sec, i) => {
      const r = roleIndex(sec.ref);
      if (i === 0) start[r] += 1;
      else trans[roleIndex(song[i - 1].ref)][r] += 1;
      if (i === song.length - 1) end[r] += 1;
      for (const k of Object.keys(cont)) cont[k][r].push(sec.cue[k]);
      cat.count[r][sec.cue.count - 1] += 1;
      for (const f of ['top', 'first', 'last', 'firstOf']) cat[f][r][sec.cue[f] ? 1 : 0] += 1;
    });
  }
  const logNorm = (v) => { const z = v.reduce((a, b) => a + b, 0); return v.map((x) => Math.round(Math.log(x / z) * 1000) / 1000); };
  const norm = (v) => { const z = v.reduce((a, b) => a + b, 0); return v.map((x) => Math.round((x / z) * 10000) / 10000); };
  const gaussOf = (xs) => {
    if (xs.length < 3) return [0, 1];
    const m = mean(xs);
    const sd = Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
    return [Math.round(m * 1000) / 1000, Math.round(Math.max(0.05, sd) * 1000) / 1000];
  };
  const emission = {};
  for (const k of Object.keys(cont)) emission[k] = cont[k].map(gaussOf);
  for (const k of Object.keys(cat)) emission[k] = cat[k].map(norm);
  return { roles: ROLES, start: logNorm(start), end: logNorm(end), trans: trans.map(logNorm), emission };
}

// ---------- Prova ----------

// Affidabilità dei nomi: la lettera scelta come ritornello contro la migliore alternativa
// (probabilità media di "ritornello" sulle sue sezioni).
export function chorusMargin(sections, names) {
  const ci = ROLES.indexOf('chorus');
  const byLetter = {};
  sections.forEach((s, i) => { (byLetter[s.letter] ||= []).push(names.posteriors[i][ci]); });
  const scores = Object.entries(byLetter).map(([l, ps]) => [l, mean(ps), ps.length]).sort((a, b) => b[1] - a[1]);
  return { letter: scores[0][0], margin: scores[0][1] - (scores[1] ? scores[1][1] : 0), p: scores[0][1], count: scores[0][2] };
}

function frameCompare(song, est, hop = 0.5) {
  const from = Math.max(song.sections[0].start, est[0].start);
  const to = Math.min(song.sections[song.sections.length - 1].end, est[est.length - 1].end);
  let n = 0, ok = 0, cTP = 0, cFP = 0, cFN = 0;
  let i = 0, j = 0;
  for (let t = from; t < to; t += hop) {
    while (i < song.sections.length && song.sections[i].end <= t) i += 1;
    while (j < est.length && est[j].end <= t) j += 1;
    if (i >= song.sections.length || j >= est.length || song.sections[i].start > t || est[j].start > t) continue;
    const ref = song.sections[i].kind || 'other';
    const e = est[j].role;
    n += 1;
    if (ref === e) ok += 1;
    if (e === 'chorus' && ref === 'chorus') cTP += 1;
    else if (e === 'chorus') cFP += 1;
    else if (ref === 'chorus') cFN += 1;
  }
  return { n, ok, cTP, cFP, cFN };
}

function evaluate(label, runs, filter = () => true) {
  let n = 0, ok = 0, tp = 0, fp = 0, fn = 0, shown = 0;
  for (const r of runs) {
    if (!filter(r)) continue;
    shown += 1;
    n += r.cmp.n; ok += r.cmp.ok; tp += r.cmp.cTP; fp += r.cmp.cFP; fn += r.cmp.cFN;
  }
  const p = tp / Math.max(1, tp + fp);
  const rc = tp / Math.max(1, tp + fn);
  return { [label]: { brani: `${shown}/${runs.length}`, 'ruolo giusto (istanti)': pct(ok / Math.max(1, n)), 'ritornello: precisione': pct(p), 'ritornello: richiamo': pct(rc), 'ritornello F': pct((2 * p * rc) / Math.max(1e-9, p + rc)) } };
}

if (mode === 'cv' || mode === 'oracle') {
  const oracle = mode === 'oracle';
  const runs = [];
  const baselines = [];
  for (let f = 0; f < FOLDS; f++) {
    const trainSongs = songs.filter((s) => s.fold !== f);
    const prior = lengthPrior(trainSongs);
    const trainEx = trainSongs.map((s) => analyze(s, prior, oracle)).filter(Boolean);
    const model = train(trainEx);
    for (const s of songs.filter((x) => x.fold === f)) {
      const secs = analyze(s, prior, oracle);
      if (!secs) continue;
      const names = nameSections(secs.map((x) => x.cue), model);
      const est = secs.map((x, i) => ({ ...x, role: names.roles[i] }));
      const cm = chorusMargin(secs, names);
      runs.push({ song: s, cmp: frameCompare(s, est), within: s.within ?? 1, margin: cm.margin, chorusCount: cm.count, letters: new Set(secs.map((x) => x.letter)).size, n: secs.length, seconds: est[est.length - 1].end - est[0].start });
      // Semplice: la lettera che torna più volte (a pari merito la più forte) è il ritornello, il resto strofa.
      const cues = secs.map((x) => x.cue);
      const byLetter = {};
      secs.forEach((x, i) => { (byLetter[x.letter] ||= { count: 0, loud: 0 }); byLetter[x.letter].count += 1; byLetter[x.letter].loud += cues[i].loud; });
      const top = Object.entries(byLetter).sort((a, b) => b[1].count - a[1].count || b[1].loud - a[1].loud)[0][0];
      baselines.push({ cmp: frameCompare(s, secs.map((x) => ({ ...x, role: x.letter === top ? 'chorus' : 'verse' }))) });
    }
  }
  const rows = {
    ...evaluate('regola semplice (lettera più ripetuta = ritornello)', baselines),
    ...evaluate('modello, tutti i brani', runs),
  };
  for (const th of [0.1, 0.2, 0.3, 0.4, 0.5]) Object.assign(rows, evaluate(`margine ≥ ${th}`, runs, (r) => r.margin >= th));
  Object.assign(rows, evaluate('margine ≥ 0.3, ≥ 2 lettere ripetute, ≥ 90 s', runs, (r) => r.margin >= 0.3 && r.chorusCount >= 2 && r.seconds >= 90));
  for (const [w, m] of [[0.54, 0], [0.61, 0], [0.61, 0.2], [0.61, 0.3], [0.61, 0.4], [0.7, 0.3]]) Object.assign(rows, evaluate(`somiglianza ≥ ${w}, margine ≥ ${m}`, runs, (r) => r.within >= w && r.margin >= m));
  console.table(rows);
}

if (mode === 'export') {
  const prior = lengthPrior(songs);
  const model = train(songs.map((s) => analyze(s, prior)).filter(Boolean));
  const out = { version: 1, source: 'McGill Billboard (CC0), sezioni trovate dall\'app con i ruoli annotati', lengthPrior: prior, names: model };
  console.log(JSON.stringify(out).length, 'byte');
  if (process.argv.includes('--write')) {
    writeFileSync(new URL('../audio/structure-model.json', import.meta.url), JSON.stringify(out));
    console.log('scritto audio/structure-model.json');
  }
}

export { STRUCTURE_DEFAULTS };
