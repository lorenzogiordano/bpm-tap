// Giri di accordi: dalle probabilità degli accordi per battito (chords.js) alla successione
// che si ripete in una sezione, con i gradi (I, IV, V…) e il confronto con i giri più comuni.
// Numeri e prove in lab/progressions-eval.mjs e lab/progressions-dictionary.mjs.
//
// 1. Unità: mezze battute in 4/4 (due accordi per battuta sono frequenti), battute intere in
//    3/4. Per ogni unità la media dei log delle probabilità dei suoi battiti (una media
//    geometrica: un battito incerto pesa poco se gli altri sono chiari), rinormalizzata.
// 2. Periodo del giro: per p battute, S(p) = media di Σc P_u(c)·P_(u−p)(c), la probabilità che
//    due unità a distanza p abbiano lo stesso accordo. Si sceglie il periodo più corto vicino
//    al migliore; sotto 0,75 il giro non è fisso (nelle sezioni di Billboard un giro che si
//    ripete uguale c'è circa una volta su tre: dirlo non è un errore).
// 3. Piegatura: le ripetizioni della sezione si allineano (i confini trovati sbagliano spesso di
//    una battuta) e le unità nella stessa posizione si mediano. È un riassunto: su Billboard e
//    su AAM descrive le singole ripetizioni un po' peggio degli accordi battito per battito
//    (1–4 punti), non meglio come in Mauch et al. 2009, che mediavano il cromagramma.
// 4. Confronto con i giri noti (dizionario qui sotto): il nome si dà solo se il giro trovato è
//    esattamente un giro noto, netto e con accordi sicuri (su Billboard giusto 9 volte su 10).
//    Correggere verso un giro noto invece peggiora: quando un giro noto differisce in una sola
//    posizione, l'accordo trovato è quello giusto 81 volte su 100 e il giro noto 4; con gli stessi
//    accordi in un altro ordine, l'ordine trovato è giusto 134 volte su 174 e quello del giro
//    noto mai. Per questo il giro trovato non si cambia mai: al più, con la regola stretta
//    della ricerca (una posizione incerta, il giro noto secondo e vincente nel confronto con
//    i passaggi di Billboard e RS 200), si propone come "forse" da verificare a orecchio.

import { NO_CHORD } from './chords.js';

const FLOOR = 1e-4;
export const PERIODS = [1, 2, 3, 4, 6, 8];

export function unitsPerBar(meter) {
  return meter % 2 === 0 ? 2 : 1;
}

// Unità di ogni battuta. bars: [{ from, to }] indici dei battiti (to escluso).
// Restituisce [{ bar, from, to, p: Float64Array(25) }].
export function barUnits(posteriors, bars, meter) {
  const upb = unitsPerBar(meter);
  const out = [];
  bars.forEach((bar, k) => {
    const n = bar.to - bar.from;
    for (let h = 0; h < upb; h++) {
      const from = bar.from + Math.round((h * n) / upb);
      const to = bar.from + Math.round(((h + 1) * n) / upb);
      out.push({ bar: k, from, to, p: meanLog(posteriors, from, to) });
    }
  });
  return out;
}

// Media dei log (media geometrica) delle probabilità dei battiti [from, to), normalizzata.
export function meanLog(posteriors, from, to) {
  const S = posteriors[0]?.length || 25;
  const acc = new Float64Array(S);
  const n = Math.max(1, to - from);
  for (let i = from; i < to; i++) for (let s = 0; s < S; s++) acc[s] += Math.log(Math.max(FLOOR, posteriors[i][s])) / n;
  return softmax(acc);
}

export function softmax(logs) {
  let m = -Infinity;
  for (const v of logs) if (v > m) m = v;
  const out = new Float64Array(logs.length);
  let z = 0;
  for (let i = 0; i < logs.length; i++) { out[i] = Math.exp(logs[i] - m); z += out[i]; }
  for (let i = 0; i < out.length; i++) out[i] /= z;
  return out;
}

// Probabilità che due unità abbiano lo stesso accordo (senza "nessun accordo").
export function agreement(a, b) {
  let s = 0;
  for (let c = 0; c < NO_CHORD; c++) s += a[c] * b[c];
  return s;
}

// S(lag) su più ripetizioni della stessa sezione (ognuna una lista di distribuzioni): solo
// coppie dentro la stessa ripetizione. Anche il livello "a caso" (coppie qualsiasi della
// sezione), per sapere quanto S supera quello che darebbero accordi mescolati.
export function periodScore(instances, lag) {
  let sum = 0;
  let pairs = 0;
  for (const units of instances) {
    for (let u = lag; u < units.length; u++) { sum += agreement(units[u], units[u - lag]); pairs += 1; }
  }
  return { score: pairs ? sum / pairs : 0, pairs };
}

export function chanceAgreement(instances) {
  const mean = new Float64Array(25);
  let n = 0;
  for (const units of instances) for (const q of units) { for (let c = 0; c < 25; c++) mean[c] += q[c]; n += 1; }
  if (!n) return 0;
  // Σc (media di P(c))²: la probabilità di coincidere prendendo due unità a caso.
  let s = 0;
  for (let c = 0; c < NO_CHORD; c++) s += (mean[c] / n) ** 2;
  return s;
}

// Periodo del giro (in battute) nelle ripetizioni di una sezione. Si prova ogni periodo con
// almeno un giro intero da confrontare; vince il più corto entro `slack` dal migliore.
export function findLoop(instances, meter, { periods = PERIODS, slack = 0.05 } = {}) {
  const upb = unitsPerBar(meter);
  const scores = {};
  let best = null;
  for (const p of periods) {
    const lag = p * upb;
    const r = periodScore(instances, lag);
    if (r.pairs < lag) continue;
    scores[p] = r.score;
    if (!best || r.score > best.score) best = { period: p, score: r.score };
  }
  if (!best) return { period: null, score: 0, scores, chance: chanceAgreement(instances) };
  const period = Number(Object.keys(scores).map(Number).sort((a, b) => a - b).find((p) => scores[p] >= best.score - slack));
  return { period, score: scores[period], scores, chance: chanceAgreement(instances) };
}

// Piega le ripetizioni: per ogni posizione 0…lag−1 la media delle distribuzioni. offsets:
// per ogni ripetizione lo spostamento (in unità) della sua prima unità nel giro; cyclic: le
// posizioni girano (giro) o si fermano a lag (sezione intera).
export function fold(instances, lag, offsets = null, cyclic = true) {
  const out = Array.from({ length: lag }, () => new Float64Array(25));
  const count = new Float64Array(lag);
  instances.forEach((units, i) => {
    const o = offsets ? offsets[i] : 0;
    units.forEach((q, u) => {
      let k = u + o;
      if (cyclic) k = ((k % lag) + lag) % lag;
      else if (k < 0 || k >= lag) return;
      for (let c = 0; c < 25; c++) out[k][c] += q[c];
      count[k] += 1;
    });
  });
  return out.map((v, k) => (count[k] ? v.map((x) => x / count[k]) : v));
}

// Allineamento delle ripetizioni: i confini trovati possono sbagliare di una battuta o due, e
// piegare ripetizioni sfasate mescola accordi diversi. Ogni ripetizione si sposta (entro
// ±maxShift unità, o in qualsiasi rotazione se è un giro) dove va più d'accordo con la più
// lunga; quelle che non le somigliano (accordo medio < minAgree) restano fuori.
export function alignInstances(instances, lag, cyclic, { maxShift = 4, minAgree = 0.5 } = {}) {
  let refIdx = 0;
  instances.forEach((u, i) => { if (u.length > instances[refIdx].length) refIdx = i; });
  const ref = fold([instances[refIdx]], lag, null, cyclic);
  const offsets = instances.map(() => null);
  offsets[refIdx] = 0;
  instances.forEach((u, i) => {
    if (i === refIdx) return;
    const shifts = cyclic ? Array.from({ length: lag }, (_, o) => o) : Array.from({ length: 2 * maxShift + 1 }, (_, o) => o - maxShift);
    let best = { o: 0, agree: -1 };
    for (const o of shifts) {
      let sum = 0;
      let n = 0;
      u.forEach((q, k) => {
        let j = k + o;
        if (cyclic) j = ((j % lag) + lag) % lag;
        else if (j < 0 || j >= lag) return;
        sum += agreement(q, ref[j]);
        n += 1;
      });
      if (n >= Math.min(u.length, lag) / 2 && sum / n > best.agree) best = { o, agree: sum / n };
    }
    if (best.agree >= minAgree) offsets[i] = best.o;
  });
  return offsets;
}

// Accordo più probabile, senza "nessun accordo" (se domina il silenzio vale comunque l'accordo migliore).
export function argmaxChord(q) {
  let best = 0;
  for (let c = 1; c < NO_CHORD; c++) if (q[c] > q[best]) best = c;
  return best;
}

// Unità consecutive con lo stesso accordo diventano un accordo solo, con la sua durata.
export function slots(folded) {
  const out = [];
  folded.forEach((q) => {
    const chord = argmaxChord(q);
    const last = out[out.length - 1];
    if (last && last.chord === chord) { last.units += 1; last.p += q[chord]; }
    else out.push({ chord, units: 1, p: q[chord] });
  });
  for (const s of out) s.p /= s.units;
  return out;
}

// ---------- Gradi ----------

const MAJOR_NAMES = ['I', '♭II', 'II', '♭III', 'III', 'IV', '♯IV', 'V', '♭VI', 'VI', '♭VII', 'VII'];
// In minore i gradi si contano sulla scala minore naturale: ♭III, ♭VI e ♭VII diventano III, VI e VII.
const MINOR_NAMES = ['I', '♭II', 'II', 'III', '♯III', 'IV', '♯IV', 'V', 'VI', '♯VI', 'VII', '♯VII'];

// Grado dell'accordo (0–23) nella tonalità { tonic, mode }: "IV", "vi", "♭VII".
export function romanNumeral(chord, key) {
  if (!key || chord < 0 || chord >= NO_CHORD) return '';
  const rel = ((chord % 12) - key.tonic + 12) % 12;
  const name = (key.mode === 'minor' ? MINOR_NAMES : MAJOR_NAMES)[rel];
  return chord < 12 ? name : name.toLowerCase();
}

const DEGREES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

// "♭VII" in un modo → { rel, minor }. Minuscolo = accordo minore.
export function parseRoman(text, mode = 'major') {
  const m = /^([♭♯b#]*)([ivIV]+)$/.exec(text);
  if (!m) throw new Error(`grado non valido: ${text}`);
  const shift = [...m[1]].reduce((a, ch) => a + (ch === '♭' || ch === 'b' ? -1 : 1), 0);
  const degree = NUMERALS.indexOf(m[2].toUpperCase());
  if (degree < 0) throw new Error(`grado non valido: ${text}`);
  return { rel: (DEGREES[mode][degree] + shift + 12) % 12, minor: m[2] === m[2].toLowerCase() };
}

// ---------- Giri comuni ----------

// Dizionario dei giri con un nome (teoria musicale, non dati). mode: il modo in cui i gradi
// sono scritti. In una tonalità minore valgono anche i giri maggiori sulla relativa (e
// viceversa): vi–IV–I–V in Do è i–VI–III–VII in La minore.
export const PROGRESSIONS = [
  { id: 'pop', name: 'giro pop', mode: 'major', roman: ['I', 'V', 'vi', 'IV'] },
  { id: 'do', name: 'giro di Do', mode: 'major', roman: ['I', 'vi', 'IV', 'V'] },
  { id: 'do-ii', name: 'giro di Do con il II', mode: 'major', roman: ['I', 'vi', 'ii', 'V'] },
  { id: 'twist', name: 'giro rock and roll', mode: 'major', roman: ['I', 'IV', 'V', 'IV'] },
  { id: 'I-IV-V', name: 'tre accordi', mode: 'major', roman: ['I', 'IV', 'V'] },
  { id: 'I-V-IV', name: 'tre accordi', mode: 'major', roman: ['I', 'V', 'IV'] },
  { id: 'I-IV-I-V', name: 'tre accordi', mode: 'major', roman: ['I', 'IV', 'I', 'V'] },
  { id: 'mixo', name: 'giro rock misolidio', mode: 'major', roman: ['I', '♭VII', 'IV'] },
  { id: 'mixo4', name: 'giro rock misolidio', mode: 'major', roman: ['I', '♭VII', 'IV', 'I'] },
  { id: 'I-IV', name: 'due accordi', mode: 'major', roman: ['I', 'IV'] },
  { id: 'I-V', name: 'due accordi', mode: 'major', roman: ['I', 'V'] },
  { id: 'I-bVII', name: 'due accordi', mode: 'major', roman: ['I', '♭VII'] },
  { id: 'ii-V-I', name: 'II–V–I', mode: 'major', roman: ['ii', 'V', 'I', 'I'] },
  { id: 'I-iii-IV-V', name: 'scala ascendente', mode: 'major', roman: ['I', 'iii', 'IV', 'V'] },
  { id: 'I-IV-vi-V', name: 'giro pop', mode: 'major', roman: ['I', 'IV', 'vi', 'V'] },
  { id: 'IV-V-iii-vi', name: 'giro "royal road"', mode: 'major', roman: ['IV', 'V', 'iii', 'vi'] },
  { id: 'canon', name: 'canone di Pachelbel', mode: 'major', roman: ['I', 'V', 'vi', 'iii', 'IV', 'I', 'IV', 'V'] },
  { id: 'andalusian', name: 'cadenza andalusa', mode: 'minor', roman: ['i', 'VII', 'VI', 'V'] },
  { id: 'aeolian', name: 'giro eolio', mode: 'minor', roman: ['i', 'VI', 'VII'] },
  { id: 'aeolian4', name: 'giro eolio', mode: 'minor', roman: ['i', 'VII', 'VI', 'VII'] },
  { id: 'i-iv-v', name: 'tre accordi in minore', mode: 'minor', roman: ['i', 'iv', 'v'] },
  { id: 'i-iv-V', name: 'tre accordi in minore', mode: 'minor', roman: ['i', 'iv', 'V'] },
  { id: 'i-iv', name: 'due accordi', mode: 'minor', roman: ['i', 'iv'] },
  { id: 'i-VII', name: 'due accordi', mode: 'minor', roman: ['i', 'VII'] },
  { id: 'i-VI-VII-i', name: 'giro eolio', mode: 'minor', roman: ['i', 'VI', 'VII', 'i'] },
];

// Accordi assoluti (0–23) di un giro nella tonalità: sulla tonica se il modo coincide,
// sulla relativa altrimenti.
export function progressionChords(entry, key) {
  const tonic = entry.mode === key.mode ? key.tonic : key.mode === 'minor' ? (key.tonic + 3) % 12 : (key.tonic + 9) % 12;
  return entry.roman.map((r) => {
    const { rel, minor } = parseRoman(r, entry.mode);
    return ((tonic + rel) % 12) + (minor ? 12 : 0);
  });
}

// Tutte le rotazioni di tutti i giri lunghi n, nella tonalità: [{ entry, rotation, chords }].
export function dictionaryCandidates(n, key, dictionary = PROGRESSIONS) {
  const out = [];
  const seen = new Set();
  for (const entry of dictionary) {
    if (entry.roman.length !== n) continue;
    const chords = progressionChords(entry, key);
    for (let r = 0; r < n; r++) {
      const rotated = chords.map((_, j) => chords[(j + r) % n]);
      const id = rotated.join(',');
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ entry, rotation: r, chords: rotated });
    }
  }
  return out;
}

// Riconosce un giro (esatto, in qualsiasi rotazione) nella successione di accordi.
export function recognize(chords, key, dictionary = PROGRESSIONS) {
  if (!key || !chords.length) return null;
  const id = chords.join(',');
  const hit = dictionaryCandidates(chords.length, key, dictionary).find((c) => c.chords.join(',') === id);
  return hit ? { id: hit.entry.id, name: hit.entry.name } : null;
}

// ---------- Passaggi tra accordi (modello a bigrammi) ----------

// log P(accordo b | accordo a) nella tonalità, dalla tabella relativa alla tonica:
// model.bigram[mode][relA*2+qA][relB*2+qB]... in forma compatta: indice = rel + 12·minore.
export function bigramLog(model, key, a, b) {
  if (!model || !key) return 0;
  const table = model.bigram[key.mode === 'minor' ? 'minor' : 'major'];
  const rel = (c) => ((c % 12) - key.tonic + 12) % 12 + (c < 12 ? 0 : 12);
  return table[rel(a)][rel(b)];
}

// Distribuzioni per posizione: il giro piegato (lag unità) diviso in n posizioni uguali.
export function positionDistributions(folded, n) {
  if (!n || folded.length % n) return null;
  const w = folded.length / n;
  return Array.from({ length: n }, (_, j) => {
    const g = new Float64Array(25);
    for (let k = j * w; k < (j + 1) * w; k++) for (let c = 0; c < 25; c++) g[c] += folded[k][c] / w;
    // Senza "nessun accordo": si confrontano solo accordi.
    let z = 0;
    for (let c = 0; c < NO_CHORD; c++) z += g[c];
    g[NO_CHORD] = 0;
    for (let c = 0; c < NO_CHORD; c++) g[c] = z > 0 ? g[c] / z : 1 / 24;
    return g;
  });
}

function sequenceScore(G, chords, model, key, lambda) {
  let s = 0;
  const n = chords.length;
  for (let j = 0; j < n; j++) {
    s += Math.log(Math.max(FLOOR, G[j][chords[j]]));
    const next = chords[(j + 1) % n];
    if (lambda && next !== chords[j]) s += lambda * bigramLog(model, key, chords[j], next);
  }
  return s;
}

function topChords(g, k) {
  return Array.from({ length: NO_CHORD }, (_, c) => c).sort((a, b) => g[b] - g[a]).slice(0, k);
}

// Candidati per un giro di n posizioni: i migliori per posizione (fascio) e i giri del
// dizionario. Restituisce la lista con probabilità (softmax dei punteggi), in ordine.
export function scoreCandidates(G, key, model, { lambda = 0.3, beam = 3, width = 64, dictionary = PROGRESSIONS } = {}) {
  const n = G.length;
  let partial = [{ chords: [], score: 0 }];
  for (let j = 0; j < n; j++) {
    const next = [];
    for (const cand of partial) {
      for (const c of topChords(G[j], beam)) {
        const chords = [...cand.chords, c];
        let score = cand.score + Math.log(Math.max(FLOOR, G[j][c]));
        if (j > 0 && lambda && chords[j - 1] !== c) score += lambda * bigramLog(model, key, chords[j - 1], c);
        next.push({ chords, score });
      }
    }
    partial = next.sort((a, b) => b.score - a.score).slice(0, width);
  }
  const all = new Map();
  for (const cand of partial) all.set(cand.chords.join(','), { chords: cand.chords, entry: null });
  if (key) {
    for (const d of dictionaryCandidates(n, key, dictionary)) {
      const id = d.chords.join(',');
      const known = all.get(id);
      if (known) known.entry = d.entry;
      else all.set(id, { chords: d.chords, entry: d.entry });
    }
  }
  const list = [...all.values()].map((c) => ({ ...c, score: sequenceScore(G, c.chords, model, key, lambda) }));
  const probs = softmax(list.map((c) => c.score));
  list.forEach((c, i) => { c.probability = probs[i]; });
  return list.sort((a, b) => b.probability - a.probability);
}

// Regola della correzione, tarata su Billboard (lab/progressions-eval.mjs): un giro del
// dizionario prende il posto di quello trovato solo se differisce in una sola posizione, se lì
// l'accordo trovato è incerto (< 0,6) e quello del giro è il secondo con almeno 0,25, se il
// giro è chiaro (S ≥ 0,75) e se il giro del dizionario vince il 60% dei candidati.
export const SNAP_RULE = { maxDetected: 0.6, minSecond: 0.25, minLoop: 0.75, minWin: 0.6 };

export function snapDecision(G, detected, candidates, loopScore, rule = SNAP_RULE) {
  const top = candidates[0];
  if (!top || !top.entry || loopScore < rule.minLoop || top.probability < rule.minWin) return null;
  const diff = [];
  top.chords.forEach((c, j) => { if (c !== detected[j]) diff.push(j); });
  if (diff.length !== 1) return null;
  const j = diff[0];
  const g = G[j];
  const second = topChords(g, 2)[1];
  if (g[detected[j]] >= rule.maxDetected || second !== top.chords[j] || g[second] < rule.minSecond) return null;
  return { position: j, from: detected[j], to: top.chords[j], entry: top.entry, probability: top.probability };
}

// Giro di una sezione (tutte le sue ripetizioni): periodo, accordi in ordine con durata e
// sicurezza, nome se è un giro noto, eventuale correzione. instances: per ogni volta che la
// sezione suona, la lista delle distribuzioni delle sue unità.
export function sectionProgression(instances, meter, key, model, { minLoop = 0.75, periods = PERIODS, lambda = 0.3, rule = SNAP_RULE, maxBars = 16, across = true, nameLoop = 0.85, nameSure = 0.8, align = {}, templateLoops = true } = {}) {
  const upb = unitsPerBar(meter);
  const loop = findLoop(instances, meter, { periods });
  let isLoop = loop.period !== null && loop.score >= minLoop;
  // Senza giro fisso: la sezione intera (fino a maxBars), piegata solo sulle sue ripetizioni.
  const longestLength = Math.max(...instances.map((u) => u.length));
  let lag = isLoop ? loop.period * upb : Math.min(longestLength, maxBars * upb);
  // offsets: dove comincia ogni ripetizione nel giro (null = troppo diversa, non piegata).
  let offsets = across ? alignInstances(instances, lag, isLoop, align) : instances.map((_, i) => (i === 0 ? 0 : null));
  const used = instances.filter((_, i) => offsets[i] !== null);
  let folded = fold(used, lag, offsets.filter((o) => o !== null), isLoop);
  let unitChords = folded.map(argmaxChord);
  let period = isLoop ? loop.period : null;
  // Senza giro nelle singole ripetizioni, il riassunto piegato può comunque ripetersi identico
  // (mediare le ripetizioni toglie i battiti incerti): allora è un giro.
  // Solo se il riassunto copre le ripetizioni per intero (non per l'intero brano, di cui
  // riassumerebbe solo l'inizio).
  if (!isLoop && templateLoops && used.every((u) => u.length <= lag)) {
    for (const p of periods) {
      const w = p * upb;
      if (2 * w > lag || lag % w) continue;
      if (unitChords.every((c, k) => k < w || c === unitChords[k - w])) {
        period = p;
        isLoop = true;
        folded = fold([folded], w, null, true);
        offsets = offsets.map((o) => (o === null ? null : ((o % w) + w) % w));
        lag = w;
        unitChords = folded.map(argmaxChord);
        break;
      }
    }
  }
  const unitP = folded.map((q, k) => q[unitChords[k]]);
  let alternative = null;
  let named = null;
  const loopScore = Math.max(loop.score, isLoop && period !== loop.period ? minLoop : 0);
  if (isLoop && key) {
    // Posizioni uguali: tante quanti gli accordi trovati se dividono il giro, altrimenti le
    // battute o le unità. Solo se la divisione rappresenta fedelmente il giro trovato.
    const slotCount = slots(folded).length;
    const counts = [slotCount, lag / upb, lag].filter((n, i, all) => n > 0 && lag % n === 0 && all.indexOf(n) === i);
    for (const n of counts) {
      const G = positionDistributions(folded, n);
      const detected = G.map(argmaxChord);
      const w = lag / n;
      if (!unitChords.every((c, k) => c === detected[Math.floor(k / w)])) continue;
      // Nome solo se il giro è netto e ogni accordo sicuro: su Billboard (sezioni annotate) il
      // giro annotato è davvero quello circa 9 volte su 10 (lab/progressions-dictionary.mjs).
      const sure = Math.min(...G.map((g, j) => g[detected[j]]));
      if (loopScore >= nameLoop && sure >= nameSure) named = recognize(detected, key);
      // Un giro noto che differisce in una sola posizione incerta: si propone, non si sostituisce.
      const candidates = scoreCandidates(G, key, model, { lambda });
      const s = snapDecision(G, detected, candidates, loopScore, rule);
      if (s) alternative = { position: s.position, chords: candidates[0].chords, id: s.entry.id, name: s.entry.name, probability: Math.round(s.probability * 100) / 100 };
      break;
    }
  }
  const meanLength = instances.reduce((acc, u) => acc + u.length, 0) / instances.length;
  return {
    loop: isLoop,
    period,
    units: lag,
    bars: lag / upb,
    loopScore: Math.round(loopScore * 1000) / 1000,
    repeats: isLoop ? Math.round((meanLength / lag) * 10) / 10 : 1,
    unitChords,
    offsets,
    chords: mergeUnits(unitChords, unitP),
    named,
    alternative,
  };
}

// Unità consecutive con lo stesso accordo → { chord, units, p } (p: sicurezza media).
export function mergeUnits(unitChords, unitP) {
  const out = [];
  unitChords.forEach((chord, k) => {
    const last = out[out.length - 1];
    if (last && last.chord === chord) { last.units += 1; last.p += unitP[k]; }
    else out.push({ chord, units: 1, p: unitP[k] });
  });
  return out.map((x) => ({ ...x, p: Math.round((x.p / x.units) * 100) / 100 }));
}
