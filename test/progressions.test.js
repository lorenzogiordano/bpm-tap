import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  romanNumeral, progressionChords, recognize, PROGRESSIONS, findLoop, sectionProgression, mergeUnits,
  snapDecision, scoreCandidates, positionDistributions, alignInstances, fold, argmaxChord,
} from '../audio/progressions.js';
import { rng } from './helpers.js';

const C = { tonic: 0, mode: 'major' };
const Am = { tonic: 9, mode: 'minor' };

// Distribuzione quasi sicura su un accordo (resto sparso sugli altri 24 stati).
function dist(chord, p = 0.9) {
  const q = new Float64Array(25).fill((1 - p) / 24);
  q[chord] = p;
  return q;
}

// Unità (mezze battute) di un giro di accordi da una battuta ciascuno, ripetuto.
function loopUnits(chords, repeats, p = 0.9) {
  const out = [];
  for (let r = 0; r < repeats; r++) for (const c of chords) out.push(dist(c, p), dist(c, p));
  return out;
}

const pop = PROGRESSIONS.find((e) => e.id === 'pop');
const noBigrams = { bigram: { major: Array.from({ length: 24 }, () => new Array(24).fill(Math.log(1 / 23))), minor: Array.from({ length: 24 }, () => new Array(24).fill(Math.log(1 / 23))) } };

test('gradi: maiuscolo maggiore, minuscolo minore; in minore VI e VII senza bemolle', () => {
  assert.equal(romanNumeral(7, C), 'V');
  assert.equal(romanNumeral(21, C), 'vi');
  assert.equal(romanNumeral(10, C), '♭VII');
  assert.equal(romanNumeral(7, Am), 'VII');   // Sol in La minore
  assert.equal(romanNumeral(5, Am), 'VI');    // Fa
  assert.equal(romanNumeral(0, Am), 'III');   // Do
  assert.equal(romanNumeral(4, Am), 'V');     // Mi maggiore (dominante)
  assert.equal(romanNumeral(14, Am), 'iv');   // Rem
  assert.equal(romanNumeral(24, C), '');      // nessun accordo
});

test('giri noti: accordi nella tonalità, rotazioni e relativa minore', () => {
  assert.deepEqual(progressionChords(pop, C), [0, 7, 21, 5]);            // Do Sol Lam Fa
  assert.deepEqual(progressionChords(pop, { tonic: 7, mode: 'major' }), [7, 2, 16, 0]); // Sol Re Mim Do
  assert.equal(recognize([0, 7, 21, 5], C).id, 'pop');
  assert.equal(recognize([21, 5, 0, 7], C).id, 'pop');                   // vi–IV–I–V: stesso giro, ruotato
  assert.equal(recognize([0, 7, 21, 5], Am).id, 'pop');                  // in La minore vale la relativa
  assert.equal(recognize([0, 21, 5, 7], C).id, 'do');                    // I–vi–IV–V: giro di Do
  assert.equal(recognize([0, 2, 21, 5], C), null);
});

test('giro fisso: periodo, accordi in ordine, ripetizioni e nome', () => {
  const instances = [loopUnits([0, 7, 21, 5], 2, 0.95), loopUnits([0, 7, 21, 5], 2, 0.95)];
  const loop = findLoop(instances, 4);
  assert.equal(loop.period, 4);
  const p = sectionProgression(instances, 4, C, noBigrams);
  assert.equal(p.loop, true);
  assert.equal(p.period, 4);
  assert.equal(p.repeats, 2);
  assert.deepEqual(p.chords.map((c) => [c.chord, c.units]), [[0, 2], [7, 2], [21, 2], [5, 2]]);
  assert.equal(p.named.id, 'pop');
  assert.equal(p.alternative, null);
});

test('due accordi per battuta: il giro si legge a mezze battute', () => {
  const units = [];
  for (let r = 0; r < 4; r++) units.push(dist(0), dist(7), dist(21), dist(5));
  const p = sectionProgression([units], 4, C, noBigrams);
  assert.equal(p.period, 2);
  assert.deepEqual(p.chords.map((c) => [c.chord, c.units]), [[0, 1], [7, 1], [21, 1], [5, 1]]);
});

test('ripetizioni sfasate di una battuta si allineano prima di piegarle', () => {
  const a = loopUnits([0, 7, 21, 5], 2);
  const b = loopUnits([7, 21, 5, 0], 2); // la stessa sezione, trovata una battuta più tardi
  const offsets = alignInstances([a, b], 8, true);
  assert.deepEqual(offsets, [0, 2]);
  const folded = fold([a, b], 8, offsets, true);
  assert.deepEqual(folded.map(argmaxChord), [0, 0, 7, 7, 21, 21, 5, 5]);
});

test('senza giro fisso: la sezione intera, e niente nome', () => {
  const random = rng(3);
  const chords = Array.from({ length: 12 }, () => Math.floor(random.uniform() * 24));
  for (let i = 1; i < chords.length; i++) if (chords[i] === chords[i - 1]) chords[i] = (chords[i] + 5) % 24;
  const units = chords.flatMap((c) => [dist(c), dist(c)]);
  const p = sectionProgression([units], 4, C, noBigrams);
  assert.equal(p.loop, false);
  assert.equal(p.bars, 12);
  assert.deepEqual(p.chords.map((c) => c.chord), chords);
  assert.equal(p.named, null);
});

test('confronto con i giri noti: si propone solo con UNA posizione diversa, e mai si sostituisce', () => {
  // Tabella dei passaggi che preferisce il giro pop (Do→Sol→Lam→Fa→Do).
  const table = Array.from({ length: 24 }, () => new Array(24).fill(Math.log(0.01)));
  table[0][7] = table[7][9 + 12] = table[21][5] = table[5][0] = Math.log(0.9);
  const model = { bigram: { major: table, minor: table } };
  // Terza posizione incerta: Mim 0,5 contro Lam 0,45.
  const G = [dist(0, 0.95), dist(7, 0.95), (() => { const q = new Float64Array(25).fill(0.05 / 22); q[16] = 0.5; q[21] = 0.45; q[24] = 0; return q; })(), dist(5, 0.95)];
  const detected = G.map(argmaxChord);
  assert.deepEqual(detected, [0, 7, 16, 5]);
  const candidates = scoreCandidates(G, C, model, { lambda: 1 });
  const snap = snapDecision(G, detected, candidates, 0.9);
  assert.ok(snap, 'una posizione incerta, il giro noto vince');
  assert.equal(snap.entry.id, 'pop');
  assert.equal(snap.position, 2);
  assert.equal(snap.to, 21);
  // Due posizioni diverse: mai, anche se il giro noto vincesse.
  const G2 = [dist(0, 0.95), dist(7, 0.95), G[2], (() => { const q = new Float64Array(25).fill(0.05 / 22); q[2] = 0.5; q[5] = 0.45; q[24] = 0; return q; })()];
  const det2 = G2.map(argmaxChord);
  const c2 = scoreCandidates(G2, C, model, { lambda: 1 });
  assert.equal(snapDecision(G2, det2, c2, 0.9), null);
  // Giro poco netto: nemmeno la proposta.
  assert.equal(snapDecision(G, detected, candidates, 0.6), null);
  // Nella sezione il giro trovato resta com'è; il giro noto è solo un'alternativa.
  const units = [];
  for (let r = 0; r < 3; r++) for (const g of G) units.push(g, g);
  const p = sectionProgression([units], 4, C, model, { lambda: 1 });
  assert.deepEqual(p.chords.map((c) => c.chord), [0, 7, 16, 5]);
  assert.equal(p.alternative?.id, 'pop');
  assert.deepEqual(p.alternative.chords, [0, 7, 21, 5]);
});

test('posizioni: medie per posizione e unità unite con la loro sicurezza', () => {
  const folded = [dist(0), dist(0), dist(7, 0.7), dist(7, 0.5)];
  const G = positionDistributions(folded, 2);
  assert.equal(argmaxChord(G[1]), 7);
  assert.equal(G[0][24], 0);
  assert.deepEqual(mergeUnits([0, 0, 7, 7], [1, 0.8, 0.6, 0.4]), [{ chord: 0, units: 2, p: 0.9 }, { chord: 7, units: 2, p: 0.5 }]);
});
