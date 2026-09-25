import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beatChroma, chordScores, keyBonus, transitionMatrix, decode, chordShares, NO_CHORD, CHORD_STATES } from '../audio/chords.js';
import { ChromaAnalyzer } from '../audio/key.js';

const uniformChange = [0, 1].map((qa) => [0, 1].map((qb) => Array.from({ length: 12 }, (_, k) => (qa === qb && k === 0 ? 0 : 1 / 23))));

test('cromagramma per battito: media dei frame dentro ogni battito, normalizzata', () => {
  // 36 bin (3 per semitono): Do nel bin 0, Mi nel bin 12.
  const frame = (bins) => { const t = new Float64Array(36); for (const b of bins) t[b] = 1; return { treble: t, bass: t.slice() }; };
  const frames = [frame([0]), frame([0]), frame([12]), frame([12])];
  const times = [0.1, 0.3, 0.6, 0.8];
  const beats = beatChroma(frames, times, [0, 0.5, 1]);
  assert.equal(beats.length, 2);
  assert.equal(beats[0].treble[0], 1);
  assert.equal(beats[0].treble[4], 0);
  assert.equal(beats[1].treble[4], 1);
});

test('preferenza di tonalità: segue la tonica (trasporre la tonalità sposta la preferenza)', () => {
  const prior = [0, 1].map(() => [0, 1].map(() => Array.from({ length: 12 }, (_, k) => (k === 7 ? 1 : 0))));
  const inC = keyBonus({ tonic: 0, mode: 'major' }, prior, 0.5);
  const inD = keyBonus({ tonic: 2, mode: 'major' }, prior, 0.5);
  assert.equal(inC[7], 0.5);   // Sol maggiore in Do
  assert.equal(inD[9], 0.5);   // La maggiore in Re
  assert.equal(inD[7], 0);
  assert.equal(keyBonus(null, prior, 0.5).reduce((a, b) => a + b, 0), 0);
});

test('HMM: un battito isolato e incerto non spezza un accordo lungo', () => {
  const T = transitionMatrix({ stay: 0.8, toNone: 0.05, change: uniformChange });
  const score = (best, margin = 3) => Array.from({ length: CHORD_STATES }, (_, s) => (s === best ? margin : 0));
  // Otto battiti di Do maggiore con un battito in mezzo che preferisce di poco La minore.
  const scores = [0, 0, 0, 0, 21, 0, 0, 0].map((c, i) => score(c, i === 4 ? 0.5 : 3));
  const { path, posteriors } = decode(scores, T);
  assert.deepEqual(path, [0, 0, 0, 0, 0, 0, 0, 0]);
  for (const p of posteriors) assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('quote: tempo di ogni accordo dalle probabilità, senza "nessun accordo"', () => {
  const beats = [0, 1, 2, 3].map((i) => ({ start: i, end: i + 1 }));
  const one = (s) => Array.from({ length: CHORD_STATES }, (_, k) => (k === s ? 1 : 0));
  const shares = chordShares(beats, [one(7), one(7), one(0), one(NO_CHORD)]);
  assert.deepEqual(shares.map((x) => x.chord), [7, 0]);
  assert.equal(shares[0].share, 0.5);
  assert.equal(shares[1].share, 0.25);
});

test('catena completa: il giro Do–Sol–Lam–Fa dà quei quattro accordi', () => {
  const model = JSON.parse(readFileSync(new URL('../audio/chord-model.json', import.meta.url), 'utf8'));
  const SR = 22050;
  const bpm = 120;
  const beat = 60 / bpm;
  const progression = [[48, [60, 64, 67]], [43, [59, 62, 67]], [45, [60, 64, 69]], [41, [60, 65, 69]]]; // basso, accordo
  const seconds = 32;
  const audio = new Float32Array(seconds * SR);
  const hz = (m) => 440 * 2 ** ((m - 69) / 12);
  for (let bar = 0; bar < seconds / (4 * beat); bar++) {
    const [bass, chord] = progression[bar % 4];
    for (let b = 0; b < 4; b++) {
      const start = Math.round((bar * 4 + b) * beat * SR);
      for (let j = 0; j < beat * SR && start + j < audio.length; j++) {
        const t = j / SR;
        let v = 0;
        for (const m of [bass, ...chord]) for (let h = 1; h <= 4; h++) v += Math.sin(2 * Math.PI * hz(m) * h * t) / h ** 1.5;
        audio[start + j] = 0.06 * Math.min(1, j / 100) * Math.exp(-2 * t) * v;
      }
    }
  }
  const chroma = new ChromaAnalyzer({ sampleRate: SR, method: 'nnls', hop: 2048 });
  chroma.push(audio);
  const tuning = chroma.tuningCents();
  const frames = chroma.frames.map((r) => (r.log ? chroma.frameChroma(r, tuning) : { treble: new Float64Array(36), bass: new Float64Array(36) }));
  const times = frames.map((_, k) => (k * 2048 + 4096) / SR);
  const beatTimes = Array.from({ length: Math.floor(seconds / beat) }, (_, k) => k * beat);
  const beats = beatChroma(frames, times, beatTimes);
  const bonus = keyBonus({ tonic: 0, mode: 'major' }, model.keyPrior, model.keyWeight);
  const scores = chordScores(beats, model.emission, bonus).map((row) => row.map((x) => x / model.temperature));
  const { posteriors } = decode(scores, transitionMatrix(model.transitions));
  const shown = chordShares(beats, posteriors).filter((c) => c.share >= 0.1).map((c) => c.chord).sort((a, b) => a - b);
  assert.deepEqual(shown, [0, 5, 7, 21]); // Do, Fa, Sol, Lam
});
