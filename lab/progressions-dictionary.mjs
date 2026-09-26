// Confronto dei giri trovati con i giri noti del dizionario (audio/progressions.js), su
// Billboard con le sezioni annotate e la tabella dei passaggi in validazione incrociata.
// Tre domande, con l'accordo annotato più frequente in ogni posizione come verità:
//   1. un giro noto che differisce in UNA posizione: sostituirlo migliorerebbe il giro?
//   2. un giro noto con gli stessi accordi in un altro ordine: riordinare aiuterebbe?
//   3. quando il giro trovato è un giro noto, il nome è giusto?
// Uso: node lab/progressions-dictionary.mjs [minLoop=0.6] [lambda=0.3]
import { loadBillboard, foldOf } from './billboard.mjs';
import { posteriorsFor, pct } from './structure-common.mjs';
import { countBigrams, bigramTable, sequencesFor } from './progressions-tables.mjs';
import { findDownbeats, makeBars } from '../audio/structure.js';
import * as pr from '../audio/progressions.js';
import { NO_CHORD } from '../audio/chords.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')).map(([k, v]) => [k, JSON.parse(v)]));
const minLoop = args.minLoop ?? 0.6;
const songs = loadBillboard().filter((s) => s.beats.length > 64 && s.sections.length >= 2 && s.key);
for (const s of songs) { s.post = posteriorsFor(s.beats, s.key).posteriors; s.fold = foldOf(s); }

const one = [];
const perm = [];
const named = [];
for (let f = 0; f < 5; f++) {
  const model = { bigram: bigramTable(countBigrams(sequencesFor(songs.filter((s) => s.fold !== f)))) };
  for (const s of songs.filter((x) => x.fold === f)) {
    const d = findDownbeats(s.post);
    const bars = makeBars(s.beats.length, d.starts, d.meter);
    if (bars.length < 8) continue;
    const times = bars.map((b) => s.beats[b.from].start);
    const nearest = (t) => times.reduce((best, x, k) => (Math.abs(x - t) < Math.abs(times[best] - t) ? k : best), 0);
    const groups = {};
    for (const sec of s.sections) {
      const a = nearest(sec.start);
      const b = sec.end >= times[times.length - 1] ? bars.length : nearest(sec.end);
      if (b - a >= 2) (groups[sec.letter] ||= []).push([a, b]);
    }
    for (const inst of Object.values(groups)) {
      const unitSets = inst.map(([a, b]) => pr.barUnits(s.post, bars.slice(a, b), 4));
      const dists = unitSets.map((u) => u.map((x) => x.p));
      const loop = pr.findLoop(dists, 4);
      if (!loop.period || loop.score < minLoop) continue;
      const lag = loop.period * 2;
      const offsets = pr.alignInstances(dists, lag, true);
      const folded = pr.fold(dists.filter((_, i) => offsets[i] !== null), lag, offsets.filter((o) => o !== null), true);
      const unitChords = folded.map(pr.argmaxChord);
      const counts = [pr.slots(folded).length, lag / 2, lag].filter((n, i, a) => lag % n === 0 && a.indexOf(n) === i);
      for (const n of counts) {
        const G = pr.positionDistributions(folded, n);
        const det = G.map(pr.argmaxChord);
        const w = lag / n;
        if (!unitChords.every((c, k) => c === det[Math.floor(k / w)])) continue;
        // Verità: accordo annotato più frequente in ogni posizione (sulle ripetizioni allineate).
        const truth = Array.from({ length: n }, (_, j) => {
          const cnt = {};
          unitSets.forEach((units, i) => {
            if (offsets[i] === null) return;
            units.forEach((x, k) => {
              if (Math.floor((((k + offsets[i]) % lag) + lag) % lag / w) !== j) return;
              for (let t = x.from; t < x.to; t++) { const r = s.beats[t].ref; if (r >= 0 && r !== NO_CHORD) cnt[r] = (cnt[r] || 0) + 1; }
            });
          });
          return Number(Object.entries(cnt).sort((a, b) => b[1] - a[1])[0]?.[0] ?? -1);
        });
        const cands = pr.scoreCandidates(G, s.key, model, { lambda: args.lambda ?? 0.3 });
        const exact = cands.find((c) => c.entry && c.chords.every((x, j) => x === det[j]));
        if (exact) named.push({ right: truth.every((x, j) => x === det[j]), loop: loop.score, sure: Math.min(...G.map((g, j) => g[det[j]])) });
        const diffOne = cands.filter((c) => c.entry && c.chords.filter((x, j) => x !== det[j]).length === 1);
        if (diffOne.length) {
          const c = diffOne[0];
          const j = c.chords.findIndex((x, k) => x !== det[k]);
          const second = Array.from({ length: 24 }, (_, x) => x).sort((a, b) => G[j][b] - G[j][a])[1];
          one.push({ right: truth[j] === c.chords[j], wasRight: truth[j] === det[j], gDet: G[j][det[j]], gTo: G[j][c.chords[j]], second: second === c.chords[j], rank: cands.indexOf(c), prob: c.probability, loop: loop.score, rule: Boolean(pr.snapDecision(G, det, cands, loop.score)) });
        }
        const key = (arr) => [...arr].sort((a, b) => a - b).join(',');
        const p = cands.find((c) => c.entry && key(c.chords) === key(det) && c.chords.some((x, k) => x !== det[k]));
        if (p) perm.push({ right: truth.every((x, k) => x === p.chords[k]), wasRight: truth.every((x, k) => x === det[k]), rank: cands.indexOf(p) });
        break;
      }
    }
  }
}

const row = (list, fn = () => true) => {
  const e = list.filter(fn);
  return { casi: e.length, 'giro noto giusto': e.filter((x) => x.right).length, 'era giusto il trovato': e.filter((x) => x.wasRight).length, 'precisione': pct(e.filter((x) => x.right).length / Math.max(1, e.length)) };
};
console.log(`giri con S ≥ ${minLoop}`);
console.table({
  '1 posizione diversa: tutti': row(one),
  '… trovato incerto (< 0,6)': row(one, (x) => x.gDet < 0.6),
  '… e il giro noto è il 2° (≥ 0,25)': row(one, (x) => x.gDet < 0.6 && x.second && x.gTo >= 0.25),
  '… e giro netto (S ≥ 0,75)': row(one, (x) => x.gDet < 0.6 && x.second && x.gTo >= 0.25 && x.loop >= 0.75),
  '… regola completa (vince il 60%)': row(one, (x) => x.rule),
  'stessi accordi, altro ordine': row(perm),
  '… e il riordino vince': row(perm, (x) => x.rank === 0),
});
const nm = (lo, su) => { const e = named.filter((x) => x.loop >= lo && x.sure >= su); return { giri: e.length, 'nome giusto': pct(e.filter((x) => x.right).length / Math.max(1, e.length)) }; };
console.table({ 'giro noto (S ≥ 0,6)': nm(0.6, 0), 'S ≥ 0,75': nm(0.75, 0), 'S ≥ 0,85, accordi ≥ 0,8 (app)': nm(0.85, 0.8) });
