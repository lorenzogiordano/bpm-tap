// Worker dell'ascolto: riceve i campioni del microfono, li porta a 22050 Hz, stima tempo
// e tonalità e manda aggiornamenti all'app. Gira fuori dal thread dell'interfaccia.
//
// Fasi: 'calibrating' (silenzio facoltativo: livello del rumore della stanza) → 'waiting'
// (si aspetta che parta la musica, così il rumore prima della canzone non entra
// nell'analisi) → 'listening'. Se la canzone sta già suonando si parte da 'listening'.
// Il rumore non viene filtrato: nelle prove la sottrazione spettrale non migliorava né
// tempo né tonalità. Il livello misurato serve a stimare quanto la musica lo supera.

import { Resampler } from './dsp.js';
import { RhythmAnalyzer, fitBeats } from './rhythm.js';
import { ChromaAnalyzer, fold, keyName } from './key.js';
import { tempoCandidates, chooseTempo } from './tempo-choice.js';
import { SKey, SKEY_RATE, DeepAverage } from './skey.js';
import { chromaBlocks, skeyBlocks, standardize, scoreKeys, softmax } from './key-features.js';
import { beatChroma, chordScores, transitionMatrix, decode, chordShares, keyBonus } from './chords.js';

const RATE = SKEY_RATE;             // 22050 Hz per tutte le analisi
const SKEY_WINDOW = 30;             // secondi di audio dati a S-KEY
const KEY_EVERY = 8;                // ogni quanti secondi aggiornare la tonalità
const CALIBRATION_SECONDS = 3;
const WAIT_LIMIT = 6;
const CHORD_HOP = 2048;             // 93 ms: cromagramma per gli accordi, più fitto di quello della tonalità
const CHORD_MIN_SECONDS = 10;               // se la musica non "parte" entro 6 s, si ascolta comunque
// Indizi che richiedono il cromagramma (se il modello non li usa, il cromagramma non si calcola).
const CHROMA_BLOCKS = new Set(['treble', 'bass', 'active', 'majtriad', 'mintriad', 'gbass']);
const needsChroma = () => Boolean(keyModel && keyModel.blocks.some((b) => CHROMA_BLOCKS.has(b)));

let state = null;
let skey = null;
let keyModel = null;
let chordModel = null;
let chordTransitions = null;

async function loadAssets() {
  if (skey && keyModel && chordModel) return;
  const [graph, model, chords] = await Promise.all([
    fetch(new URL('./skey-graph.json', import.meta.url)).then((r) => r.json()),
    fetch(new URL('./key-model.json', import.meta.url)).then((r) => r.json()),
    fetch(new URL('./chord-model.json', import.meta.url)).then((r) => r.json()),
  ]);
  skey = new SKey(graph);
  keyModel = model;
  chordModel = chords;
  chordTransitions = transitionMatrix(chords.transitions);
}

function start({ sampleRate, calibrate }) {
  state = {
    phase: calibrate ? 'calibrating' : 'listening',
    resampler: new Resampler(sampleRate, RATE),
    noisePower: 0,      // potenza media del silenzio iniziale (0 = non misurata)
    noiseSum: 0,
    noiseCount: 0,
    held: [],           // audio di calibrazione e attesa: se era già musica, si analizza
    heldLength: 0,
    musicSum: 0,        // potenza della musica durante l'ascolto
    musicCount: 0,
    loud: 0,
    rhythm: new RhythmAnalyzer({ sampleRate: RATE, beatSeconds: 180 }),
    chroma: new ChromaAnalyzer({ sampleRate: RATE, method: 'nnls' }),
    chordChroma: new ChromaAnalyzer({ sampleRate: RATE, method: 'nnls', hop: CHORD_HOP }),
    chordFrames: [],    // cromagramma NNLS di ogni frame (calcolato una volta)
    chordTuning: null,
    bpm: null,
    chords: null,
    recent: new Float32Array(SKEY_WINDOW * RATE), // ultimi 30 s di audio (buffer circolare)
    recentLength: 0,
    recentPos: 0,
    seconds: 0,         // secondi di musica analizzati
    phaseSeconds: 0,    // secondi nella fase corrente
    pending: 0,
    levelSum: 0,
    levelCount: 0,
    lastKeyAt: 0,
    key: null,
    deepAverage: new DeepAverage(), // profili interni di S-KEY su tutto l'ascoltato
    skeyUntil: 0,       // fin dove (secondi di musica) i profili sono già contati
    history: [],
  };
}

function rms(samples) {
  let s = 0;
  for (const v of samples) s += v * v;
  return Math.sqrt(s / Math.max(1, samples.length));
}

function remember(samples) {
  const { recent } = state;
  for (const v of samples) {
    recent[state.recentPos] = v;
    state.recentPos = (state.recentPos + 1) % recent.length;
    if (state.recentLength < recent.length) state.recentLength += 1;
  }
}

function recentAudio() {
  const { recent, recentLength, recentPos } = state;
  const out = new Float32Array(recentLength);
  const start = (recentPos - recentLength + recent.length) % recent.length;
  for (let i = 0; i < recentLength; i++) out[i] = recent[(start + i) % recent.length];
  return out;
}

function tempoUpdate() {
  const { rhythm } = state;
  const candidates = rhythm.seconds >= 4 ? tempoCandidates(rhythm) : null;
  const choice = chooseTempo(candidates);
  if (!choice) return null;
  const beats = rhythm.beats(choice.bpm);
  state.bpm = choice.bpm;
  state.beats = beats;
  const r = beats.length >= 8 ? fitBeats(beats, choice.bpm) : null;
  const fine = r && r.beats >= 8 && Math.abs(r.bpm / choice.bpm - 1) < 0.04;
  const bpm = fine ? r.bpm : choice.bpm;
  state.history.push(bpm);
  if (state.history.length > 6) state.history.shift();
  const stable = state.history.length >= 5 && state.history.every((v) => Math.abs(v / bpm - 1) < 0.01);
  return {
    bpm,
    halfWidth: fine ? r.halfWidth : Math.max(1, bpm * 0.02),
    beats: fine ? r.beats : beats.length,
    confidence: choice.confidence,
    stable,
  };
}

function keyUpdate() {
  if (!skey || !keyModel || state.recentLength < 5 * RATE) return state.key;
  const { chroma } = state;
  const frames = [];
  const tuning = needsChroma() ? chroma.tuningCents() : 0;
  for (const record of needsChroma() ? chroma.frames : []) {
    if (!record.peaks.length) continue;
    const c = chroma.frameChroma(record, tuning);
    const t = fold(c.treble, chroma.cfg.binsPerSemitone);
    const b = fold(c.bass, chroma.cfg.binsPerSemitone);
    const tm = Math.max(...t);
    if (!(tm > 0)) continue;
    const bm = Math.max(...b);
    frames.push({ t: t.map((v) => v / tm), b: bm > 0 ? b.map((v) => v / bm) : new Float64Array(12), tonal: record.tonal });
  }
  // S-KEY sugli ultimi 30 s. Nei primi 30 s la finestra copre tutto e vale l'ultimo
  // passaggio; dopo, si aggiungono solo i secondi nuovi, così i profili restano la media su
  // tutto l'ascoltato (come nell'allenamento, sul brano intero) a costo costante.
  const audio = recentAudio();
  const start = state.seconds - audio.length / RATE;
  const covering = start < 0.01;
  const run = skey.run(audio, { from: covering ? 0 : state.skeyUntil - start });
  state.deepAverage.add(run, covering);
  state.skeyUntil = state.seconds;
  state.key = keyFrom(run.p, state.deepAverage.deep, frames);
  return state.key;
}

// Tonalità dai profili di S-KEY (e dal cromagramma, se il modello lo usa).
function keyFrom(p, deep, frames = []) {
  const blocks = { ...chromaBlocks(frames, { gamma: keyModel.gamma }), ...skeyBlocks({ p, deep }) };
  const probs = softmax(scoreKeys(standardize(blocks, keyModel.blocks, keyModel.scales), keyModel.weights));
  const order = probs.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
  const asKey = (i) => ({ tonic: i % 12, mode: i < 12 ? 'major' : 'minor' });
  const best = asKey(order[0][1]);
  const second = asKey(order[1][1]);
  return {
    ...best,
    name: keyName(best),
    probability: order[0][0],
    alternative: keyName(second),
    alternativeKey: second,
    alternativeProbability: order[1][0],
  };
}

// ---------- File intero ----------

// Analisi di un brano completo (già a 22050 Hz, mono): tutto in una volta, più veloce del
// tempo reale, con l'avanzamento. S-KEY gira su finestre consecutive di 30 s, unite con
// DeepAverage come nell'ascolto.
async function analyzeFile(samples) {
  const progress = (fraction, stage) => self.postMessage({ type: 'progress', fraction, stage });
  progress(0, 'load');
  await loadAssets();
  start({ sampleRate: RATE, calibrate: false });
  const step = 5 * RATE;
  for (let i = 0; i < samples.length; i += step) {
    analyze(samples.subarray(i, i + step));
    progress(0.35 * Math.min(1, (i + step) / samples.length), 'rhythm');
    await new Promise((resolve) => setTimeout(resolve, 0)); // lascia passare i messaggi
  }
  const tempo = tempoUpdate();
  const avg = new DeepAverage();
  const span = SKEY_WINDOW * RATE;
  let run = null;
  for (let s = 0; s < samples.length; s += span) {
    const part = samples.subarray(s, Math.min(samples.length, s + span));
    if (part.length < 3 * RATE && run) break;
    run = skey.run(part);
    avg.add(run, s === 0);
    progress(0.35 + 0.45 * Math.min(1, (s + span) / samples.length), 'key');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  state.key = run ? keyFrom(run.p, avg.deep) : null;
  progress(0.85, 'chords');
  const chords = chordUpdate();
  progress(1, 'done');
  self.postMessage({ type: 'result', seconds: state.seconds, tempo, key: state.key, chords });
}

// Accordi: cromagramma per battito, punteggi con la tonalità come preferenza, HMM, e quota
// di tempo di ogni accordo su tutto l'ascoltato.
function chordUpdate() {
  if (!chordModel || !state.beats || state.seconds < CHORD_MIN_SECONDS) return state.chords;
  const { chordChroma } = state;
  // L'intonazione si stima una volta, dopo i primi secondi; poi ogni frame si calcola una volta sola.
  if (state.chordTuning === null) state.chordTuning = chordChroma.tuningCents();
  for (let k = state.chordFrames.length; k < chordChroma.frames.length; k++) {
    const record = chordChroma.frames[k];
    state.chordFrames.push(record.log ? chordChroma.frameChroma(record, state.chordTuning) : { treble: new Float64Array(36), bass: new Float64Array(36) });
  }
  const centre = chordChroma.cfg.frameSize / 2 / RATE;
  const times = state.chordFrames.map((_, k) => (k * CHORD_HOP) / RATE + centre);
  const beats = beatChroma(state.chordFrames, times, state.beats);
  if (beats.length < 8) return state.chords;
  const bonus = keyBonus(state.key, chordModel.keyPrior, chordModel.keyWeight);
  const t = chordModel.temperature || 1;
  const scores = chordScores(beats, chordModel.emission, bonus).map((row) => row.map((x) => x / t));
  const { posteriors } = decode(scores, chordTransitions);
  state.chords = { shares: chordShares(beats, posteriors).slice(0, 8), seconds: state.seconds };
  return state.chords;
}

// Quanto la musica supera il rumore della stanza (dB), se il silenzio è stato misurato.
function snr() {
  if (!state.noisePower || state.musicCount < 5 * RATE) return null;
  const music = state.musicSum / state.musicCount - state.noisePower;
  return music > 0 ? 10 * Math.log10(music / state.noisePower) : -Infinity;
}

function post(extra = {}) {
  const level = state.levelCount ? 10 * Math.log10(state.levelSum / state.levelCount + 1e-12) : -100;
  state.levelSum = 0;
  state.levelCount = 0;
  self.postMessage({ type: 'update', phase: state.phase, phaseSeconds: state.phaseSeconds, seconds: state.seconds, level, snr: snr(), ...extra });
}

function onSamples(samples) {
  for (const v of samples) state.levelSum += v * v;
  state.levelCount += samples.length;
  state.phaseSeconds += samples.length / RATE;

  if (state.phase === 'calibrating' || state.phase === 'waiting') {
    state.held.push(samples);
    state.heldLength += samples.length;
  }
  if (state.phase === 'calibrating') {
    for (const v of samples) state.noiseSum += v * v;
    state.noiseCount += samples.length;
    if (state.phaseSeconds >= CALIBRATION_SECONDS) {
      state.noisePower = Math.max(1e-12, state.noiseSum / state.noiseCount);
      state.phase = 'waiting';
      state.phaseSeconds = 0;
    }
    return;
  }
  if (state.phase === 'waiting') {
    // La musica è partita quando il livello resta ~10 dB sopra il rumore per mezzo secondo.
    // Se non succede (la canzone suonava già durante il "silenzio"), si parte comunque.
    state.loud = rms(samples) > 3 * Math.sqrt(state.noisePower) ? state.loud + samples.length : 0;
    if (state.loud < RATE / 2 && state.phaseSeconds < WAIT_LIMIT) return;
    // Partita la musica: si analizza da dove è cominciata. Mai partita: il "silenzio" era
    // già la canzone, quindi la misura del rumore non vale e si analizza tutto l'ascoltato.
    const started = state.loud >= RATE / 2;
    if (!started) state.noisePower = 0;
    let skip = started ? state.heldLength - state.loud : 0;
    const held = state.held;
    state.held = [];
    state.heldLength = 0;
    state.phase = 'listening';
    state.phaseSeconds = 0;
    for (const chunk of held) {
      if (skip >= chunk.length) { skip -= chunk.length; continue; }
      analyze(skip > 0 ? chunk.subarray(skip) : chunk);
      skip = 0;
    }
    return;
  }
  analyze(samples);
}

function analyze(samples) {
  for (const v of samples) state.musicSum += v * v;
  state.musicCount += samples.length;
  state.rhythm.push(samples);
  if (!keyModel || needsChroma()) state.chroma.push(samples);
  state.chordChroma.push(samples);
  remember(samples);
  state.seconds += samples.length / RATE;
}

self.onmessage = async ({ data }) => {
  if (data.type === 'file') {
    analyzeFile(data.samples).catch((error) => self.postMessage({ type: 'error', message: String(error.stack || error) }));
    return;
  }
  if (data.type === 'start') {
    start(data);
    loadAssets().catch((error) => self.postMessage({ type: 'error', message: String(error) }));
    return;
  }
  if (data.type === 'skip-calibration' && state) {
    // La canzone stava già suonando: niente misura del rumore, e quello ascoltato finora
    // (era già la canzone) entra nell'analisi.
    const held = state.phase === 'listening' ? [] : state.held;
    state.phase = 'listening';
    state.phaseSeconds = 0;
    state.noisePower = 0;
    state.held = [];
    state.heldLength = 0;
    for (const chunk of held) analyze(chunk);
    return;
  }
  if (data.type !== 'pcm' || !state) return;
  const samples = Float32Array.from(state.resampler.process(data.samples));
  onSamples(samples);
  state.pending += samples.length;
  if (state.pending < RATE) return;
  state.pending -= RATE;
  if (state.phase !== 'listening') { post(); return; }
  const tempo = tempoUpdate();
  let key = state.key;
  if (state.seconds - state.lastKeyAt >= KEY_EVERY || (!key && state.seconds >= 6)) {
    state.lastKeyAt = state.seconds;
    key = keyUpdate();
    chordUpdate();
  }
  post({ tempo, key, chords: state.chords });
};
