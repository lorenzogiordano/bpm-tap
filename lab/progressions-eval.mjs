// Giri di accordi su Billboard, in validazione incrociata a 5 gruppi (la tabella dei passaggi
// si conta senza i brani di prova, più RS 200). Per ogni sezione annotata (lettera), le sue
// ripetizioni sulle battute trovate dall'app, il giro, e il confronto con gli accordi annotati:
//   - giro sì/no e periodo contro quello annotato (periodico al 90% delle mezze battute);
//   - accordo per battito: HMM grezzo, mezza battuta, giro piegato (e ripetuto sul tempo);
//   - correzioni verso i giri noti: quante, quante giuste e quante sbagliate;
//   - giri riconosciuti per nome: quante volte il giro annotato è davvero quello.
// Uso: node lab/progressions-eval.mjs [oracle|estimated] [chiave=valore …]
//   oracle:    sezioni e lettere annotate (isola il giro dagli errori della struttura)
//   estimated: sezioni e lettere trovate dall'app
import { loadBillboard, foldOf } from './billboard.mjs';
import { posteriorsFor, mean, pct, lengthPrior } from './structure-common.mjs';
import { countBigrams, bigramTable, sequencesFor } from './progressions-tables.mjs';
import { findDownbeats, makeBars, analyzeBars } from '../audio/structure.js';
import { barUnits, sectionProgression, PERIODS, SNAP_RULE, recognize, unitsPerBar } from '../audio/progressions.js';
import { NO_CHORD } from '../audio/chords.js';

const [mode = 'oracle', ...rest] = process.argv.slice(2);
const opts = Object.fromEntries(rest.map((a) => a.split('=')).map(([k, v]) => [k, JSON.parse(v)]));
const FOLDS = 5;

const songs = loadBillboard().filter((s) => s.beats.length > 64 && s.sections.length >= 2 && s.key);
for (const s of songs) {
  const { path, posteriors } = posteriorsFor(s.beats, s.key);
  s.path = path;
  s.post = posteriors;
  s.fold = foldOf(s, FOLDS);
}

// Periodo annotato (in battute) di una sezione: il più corto con il 90% delle mezze battute
// uguali a quelle un periodo prima (solo accordi definiti), con almeno un giro da confrontare.
function refPeriod(instances) {
  for (const p of PERIODS) {
    const lag = 2 * p;
    let same = 0;
    let n = 0;
    for (const u of instances) for (let k = lag; k < u.length; k++) { if (u[k] < 0 || u[k - lag] < 0) continue; n += 1; if (u[k] === u[k - lag]) same += 1; }
    if (n >= lag && same / n >= 0.9) return p;
  }
  return null;
}

const stats = {
  sections: 0, loopRef: 0, loopEst: 0, loopBoth: 0, periodSame: 0,
  beats: 0, raw: 0, unit: 0, folded: 0, loopBeats: 0, loopUnit: 0, loopFolded: 0, tplBeats: 0, tplUnit: 0, tplFolded: 0,
  snaps: 0, snapBetter: 0, snapWorse: 0, snapSame: 0,
  named: 0, namedRight: 0, namedLoopRight: 0,
};

for (let f = 0; f < FOLDS; f++) {
  const model = { bigram: bigramTable(countBigrams(sequencesFor(songs.filter((s) => s.fold !== f)))) };
  const prior = lengthPrior(songs.filter((s) => s.fold !== f));
  for (const s of songs.filter((x) => x.fold === f)) {
    let bars;
    let groups;
    if (mode === 'estimated') {
      const r = analyzeBars(s.beats, s.post, s.beats.map((b) => b.loud), { lengthPrior: prior });
      if (!r) continue;
      bars = r.bars;
      groups = {};
      for (const sec of r.sections) (groups[sec.letter] ||= []).push([sec.start, sec.end]);
    } else {
      const d = findDownbeats(s.post);
      bars = makeBars(s.beats.length, d.starts, d.meter);
      if (bars.length < 8) continue;
      const times = bars.map((b) => s.beats[b.from].start);
      const nearest = (t) => times.reduce((best, x, k) => (Math.abs(x - t) < Math.abs(times[best] - t) ? k : best), 0);
      groups = {};
      for (const sec of s.sections) {
        const a = nearest(sec.start);
        const b = sec.end >= times[times.length - 1] ? bars.length : nearest(sec.end);
        if (b - a >= 2) (groups[sec.letter] ||= []).push([a, b]);
      }
    }
    // Come nell'app (songStructure): le ripetizioni che non vanno d'accordo con il giro della
    // lettera diventano una variante con il suo giro.
    const jobs = [];
    for (const instances of Object.values(groups)) {
      const unitSets = instances.map(([a, b]) => barUnits(s.post, bars.slice(a, b), 4));
      if (!unitSets.some((u) => u.length >= 4)) continue;
      const run = (sets) => sectionProgression(sets.map((u) => u.map((x) => x.p)), 4, s.key, model, { ...opts, rule: { ...SNAP_RULE, ...(opts.rule || {}) } });
      const prog = run(unitSets);
      jobs.push({ unitSets, prog });
      const rest = unitSets.filter((_, i) => prog.offsets[i] === null);
      if (rest.length && mode === 'estimated') jobs.push({ unitSets: rest, prog: run(rest) });
    }
    for (const { unitSets, prog } of jobs) {
      // Accordi annotati per mezza battuta (a metà dell'unità).
      const refUnits = unitSets.map((u) => u.map((x) => {
        const mid = Math.floor((x.from + x.to - 1) / 2);
        const l = s.beats[mid]?.ref;
        return l === undefined || l < 0 || l === NO_CHORD ? -1 : l;
      }));
      const rp = refPeriod(refUnits);
      stats.sections += 1;
      if (rp) stats.loopRef += 1;
      if (prog.loop) stats.loopEst += 1;
      if (rp && prog.loop) { stats.loopBoth += 1; if (rp === prog.period) stats.periodSame += 1; }
      // Accordo per battito.
            unitSets.forEach((units, idx) => units.forEach((x, k) => {
        if (mode === 'estimated' && prog.offsets[idx] === null && jobs.some((j) => j.unitSets.includes(units) && j.prog !== prog)) return; // contata nella sua variante
        const argmax = (() => { let b = 0; for (let c = 1; c < NO_CHORD; c++) if (x.p[c] > x.p[b]) b = c; return b; })();
        const pos = k + (prog.offsets[idx] ?? 0);
        const inTemplate = prog.loop || (pos >= 0 && pos < prog.units);
        const predicted = inTemplate ? prog.unitChords[((pos % prog.units) + prog.units) % prog.units] : argmax;
        for (let i = x.from; i < x.to; i++) {
          const ref = s.beats[i].ref;
          if (ref < 0 || ref === NO_CHORD) continue;
          stats.beats += 1;
          if (s.path[i] === ref) stats.raw += 1;
          if (argmax === ref) stats.unit += 1;
          if (predicted === ref) stats.folded += 1;
          if (prog.loop) { stats.loopBeats += 1; if (argmax === ref) stats.loopUnit += 1; if (predicted === ref) stats.loopFolded += 1; }
          else if (inTemplate) { stats.tplBeats += 1; if (argmax === ref) stats.tplUnit += 1; if (predicted === ref) stats.tplFolded += 1; }
        }
      }));
      if (prog.alternative) {
        // Proposta di un giro noto: nella posizione cambiata, l'accordo annotato più frequente
        // è quello proposto (giusta) o quello trovato (sbagliata)?
        stats.snaps += 1;
        const alt = prog.alternative;
        const w = prog.units / alt.chords.length;
        const cnt = {};
        unitSets.forEach((units) => units.forEach((x, k) => {
          if (Math.floor((k % prog.units) / w) !== alt.position) return;
          for (let i = x.from; i < x.to; i++) { const r = s.beats[i].ref; if (r >= 0 && r !== NO_CHORD) cnt[r] = (cnt[r] || 0) + 1; }
        }));
        const top = Number(Object.entries(cnt).sort((x, y) => y[1] - x[1])[0]?.[0] ?? -1);
        if (top === alt.chords[alt.position]) stats.snapBetter += 1;
        else if (top === prog.unitChords[alt.position * w]) stats.snapWorse += 1;
        else stats.snapSame += 1;
      }
      if (prog.named) {
        stats.named += 1;
        // Il giro annotato (mezze battute piegate col periodo trovato) è lo stesso giro con nome?
        const lag = prog.units;
        const refFold = Array.from({ length: lag }, () => ({}));
        refUnits.forEach((u) => u.forEach((l, k) => { if (l >= 0) refFold[k % lag][l] = (refFold[k % lag][l] || 0) + 1; }));
        const refChords = refFold.map((c) => Number(Object.entries(c).sort((x, y) => y[1] - x[1])[0]?.[0] ?? -1));
        const same = refChords.every((c, k) => c === prog.unitChords[k]);
        if (same) stats.namedRight += 1;
        const merged = refChords.filter((c, k) => k === 0 || c !== refChords[k - 1]);
        if (recognize(merged, s.key)?.id === prog.named.id) stats.namedLoopRight += 1;
      }
    }
  }
}

const rows = {
  sezioni: stats.sections,
  'giro fisso annotato': pct(stats.loopRef / stats.sections),
  'giro fisso trovato': pct(stats.loopEst / stats.sections),
  'giro trovato: precisione': pct(stats.loopBoth / Math.max(1, stats.loopEst)),
  'giro annotato: richiamo': pct(stats.loopBoth / Math.max(1, stats.loopRef)),
  'stesso periodo (se entrambi)': pct(stats.periodSame / Math.max(1, stats.loopBoth)),
  'battiti: HMM': pct(stats.raw / stats.beats),
  'battiti: mezza battuta': pct(stats.unit / stats.beats),
  'battiti: giro piegato': pct(stats.folded / stats.beats),
  'battiti nei giri trovati': stats.loopBeats,
  'giri trovati: mezza battuta': pct(stats.loopUnit / Math.max(1, stats.loopBeats)),
  'giri trovati: piegato': pct(stats.loopFolded / Math.max(1, stats.loopBeats)),
  'senza giro, battiti nel modello': stats.tplBeats,
  'senza giro: mezza battuta': pct(stats.tplUnit / Math.max(1, stats.tplBeats)),
  'senza giro: ripetizioni piegate': pct(stats.tplFolded / Math.max(1, stats.tplBeats)),
  'giri noti proposti (una posizione)': stats.snaps,
  'proposta giusta': stats.snapBetter,
  'proposta sbagliata (era giusto il trovato)': stats.snapWorse,
  'né l\'uno né l\'altro': stats.snapSame,
  'giri con nome': stats.named,
  'nome giusto (giro annotato uguale)': pct(stats.namedRight / Math.max(1, stats.named)),
  'nome giusto (stesso giro noto)': pct(stats.namedLoopRight / Math.max(1, stats.named)),
};
console.log(mode, JSON.stringify(opts));
console.table(rows);
