import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackDownbeats, makeBars, analyzeBars, songStructure, beatLoudness, beatTimbre, nameSections, sectionCues, ROLES } from '../audio/structure.js';
import { ChromaAnalyzer } from '../audio/key.js';
import { RhythmAnalyzer } from '../audio/rhythm.js';
import { tempoCandidates, chooseTempo } from '../audio/tempo-choice.js';
import { beatChroma, chordScores, transitionMatrix, decode, keyBonus } from '../audio/chords.js';
import { rng, synthSong } from './helpers.js';

const models = {
  structure: JSON.parse(readFileSync(new URL('../audio/structure-model.json', import.meta.url), 'utf8')),
  progressions: JSON.parse(readFileSync(new URL('../audio/progression-model.json', import.meta.url), 'utf8')),
};
const C = 0, D = 2, E = 4, F = 5, G = 7, A = 9;
const m = (x) => x + 12;

// Battiti sintetici di un brano: un accordo per battuta (4 battiti), cromagramma dalle note
// dell'accordo con un po' di rumore, probabilità degli accordi quasi sicure, volume per battuta.
function synthBeats(bars, { seed = 1, beat = 0.5 } = {}) {
  const random = rng(seed);
  const beats = [];
  const posteriors = [];
  const loudness = [];
  bars.forEach(({ chord, loud }, b) => {
    const root = chord % 12;
    const tones = [root, (root + (chord < 12 ? 4 : 3)) % 12, (root + 7) % 12];
    for (let q = 0; q < 4; q++) {
      const t = (b * 4 + q) * beat;
      const treble = Array.from({ length: 12 }, (_, p) => (tones.includes(p) ? 1 : 0.05) * (0.8 + 0.4 * random.uniform()));
      const bass = Array.from({ length: 12 }, (_, p) => (p === root ? 1 : 0.03 * random.uniform()));
      beats.push({ start: t, end: t + beat, treble, bass, energy: loud / 10 });
      const post = new Float64Array(25).fill(0.04 / 24);
      post[chord] = 0.96;
      posteriors.push(post);
      loudness.push(loud + random.gauss() * 0.5);
    }
  });
  return { beats, posteriors, loudness };
}

// A A B B A A: strofa sul giro Do–Sol–Lam–Fa, ritornello (più forte) su Fa–Sol–Mim–Lam.
function aabbaa() {
  const verse = [C, G, m(A), F, C, G, m(A), F].map((chord) => ({ chord, loud: -20 }));
  const chorus = [F, G, m(E), m(A), F, G, [C], [C]].map((chord) => ({ chord: Array.isArray(chord) ? chord[0] : chord, loud: -14 }));
  return [...verse, ...verse, ...chorus, ...chorus, ...verse, ...verse];
}

test('primi battiti: il cambio d\'accordo segna la battuta, anche con un battito in anacrusi', () => {
  const chords = [5, 5, 5, 0, 0, 0, 0, 7, 7, 7, 7, 21, 21, 21, 21, 5, 5, 5, 5, 0, 0, 0, 0, 7, 7, 7, 7];
  const posteriors = chords.map((c) => { const p = new Float64Array(25).fill(0.01 / 24); p[c] = 0.99; return p; });
  const { starts } = trackDownbeats(posteriors, 4);
  assert.deepEqual(starts.slice(0, 5), [3, 7, 11, 15, 19]);
  const bars = makeBars(chords.length, starts, 4);
  assert.deepEqual(bars[0], { from: 0, to: 3 }); // l'anacrusi di 3 battiti è una battuta incompleta
  assert.deepEqual(bars[1], { from: 3, to: 7 });
});

test('volume per battito dal valore efficace dei frame', () => {
  const loud = beatLoudness([0.1, 0.1, 0.01, 0.01], [0.1, 0.3, 0.6, 0.8], [{ start: 0, end: 0.5 }, { start: 0.5, end: 1 }]);
  assert.ok(Math.abs(loud[0] - -20) < 0.01);
  assert.ok(Math.abs(loud[1] - -40) < 0.01);
});

test('timbro per battito: coefficienti cepstrali delle bande mel, zero per uno spettro piatto', () => {
  const flat = Array.from({ length: 20 }, () => new Float32Array(40).fill(3));
  const tilted = Array.from({ length: 20 }, () => Float32Array.from({ length: 40 }, (_, b) => 5 - b / 10));
  const beats = [{ start: 0, end: 0.5 }, { start: 0.5, end: 1 }];
  const t = beatTimbre(flat, 0.1, beats);
  assert.equal(t.length, 2);
  assert.equal(t[0].length, 12);
  assert.ok(t[0].every((v) => Math.abs(v) < 1e-9));
  assert.ok(beatTimbre(tilted, 0.1, beats)[0][0] > 1, 'più energia in basso: primo coefficiente positivo');
});

test('struttura A A B B A A: confini dove cambia la musica, lettere uguali dove torna', () => {
  const { beats, posteriors, loudness } = synthBeats(aabbaa());
  const r = analyzeBars(beats, posteriors, loudness, { lengthPrior: models.structure.lengthPrior });
  const letterAt = (bar) => r.sections.find((s) => s.start <= bar && bar < s.end).letter;
  const starts = r.sections.map((s) => s.start);
  for (const b of [16, 32]) assert.ok(starts.some((s) => Math.abs(s - b) <= 1), `confine vicino alla battuta ${b}: ${starts}`);
  assert.equal(letterAt(4), letterAt(40));
  assert.equal(letterAt(12), letterAt(36));
  assert.notEqual(letterAt(4), letterAt(20));
  assert.equal(letterAt(20), letterAt(28));
});

test('struttura completa: giro per lettera in ordine, niente nomi, forma compatta', () => {
  const { beats, posteriors, loudness } = synthBeats(aabbaa());
  const st = songStructure({ beats, posteriors, loudness, key: { tonic: 0, mode: 'major' } }, models);
  assert.ok(st.shown);
  const verse = st.progressions[st.sections[0].letter];
  assert.equal(verse.loop, true);
  assert.equal(verse.period, 4);
  assert.deepEqual(verse.chords.map((c) => c.chord), [C, G, m(A), F]);
  assert.equal(verse.named.id, 'pop');
  const chorusLetter = st.sections.find((s) => s.start <= 40 && 40 < s.end).letter; // battuta 20 (2 s a battuta)
  const chorus = st.progressions[chorusLetter];
  assert.deepEqual(chorus.chords.map((c) => c.chord).slice(0, 5), [F, G, m(E), m(A), F]);
  assert.ok(st.sections.every((s) => s.role === null), 'i nomi delle sezioni sono spenti');
  assert.equal(st.whole, null, 'strofa e ritornello hanno giri diversi');
});

test('brano breve o senza ripetizioni: niente struttura', () => {
  const { beats, posteriors, loudness } = synthBeats(aabbaa().slice(0, 12));
  assert.equal(songStructure({ beats, posteriors, loudness, key: null }, models), null);
});

test('ruoli: il modello dell\'ordine delle sezioni dà probabilità che sommano a 1', () => {
  const { beats, posteriors, loudness } = synthBeats(aabbaa());
  const r = analyzeBars(beats, posteriors, loudness, { lengthPrior: models.structure.lengthPrior });
  const names = nameSections(sectionCues(r.sections, r.features), models.structure.names);
  assert.equal(names.roles.length, r.sections.length);
  for (const p of names.posteriors) assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(names.roles.every((x) => ROLES.includes(x)));
});

test('catena completa dall\'audio: strofa, ritornello, strofa, ritornello su una canzone sintetica', () => {
  const SR = 22050;
  const verse = { chords: [C, G, m(A), F], repeat: 2, level: 0.7 };
  const chorus = { chords: [F, G, m(E), m(A)], repeat: 2, level: 1.3, busy: true };
  const audio = synthSong([verse, chorus, verse, chorus, verse, chorus], { bpm: 120, sampleRate: SR });
  const rhythm = new RhythmAnalyzer({ sampleRate: SR, beatSeconds: 1e6 });
  const chroma = new ChromaAnalyzer({ sampleRate: SR, method: 'nnls', hop: 2048 });
  for (let i = 0; i < audio.length; i += 8192) { rhythm.push(audio.subarray(i, i + 8192)); chroma.push(audio.subarray(i, i + 8192)); }
  const choice = chooseTempo(tempoCandidates(rhythm));
  const tuning = chroma.tuningCents();
  const frames = chroma.frames.map((r) => (r.log ? chroma.frameChroma(r, tuning) : { treble: new Float64Array(36), bass: new Float64Array(36) }));
  const times = frames.map((_, k) => (k * 2048 + 4096) / SR);
  const beats = beatChroma(frames, times, rhythm.beats(choice.bpm));
  const model = JSON.parse(readFileSync(new URL('../audio/chord-model.json', import.meta.url), 'utf8'));
  const key = { tonic: 0, mode: 'major' };
  const scores = chordScores(beats, model.emission, keyBonus(key, model.keyPrior, model.keyWeight)).map((row) => row.map((x) => x / model.temperature));
  const { posteriors } = decode(scores, transitionMatrix(model.transitions));
  const loudness = beatLoudness(chroma.frames.map((r) => r.rms), times, beats);
  const st = songStructure({ beats, posteriors, loudness, key }, models);
  assert.ok(st && st.shown);
  // 2 s a battuta: strofa 0–16 s, ritornello 16–32 s, e così via. Lettere diverse, che tornano.
  const letterAt = (t) => st.sections.find((s) => s.start <= t && t < s.end)?.letter;
  assert.notEqual(letterAt(8), letterAt(24));
  assert.equal(letterAt(8), letterAt(40));
  assert.equal(letterAt(8), letterAt(72));
  assert.equal(letterAt(24), letterAt(56));
  assert.equal(letterAt(24), letterAt(88));
  const loopOf = (t) => st.progressions[letterAt(t)];
  const sorted = (p) => [...new Set(p.chords.map((c) => c.chord))].sort((a, b) => a - b);
  assert.deepEqual(sorted(loopOf(8)), [C, F, G, m(A)].sort((a, b) => a - b));
  assert.deepEqual(sorted(loopOf(24)), [F, G, m(E), m(A)].sort((a, b) => a - b));
});
