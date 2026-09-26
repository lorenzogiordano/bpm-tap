import { TempoEstimator, DEFAULTS, formatBpm, formatHalfWidth, quality } from './tempo.js';
import { TapDetector, REJECT_REASONS } from './detector.js';
import { KnockDetector, KNOCK_REJECT_REASONS } from './knock.js';
import { MacMotion, servedByHelper } from './mac-motion.js';
import { analyzeFile, FILE_ACCEPT } from './file-analysis.js';
import { Listener } from './listen.js';
import { Metronome, playCadence, playChord, playProgression, stopCadence, releaseAudioSession } from './sound.js';
import { chordName } from './chord-names.js';
import { renderStructurePanel, renderHistoryStructure, renderGroups, toggleExpanded, compactStructure, expandStructure, progressionToPlay, orderByLoop } from './structure-view.js';

const $ = (id) => document.getElementById(id);
const els = {
  pad: $('pad'),
  bpmInt: $('bpmInt'),
  bpmDec: $('bpmDec'),
  plusMinus: $('plusMinus'),
  tapCount: $('tapCount'),
  qualityFill: $('qualityFill'),
  qualityLabel: $('qualityLabel'),
  status: $('status'),
  timerArc: $('timerArc'),
  pulse: $('pulse'),
  halfBtn: $('halfBtn'),
  doubleBtn: $('doubleBtn'),
  resetBtn: $('resetBtn'),
  modeButtons: [...document.querySelectorAll('[data-mode]')],
  sensorToggle: $('sensorToggle'),
  sensorPanel: $('sensorPanel'),
  sensorRate: $('sensorRate'),
  scope: $('scope'),
  sensitivity: $('sensitivity'),
  sensitivityOut: $('sensitivityOut'),
  lastHit: $('lastHit'),
  exportData: $('exportData'),
  historyList: $('historyList'),
  historyEmpty: $('historyEmpty'),
  clearHistory: $('clearHistory'),
  startSheet: $('startSheet'),
  sheetTitle: $('sheetTitle'),
  enableSensor: $('enableSensor'),
  useScreen: $('useScreen'),
  useListen: $('useListen'),
  sensorError: $('sensorError'),
  keyLine: $('keyLine'),
  keyName: $('keyName'),
  keyAlt: $('keyAlt'),
  listenControls: $('listenControls'),
  levelFill: $('levelFill'),
  listenBtn: $('listenBtn'),
  listenError: $('listenError'),
  skipCalibration: $('skipCalibration'),
  keyCheck: $('keyCheck'),
  keyCheckStatus: $('keyCheckStatus'),
  keyCheckButtons: [...document.querySelectorAll('[data-check]')],
  metroBtn: $('metroBtn'),
  chordLine: $('chordLine'),
  fileBtn: $('fileBtn'),
  fileInput: $('fileInput'),
  dropOverlay: $('dropOverlay'),
  chordChips: $('chordChips'),
  structure: {
    panel: $('structurePanel'),
    meta: $('structureMeta'),
    timeline: $('structureTimeline'),
    whole: $('structureWhole'),
    groups: $('structureGroups'),
    note: $('structureNote'),
  },
};

// Dopo un tocco sullo schermo si ignorano i colpi letti dal sensore per un
// attimo: toccare lo schermo scuote il telefono (Quick Tap fa lo stesso).
const TOUCH_GUARD_MS = 200;
const SCOPE_SAMPLES = 240;   // ~4 s a 60 Hz
const EXPORT_SAMPLES = 1200; // ~20 s a 60 Hz

// ---------- Archivio locale ----------

const KEYS = {
  history: 'bpmtap.history',
  mode: 'bpmtap.mode',
  sensitivity: 'bpmtap.sensitivity.v2',
  macSensitivity: 'bpmtap.sensitivity.mac',
  onboarded: 'bpmtap.onboarded',
};

const store = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Archivio non disponibile (navigazione privata): l'app funziona lo stesso.
    }
  },
};

let history = store.get(KEYS.history, []);
const saveHistory = () => store.set(KEYS.history, history);

// ---------- Stato ----------

// Il sensore di movimento c'è su telefoni e tablet. Sui computer i browser non lo
// espongono: sui MacBook lo legge il programma mac/bpm-knock.py (modalità "Bussa"), su
// Windows e Linux la modalità non si mostra.
function hasMotionSensor() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod|Android/i.test(ua) || navigator.userAgentData?.mobile) return true;
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1; // iPadOS si presenta come Mac
}
const MOTION = hasMotionSensor();
const DESKTOP = matchMedia('(hover: hover) and (pointer: fine)').matches && !MOTION;
const MAC = !MOTION && (/Macintosh/.test(navigator.userAgent) || navigator.userAgentData?.platform === 'macOS');
const KNOCK_SAMPLES = 16000; // ~20 s a 800 Hz per l'esportazione

const state = {
  mode: store.get(KEYS.mode, MOTION || servedByHelper() ? 'back' : 'screen'), // back | screen | listen
  phase: 'idle',                      // idle | tapping | listening | locked
  multiplier: 1,
  source: null,
  lockedResult: null,
  savedId: null,
  outcome: null,                      // saved | too-few
  sensorOn: false,
  lastTouch: -Infinity,
  listen: null,                       // ultimo aggiornamento dell'ascolto
  lockedKey: null,
};

const estimator = new TempoEstimator();
// Metronomo per sentire i BPM trovati (la misura appena fatta o una salvata).
const metronome = new Metronome({ onBeat: () => flash(true) });
let metronomeStoppedAt = -Infinity;

function stopMetronome() {
  if (!metronome.playing) return;
  metronome.stop();
  metronomeStoppedAt = performance.now();
  renderMetronome();
}
const detector = new TapDetector({ sensitivity: store.get(KEYS.sensitivity, 5) });
const knockDetector = new KnockDetector({ sensitivity: store.get(KEYS.macSensitivity, 5) });
let endTimer = null;

// I timestamp degli eventi sono sulla stessa scala di performance.now();
// alcuni browser vecchi usano ancora l'epoca Unix.
function eventTime(event) {
  const ts = event.timeStamp;
  if (!ts) return performance.now();
  return ts > 1e12 ? ts - performance.timeOrigin : ts;
}

// ---------- Sessione di misura ----------

function beginSession(source) {
  stopMetronome();
  estimator.reset();
  Object.assign(state, {
    phase: 'tapping', multiplier: 1, source, lockedResult: null, savedId: null, outcome: null,
  });
}

function onTap(time, source) {
  if (state.phase === 'tapping' && estimator.isExpired(time)) finalize();
  if (state.phase !== 'tapping') beginSession(source);

  const { status } = estimator.addTap(time);
  flash(status !== 'rejected');
  scheduleEnd();
  render();
  ensureLoop();
}

function scheduleEnd() {
  clearTimeout(endTimer);
  const remaining = estimator.lastActivity + estimator.timeoutMs() - performance.now();
  endTimer = setTimeout(finalize, Math.max(0, remaining) + 30);
}

// Fine della sessione: il valore resta a schermo e, se valido, si salva.
function finalize() {
  clearTimeout(endTimer);
  if (state.phase !== 'tapping') return;
  const result = estimator.result();
  state.phase = 'locked';
  state.lockedResult = result;
  if (result && result.valid) {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      bpm: result.bpm * state.multiplier,
      halfWidth: result.halfWidth * state.multiplier,
      taps: result.taps,
      source: state.source,
      createdAt: Date.now(),
      name: '',
    };
    history.unshift(entry);
    saveHistory();
    state.savedId = entry.id;
    state.outcome = 'saved';
  } else {
    state.outcome = 'too-few';
  }
  render();
  renderHistory();
}

function newMeasure() {
  stopMetronome();
  if (state.phase === 'analyzing') cancelFileAnalysis();
  if (state.phase === 'tapping') finalize();
  if (state.phase === 'listening') listener.stop();
  estimator.reset();
  Object.assign(state, { phase: 'idle', multiplier: 1, lockedResult: null, savedId: null, outcome: null, lockedKey: null, lockedChords: null, lockedStructure: null, listen: null });
  render();
}

// ---------- Ascolto dal microfono ----------

const listener = new Listener({
  onUpdate(update) {
    state.listen = update;
    render();
  },
  onEnd() {
    finalizeListen();
  },
});

function listenResult() {
  if (state.listen?.phase && state.listen.phase !== 'listening') return null;
  const t = state.listen?.tempo;
  if (!t) return null;
  return { bpm: t.bpm, halfWidth: t.halfWidth, taps: t.beats, valid: t.stable };
}

async function toggleListening() {
  if (state.phase === 'analyzing') {
    cancelFileAnalysis();
    return;
  }
  if (state.phase === 'listening') {
    listener.stop();
    return;
  }
  els.listenError.hidden = true;
  stopMetronome();
  releaseAudioSession(); // il microfono ha bisogno della sessione audio "registra e suona"
  Object.assign(state, {
    phase: 'listening', multiplier: 1, source: 'listen', listen: null, lockedResult: null, lockedKey: null, lockedChords: null, lockedStructure: null, savedId: null, outcome: null,
  });
  render();
  try {
    await listener.start({ calibrate: true });
    requestWakeLock();
  } catch (error) {
    state.phase = 'idle';
    showListenError(error);
    render();
  }
}

function showListenError(error) {
  const name = error?.name || error?.message;
  const messages = {
    NotAllowedError: 'Permesso del microfono negato. Su iPhone: Impostazioni › Safari › Microfono, oppure riapri l\'app e consenti.',
    NotFoundError: 'Nessun microfono disponibile.',
    NotReadableError: 'Il microfono è occupato da un\'altra app (per esempio una chiamata).',
    unsupported: 'Questo browser non permette di ascoltare dal microfono.',
  };
  els.listenError.textContent = messages[name] || `Impossibile ascoltare (${name}).`;
  els.listenError.hidden = false;
}

// Fine dell'ascolto: BPM e tonalità restano a schermo e, se affidabili, si salvano.
function finalizeListen() {
  if (state.phase !== 'listening') return;
  const ready = !state.listen?.phase || state.listen.phase === 'listening';
  saveAnalysis(ready ? state.listen : null, 'listen');
}

// Fine di un'analisi (ascolto o file): BPM, tonalità e accordi restano a schermo e, se
// affidabili, si salvano.
function saveAnalysis(update, source, name = '') {
  const t = update?.tempo;
  const result = t ? { bpm: t.bpm, halfWidth: t.halfWidth, taps: t.beats, valid: source === 'file' || t.stable } : null;
  const key = update?.key || null;
  const structure = update?.structure?.shown ? update.structure : null;
  Object.assign(state, { phase: 'locked', source, lockedResult: result, lockedKey: key, lockedChords: orderByLoop(shownChords(update?.chords), structure), lockedStructure: structure });
  if (result && result.taps >= 8) {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      bpm: result.bpm * state.multiplier,
      halfWidth: result.halfWidth * state.multiplier,
      taps: result.taps,
      source,
      key: key && { tonic: key.tonic, mode: key.mode, name: key.name, alternative: key.alternative || null, probability: key.probability ?? null },
      chords: state.lockedChords.length ? state.lockedChords : undefined,
      structure: compactStructure(structure),
      createdAt: Date.now(),
      name,
    };
    history.unshift(entry);
    saveHistory();
    state.savedId = entry.id;
    state.outcome = 'saved';
  } else {
    state.outcome = 'too-few';
  }
  render();
  renderHistory();
}

// ---------- File audio ----------

let fileJob = null;
const FILE_STAGES = { decode: 'lettura del file', load: 'preparazione', rhythm: 'tempo e battiti', key: 'tonalità', chords: 'accordi', structure: 'struttura', done: 'fatto' };

function startFileAnalysis(file) {
  if (!file) return;
  stopMetronome();
  if (state.phase === 'tapping') finalize();
  if (state.phase === 'listening') listener.stop();
  if (state.mode !== 'listen') setMode('listen');
  fileJob?.cancel();
  const name = file.name.replace(/\.[^.]+$/, '');
  els.listenError.hidden = true;
  Object.assign(state, {
    phase: 'analyzing', multiplier: 1, source: 'file', listen: null, lockedResult: null, lockedKey: null, lockedChords: null, lockedStructure: null,
    savedId: null, outcome: null, fileName: name, fileProgress: 0, fileStage: 'decode',
  });
  render();
  let job = null;
  job = analyzeFile(file, {
    onProgress(fraction, stage) {
      if (job && fileJob !== job) return; // la prima chiamata arriva prima dell'assegnazione
      state.fileProgress = fraction;
      state.fileStage = stage;
      render();
    },
  });
  fileJob = job;
  job.promise.then((result) => {
    if (fileJob !== job) return;
    fileJob = null;
    state.listen = { phase: 'listening', ...result };
    saveAnalysis(state.listen, 'file', name);
  }).catch((error) => {
    if (fileJob !== job) return;
    fileJob = null;
    state.phase = 'idle';
    const messages = {
      decode: 'Non riesco a leggere questo file: il browser non ne supporta il formato. Prova con MP3, M4A (AAC) o WAV.',
      'too-long': 'Il file è troppo lungo: al massimo 15 minuti.',
      unsupported: 'Questo browser non sa decodificare file audio.',
    };
    els.listenError.textContent = messages[error.message] || `Analisi non riuscita (${error.message}).`;
    els.listenError.hidden = false;
    render();
  });
}

function cancelFileAnalysis() {
  fileJob?.cancel();
  fileJob = null;
  if (state.phase === 'analyzing') state.phase = 'idle';
  render();
}

// ×2 / ÷2: vale per la misura in corso e per quella appena salvata.
function scale(factor) {
  state.multiplier *= factor;
  if (metronome.owner === 'main') metronome.setBpm(metronome.bpm * factor);
  const entry = state.phase === 'locked' && history.find((e) => e.id === state.savedId);
  if (entry) {
    entry.bpm *= factor;
    entry.halfWidth *= factor;
    saveHistory();
    renderHistory();
  }
  render();
}

// ---------- Resa grafica ----------

function currentResult() {
  if (state.phase === 'tapping') return estimator.result();
  if (state.phase === 'listening') return listenResult();
  if (state.phase === 'locked') return state.lockedResult;
  return null;
}

function render() {
  const result = currentResult();
  const m = state.multiplier;

  const listening = state.phase === 'listening';
  const analyzing = state.phase === 'analyzing';
  let visual = listening ? 'tapping' : analyzing ? 'rough' : state.phase;
  if ((state.phase === 'tapping' || listening) && (!result || !result.valid)) visual = 'rough';
  els.pad.dataset.state = visual;
  els.pad.dataset.listening = String(listening || analyzing);
  const unit = ['listen', 'file'].includes(state.phase === 'locked' ? state.source : state.mode) || state.mode === 'listen' ? 'battiti' : 'tap';

  if (result) {
    const bpm = result.bpm * m;
    const hw = result.halfWidth * m;
    const { int, dec } = formatBpm(bpm, hw);
    els.bpmInt.textContent = int;
    els.bpmDec.textContent = dec;
    els.plusMinus.textContent = `${formatHalfWidth(hw)} BPM`;
    els.tapCount.textContent = `${result.taps} ${unit}`;
    const q = quality({ ...result, halfWidth: hw });
    els.qualityFill.style.transform = `scaleX(${q.level})`;
    els.qualityLabel.textContent = listening && !result.valid ? 'Si sta stabilizzando…' : q.label;
  } else {
    els.bpmInt.textContent = '—';
    els.bpmDec.textContent = '';
    els.plusMinus.textContent = '';
    els.tapCount.textContent = state.phase === 'tapping' ? '1 tap' : '';
    els.qualityFill.style.transform = 'scaleX(0)';
    els.qualityLabel.textContent = state.phase === 'tapping' ? 'Continua a battere…' : listening ? 'In ascolto…' : analyzing ? 'Analisi del file…' : '';
  }
  renderListen();
  renderChords();
  renderStructure();
  renderMetronome();

  els.status.textContent = statusText(result);
  els.halfBtn.disabled = els.doubleBtn.disabled = !result;
  els.resetBtn.disabled = state.phase === 'idle';
  if (analyzing) {
    // L'anello mostra l'avanzamento dell'analisi del file.
    els.timerArc.style.strokeDashoffset = String(1 - (state.fileProgress || 0));
    els.timerArc.style.opacity = '1';
  } else if (state.phase !== 'tapping') {
    els.timerArc.style.removeProperty('stroke-dashoffset');
    els.timerArc.style.removeProperty('opacity');
  }
}

// Metronomo sulla misura appena fatta: si ascolta sopra la canzone per capire se il
// valore è giusto o va dimezzato/raddoppiato.
function renderMetronome() {
  const result = state.phase === 'locked' ? state.lockedResult : null;
  els.metroBtn.hidden = !result;
  const on = metronome.owner === 'main';
  els.metroBtn.textContent = on ? '■ Ferma il metronomo' : '▶ Senti i BPM';
  els.metroBtn.setAttribute('aria-pressed', String(on));
  for (const button of els.historyList.querySelectorAll('[data-action="metro"]')) {
    const playing = metronome.owner === button.closest('.history-item').dataset.id;
    button.textContent = playing ? '■' : '▶';
    button.setAttribute('aria-pressed', String(playing));
  }
}

function toggleMainMetronome() {
  if (metronome.owner === 'main') { stopMetronome(); return; }
  const result = state.lockedResult;
  if (!result) return;
  metronome.start(result.bpm * state.multiplier, 'main');
  renderMetronome();
}

// Tonalità, livello del microfono e pulsante dell'ascolto.
function renderListen() {
  const inListen = state.mode === 'listen';
  els.listenControls.hidden = !inListen;
  const key = state.phase === 'listening' ? state.listen?.key : state.phase === 'locked' ? state.lockedKey : null;
  els.keyLine.hidden = !key;
  if (key) {
    els.keyName.textContent = key.confirmed ? `${key.name} ✓` : key.name;
    els.keyAlt.textContent = key.confirmed ? 'scelta a orecchio' : keyDetail(key);
  }
  const phase = state.listen?.phase;
  els.skipCalibration.hidden = !(state.phase === 'listening' && (!state.listen || phase === 'calibrating' || phase === 'waiting'));
  renderKeyCheck();
  if (!inListen) return;
  els.listenBtn.textContent = state.phase === 'listening' ? 'Ferma e salva' : state.phase === 'analyzing' ? 'Annulla l\'analisi' : 'Inizia ad ascoltare';
  els.fileBtn.hidden = state.phase === 'listening' || state.phase === 'analyzing';
  const level = state.phase === 'listening' && state.listen ? state.listen.level : -100;
  const fill = Math.min(1, Math.max(0, (level + 60) / 50)); // −60 dB → vuoto, −10 dB → pieno
  els.levelFill.style.transform = `scaleX(${fill})`;
}

// ---------- Accordi ----------

// Si mostrano solo gli accordi che occupano almeno il 10% del tempo ascoltato, dopo almeno
// 20 s: nelle prove (brani mai visti, anche dal microfono) sono nella canzone ~9 volte su 10.
const CHORD_MIN_SHARE = 0.1;
const CHORD_MIN_SECONDS = 20;
function shownChords(chords) {
  if (!chords || chords.seconds < CHORD_MIN_SECONDS) return [];
  return chords.shares.filter((c) => c.share >= CHORD_MIN_SHARE).map((c) => c.chord);
}

function chordChip(label, key, playable) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chord-chip';
  button.dataset.chord = String(label);
  button.textContent = chordName(label, key);
  button.disabled = !playable;
  button.setAttribute('aria-label', `${chordName(label, key)}: ascolta l'accordo`);
  return button;
}

function renderChords() {
  const listening = state.phase === 'listening';
  const labels = listening ? orderByLoop(shownChords(state.listen?.chords), state.listen?.structure) : state.phase === 'locked' ? state.lockedChords || [] : [];
  const key = listening ? state.listen?.key : state.lockedKey;
  els.chordLine.hidden = labels.length === 0;
  // Durante l'ascolto non si suonano: il microfono li sentirebbe.
  els.chordChips.replaceChildren(...labels.map((label) => chordChip(label, key, !listening)));
}

// ---------- Struttura e giri ----------

// Durante l'ascolto la struttura si aggiorna (se l'ascolto è lungo e pulito); a misura finita
// resta a schermo e i giri si possono ascoltare.
function currentStructure() {
  if (state.phase === 'listening') return state.listen?.structure?.shown ? state.listen.structure : null;
  if (state.phase === 'locked') return state.lockedStructure || null;
  return null;
}

function renderStructure() {
  const listening = state.phase === 'listening';
  const key = listening ? state.listen?.key : state.lockedKey;
  renderStructurePanel(els.structure, currentStructure(), key, { playable: !listening });
}

// Suona il giro di una lettera (o la proposta di un giro noto) al tempo della canzone.
function playSection(structure, letter, bpm, alternative = false) {
  const chords = progressionToPlay(structure, letter, { alternative });
  if (!chords.length) return;
  stopMetronome();
  playProgression(chords, bpm);
}

els.structure.panel.addEventListener('click', (event) => {
  const expand = event.target.closest('[data-expand]');
  if (expand) {
    const st = currentStructure();
    if (st) { toggleExpanded(st, expand.dataset.expand); renderStructure(); }
    return;
  }
  const target = event.target.closest('[data-play]');
  if (!target || state.phase !== 'locked' || !state.lockedStructure) return;
  const bpm = (state.lockedResult?.bpm || 100) * state.multiplier;
  playSection(state.lockedStructure, target.dataset.play, bpm, target.dataset.alternative === '1');
});

// Affidabilità della tonalità: la probabilità del modello, e l'alternativa quando è vicina.
// Soglie tarate su brani mai visti ascoltati dal microfono (lab/key-app-eval.mjs):
// p ≥ 0,8 → giusta nell'82–95% dei casi; 0,5–0,8 → circa 2 su 3; sotto 0,5 → 1 su 3 o 1 su 2.
function keyDetail(key) {
  if (!key.probability) return key.alternative ? `oppure ${key.alternative}` : '';
  const p = key.probability;
  const label = p >= 0.8 ? 'sicura' : p >= 0.5 ? 'probabile' : 'incerta';
  const close = key.alternativeProbability >= 0.5 * p || p < 0.5;
  return close ? `${label} · oppure ${key.alternative}` : label;
}

// ---------- Verifica a orecchio della tonalità ----------

function renderKeyCheck() {
  const key = state.phase === 'locked' && ['listen', 'file'].includes(state.source) ? state.lockedKey : null;
  const show = Boolean(key && key.alternativeKey);
  els.keyCheck.hidden = !show;
  if (!show) return;
  const options = [{ tonic: key.tonic, mode: key.mode, name: key.name }, { ...key.alternativeKey, name: key.alternative }];
  els.keyCheckButtons.forEach((button, i) => {
    button.textContent = `▶ ${options[i].name}`;
    button.setAttribute('aria-pressed', String(Boolean(key.confirmed) && key.tonic === options[i].tonic && key.mode === options[i].mode));
  });
}

function chooseKey(index) {
  const key = state.lockedKey;
  if (!key) return;
  const options = [{ tonic: key.tonic, mode: key.mode, name: key.name }, { ...key.alternativeKey, name: key.alternative }];
  const chosen = options[index];
  stopMetronome();
  playCadence(chosen);
  const other = options[1 - index];
  state.lockedKey = { ...key, ...chosen, alternative: other.name, alternativeKey: { tonic: other.tonic, mode: other.mode }, confirmed: true };
  const entry = history.find((e) => e.id === state.savedId);
  if (entry) {
    entry.key = { tonic: chosen.tonic, mode: chosen.mode, name: chosen.name, alternative: other.name, confirmed: true };
    saveHistory();
    renderHistory();
  }
  els.keyCheckStatus.textContent = `Cadenza di ${chosen.name}. Se torna "a casa" con la canzone, tienila; altrimenti ascolta l'altra.`;
  render();
}

function statusText(result) {
  if (state.phase === 'analyzing') {
    const pct = Math.round(100 * (state.fileProgress || 0));
    return `Analizzo «${state.fileName}»: ${FILE_STAGES[state.fileStage] || ''}… ${pct}%`;
  }
  if (state.phase === 'locked' && state.source === 'file') {
    return state.outcome === 'saved'
      ? `«${state.fileName}» analizzato e salvato.`
      : 'Non ho trovato abbastanza ritmo in questo file per salvare la misura.';
  }
  if (state.phase === 'listening') {
    const phase = state.listen?.phase;
    if (!state.listen || phase === 'calibrating') {
      const left = Math.max(1, Math.ceil(3 - (state.listen?.phaseSeconds || 0)));
      return `Se puoi, lascia ${left} ${left === 1 ? 'secondo' : 'secondi'} di silenzio: misuro il rumore della stanza.`;
    }
    if (phase === 'waiting') return 'Ora fai partire la canzone.';
    const seconds = Math.round(state.listen?.seconds || 0);
    if (seconds < 3) return 'In ascolto…';
    // Rumore della stanza misurato nel silenzio iniziale: se copre la musica, meglio avvicinarsi.
    const snr = state.listen?.snr;
    if (snr != null && snr < 10) return `In ascolto da ${seconds} s. C'è molto rumore rispetto alla musica: avvicina il telefono alla cassa.`;
    return result && result.valid
      ? `In ascolto da ${seconds} s. Il valore è stabile: puoi fermare quando vuoi.`
      : `In ascolto da ${seconds} s…`;
  }
  if (state.phase === 'locked' && state.source === 'listen') {
    return state.outcome === 'saved'
      ? 'Salvato. Tocca «Inizia ad ascoltare» per un\'altra canzone.'
      : 'Non ho sentito abbastanza ritmo per salvare la misura.';
  }
  if (state.mode === 'listen') {
    return DESKTOP
      ? 'Fai suonare la canzone, anche da questo computer, e premi «Inizia ad ascoltare» (o Spazio). Oppure trascina qui un file audio.'
      : 'Fai suonare la canzone da un altro dispositivo (cassa, computer), tieni il telefono vicino alla cassa e tocca «Inizia ad ascoltare».';
  }
  if (state.phase === 'locked') {
    return state.outcome === 'saved'
      ? 'Salvato. Batti di nuovo per una nuova misura.'
      : `Servono almeno ${DEFAULTS.minTaps} tap per salvare la misura.`;
  }
  if (state.phase === 'tapping') {
    return result && result.valid
      ? 'Più tap fai, più il valore è preciso. Fermati per salvare.'
      : 'Continua a battere a tempo…';
  }
  if (state.mode === 'screen') {
    return DESKTOP ? 'Premi la barra spaziatrice (o clicca qui) a tempo con la canzone.' : 'Batti qui sopra a tempo con la canzone.';
  }
  return state.sensorOn
    ? (MAC ? 'Bussa sul Mac a tempo con la canzone.' : 'Batti sul retro a tempo con la canzone.')
    : (MAC ? 'Avvia il programma del sensore per bussare sul Mac.' : 'Attiva il sensore per battere sul retro.');
}

function flash(accepted) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  els.pulse.classList.toggle('rejected', !accepted);
  els.pulse.animate(
    [
      { opacity: 1, transform: 'scale(0.85)' },
      { opacity: 0, transform: 'scale(1.15)' },
    ],
    { duration: 280, easing: 'ease-out' },
  );
}

// ---------- Ciclo di animazione: anello del salvataggio e grafico del sensore ----------

let loopRunning = false;

function ensureLoop() {
  if (loopRunning) return;
  loopRunning = true;
  requestAnimationFrame(frame);
}

function frame() {
  const tapping = state.phase === 'tapping';
  const scopeOpen = !els.sensorPanel.hidden;
  if (tapping) updateTimerRing();
  if (scopeOpen) drawScope();
  if (tapping || scopeOpen) requestAnimationFrame(frame);
  else loopRunning = false;
}

// L'anello si riempie solo quando il battito atteso non arriva: mostra quanto
// manca al salvataggio automatico senza agitarsi a ogni tap.
function updateTimerRing() {
  const period = estimator.currentPeriod();
  if (period === null) return;
  const elapsed = performance.now() - estimator.lastActivity;
  const timeout = estimator.timeoutMs();
  const progress = Math.min(1, Math.max(0, (elapsed - period) / (timeout - period)));
  els.timerArc.style.strokeDashoffset = String(1 - progress);
  els.timerArc.style.opacity = progress > 0 ? '1' : '0';
}

// ---------- Sensore di movimento ----------

const motion = {
  count: 0,
  times: [],
  scope: [],
  raw: [],
};

function onMotion(event) {
  const t = eventTime(event);
  const a = event.acceleration;
  const g = event.accelerationIncludingGravity;
  // Senza giroscopio WebKit manda acceleration = (0, 0, 0): si usa quella con gravità.
  const useGravity = !a || a.z == null || (a.x === 0 && a.y === 0 && a.z === 0);
  const src = useGravity ? g : a;
  if (!src || src.z == null) return;
  const r = event.rotationRate;
  const rot = r && r.alpha != null ? Math.hypot(r.alpha, r.beta, r.gamma) : null;

  motion.count += 1;
  motion.times.push(t);
  if (motion.times.length > 61) motion.times.shift();

  const hit = detector.push(t, src.x ?? 0, src.y ?? 0, src.z, rot);
  motion.scope.push({ s: detector.score, thr: detector.threshold, mark: null });
  if (motion.scope.length > SCOPE_SAMPLES) motion.scope.shift();

  // Toccare lo schermo o il metronomo (l'altoparlante fa vibrare il telefono) non sono tap.
  const tap = hit && state.mode === 'back'
    ? reportHit(hit, t, metronome.playing || performance.now() - metronomeStoppedAt < 300) : null;

  motion.raw.push([t, src.x, src.y, src.z, r?.alpha, r?.beta, r?.gamma, tap]
    .map((v) => (typeof v === 'number' ? Math.round(v * 10000) / 10000 : v ?? null)));
  if (motion.raw.length > EXPORT_SAMPLES) motion.raw.shift();

  if (tap !== null) onTap(tap, 'back');
}

// Esito di un colpo (sensore del telefono o del Mac): segno nel grafico, riga nel pannello,
// e l'istante del tap se conta.
function reportHit(hit, t, busy = false) {
  const touched = t - state.lastTouch <= TOUCH_GUARD_MS || busy;
  const ok = hit.ok && !touched;
  // L'esito arriva qualche istante dopo il picco: il segno va sul punto giusto (grafico a ~60 Hz).
  const back = Math.round((t - hit.time) / (1000 / 60));
  const mark = motion.scope[Math.max(0, motion.scope.length - 1 - back)];
  if (mark) mark.mark = ok ? 'tap' : 'rejected';
  showLastHit(hit, touched);
  return ok ? hit.time : null;
}

// ---------- Sensore del MacBook (programma mac/bpm-knock.py) ----------

let knockScope = { n: 0, s: 0 };

function onKnockSample(t, x, y, z) {
  motion.count += 1;
  motion.times.push(t);
  if (motion.times.length > 401) motion.times.shift();
  const hit = knockDetector.push(t, x, y, z);
  // Grafico a ~60 Hz: il massimo di ogni gruppo di 13 campioni.
  knockScope.s = Math.max(knockScope.s, knockDetector.score);
  if (++knockScope.n >= 13) {
    motion.scope.push({ s: knockScope.s, thr: knockDetector.threshold, mark: null });
    if (motion.scope.length > SCOPE_SAMPLES) motion.scope.shift();
    knockScope = { n: 0, s: 0 };
  }
  // Gli altoparlanti del Mac non muovono il sensore: qui il metronomo non disturba.
  const tap = hit && state.mode === 'back' ? reportHit(hit, t) : null;
  motion.raw.push([Math.round(t * 100) / 100, x, y, z, tap]);
  if (motion.raw.length > KNOCK_SAMPLES) motion.raw.shift();
  if (tap !== null) onTap(tap, 'knock');
}

const macMotion = new MacMotion({
  onSample: onKnockSample,
  onLost() {
    state.sensorOn = false;
    if (state.phase === 'tapping') finalize();
    if (state.mode === 'back') {
      showStartSheet();
      showSensorError('mac-lost');
    }
    render();
  },
});

async function startMacSensor() {
  els.sensorError.hidden = true;
  if (!(await macMotion.connect())) {
    showSensorError(servedByHelper() ? 'mac-lost' : 'mac-missing');
    return;
  }
  knockDetector.reset();
  state.sensorOn = true;
  els.startSheet.hidden = true;
  store.set(KEYS.onboarded, true);
  render();
}

// Nel pannello del sensore: forza dell'ultimo colpo e, se scartato, il perché.
function showLastHit(hit, touched) {
  if (els.sensorPanel.hidden) return;
  const strength = hit.strength.toFixed(MAC ? 3 : 2);
  const threshold = (MAC ? knockDetector : detector).threshold.toFixed(MAC ? 3 : 2);
  if (hit.ok && !touched) {
    els.lastHit.textContent = `Ultimo colpo: forza ${strength} (soglia ${threshold})`;
  } else {
    const why = touched ? (MAC ? 'stavi usando il trackpad o la tastiera' : 'stavi toccando lo schermo') : (MAC ? KNOCK_REJECT_REASONS : REJECT_REASONS)[hit.reason];
    els.lastHit.textContent = `Scartato (forza ${strength}): ${why}`;
  }
}

function waitForMotion(timeoutMs) {
  const start = motion.count;
  return new Promise((resolve) => {
    const began = performance.now();
    const check = () => {
      if (motion.count > start) resolve(true);
      else if (performance.now() - began > timeoutMs) resolve(false);
      else setTimeout(check, 50);
    };
    check();
  });
}

async function startMotion() {
  if (!('DeviceMotionEvent' in window)) throw new Error('unsupported');
  window.addEventListener('devicemotion', onMotion);
  if (!(await waitForMotion(1500))) {
    window.removeEventListener('devicemotion', onMotion);
    throw new Error('no-data');
  }
  detector.reset();
  state.sensorOn = true;
  els.startSheet.hidden = true;
  store.set(KEYS.onboarded, true);
  requestWakeLock();
  render();
}

// Deve partire da un "click": su iOS la richiesta di permesso vale solo se
// nasce da un gesto dell'utente (non da touchstart/pointerdown).
async function enableSensor() {
  if (MAC) { startMacSensor(); return; }
  els.sensorError.hidden = true;
  try {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      const permission = await DeviceMotionEvent.requestPermission();
      if (permission !== 'granted') throw new Error('denied');
    }
    await startMotion();
  } catch (error) {
    showSensorError(error.message);
  }
}

function showSensorError(code) {
  const messages = {
    denied: 'Permesso negato. iPhone ricorda la scelta finché l\'app resta aperta: chiudila del tutto dal multitasking, riaprila e tocca di nuovo «Attiva il sensore».',
    'no-data': 'Nessun dato dal sensore di movimento su questo dispositivo. Puoi battere sullo schermo.',
    unsupported: 'Questo browser non dà accesso al sensore di movimento. Puoi battere sullo schermo.',
    'mac-missing': 'Il programma del sensore non risponde. Avvialo (passi 1 e 2) e poi tocca «Collega il sensore». Con Safari apri l\'app all\'indirizzo che il programma apre da solo, http://localhost:8765.',
    'mac-lost': 'Il programma del sensore si è chiuso. Riavvialo nel Terminale e tocca «Collega il sensore».',
  };
  let text = messages[code] || messages['no-data'];
  if (!window.isSecureContext && !MAC) text = 'Il sensore funziona solo con una connessione sicura (https).';
  els.sensorError.textContent = text;
  els.sensorError.hidden = false;
}

// ---------- Schermo sempre acceso (iOS 18.4+ anche nelle app sulla Home) ----------

let wakeLock = null;

async function requestWakeLock() {
  if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch {
    // Non disponibile: lo schermo si spegnerà secondo le impostazioni di sistema.
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.sensorOn && state.mode === 'back') requestWakeLock();
  // In secondo piano iOS spegne il microfono: si chiude l'ascolto e si salva quello che c'è.
  if (document.visibilityState === 'hidden' && state.phase === 'listening') listener.stop();
  if (document.visibilityState === 'hidden') { stopMetronome(); stopCadence(); }
});

// ---------- Modalità ----------

function setMode(requested) {
  const mode = requested === 'back' && !MOTION && !MAC ? 'screen' : requested;
  stopMetronome();
  if (state.phase === 'tapping') finalize();
  if (state.phase === 'listening') listener.stop();
  // La misura appena fatta è già nello storico: la nuova modalità parte pulita.
  if (state.phase === 'locked' && mode !== state.mode) {
    Object.assign(state, { phase: 'idle', multiplier: 1, lockedResult: null, savedId: null, outcome: null, lockedKey: null, lockedChords: null, lockedStructure: null, listen: null });
  }
  state.mode = mode;
  store.set(KEYS.mode, mode);
  els.pad.dataset.mode = mode;
  for (const button of els.modeButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  }
  if (mode === 'back' && !state.sensorOn) {
    showStartSheet();
    if (MAC) startMacSensor(); // se il programma è già aperto, si collega da solo
  } else {
    els.startSheet.hidden = true;
  }
  if (mode === 'back' && state.sensorOn) requestWakeLock();
  render();
}

function showStartSheet() {
  const onboarded = store.get(KEYS.onboarded, false);
  els.startSheet.classList.toggle('compact', onboarded && !MAC);
  els.sheetTitle.textContent = MAC ? 'Bussa sul MacBook' : onboarded ? 'Riattiva il sensore' : 'Batti sul retro';
  els.enableSensor.textContent = MAC ? 'Collega il sensore' : 'Attiva il sensore';
  els.startSheet.hidden = false;
}

// ---------- Storico ----------

const dateFormat = new Intl.DateTimeFormat('it-IT', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});

function renderHistory() {
  els.historyList.replaceChildren(...history.map(historyItem));
  els.historyEmpty.hidden = history.length > 0;
  els.clearHistory.hidden = history.length === 0;
  renderMetronome();
}

function historyItem(entry) {
  const li = document.createElement('li');
  li.className = 'history-item';
  li.dataset.id = entry.id;

  const value = document.createElement('div');
  value.className = 'history-bpm';
  const { int, dec } = formatBpm(entry.bpm, entry.halfWidth);
  const detail = document.createElement('small');
  detail.textContent = `${formatHalfWidth(entry.halfWidth)} · ${entry.taps} ${['listen', 'file'].includes(entry.source) ? 'battiti' : 'tap'}`;
  value.append(`${int}${dec}`, detail);

  const tools = document.createElement('div');
  tools.className = 'history-tools';
  tools.append(
    chip('metro', '▶', 'Senti i BPM con il metronomo'),
    chip('half', '÷2', 'Dimezza'),
    chip('double', '×2', 'Raddoppia'),
    chip('delete', '✕', 'Elimina misura'),
  );

  const name = document.createElement('input');
  name.className = 'history-name';
  name.type = 'text';
  name.placeholder = 'Nome della canzone';
  name.value = entry.name;
  name.setAttribute('aria-label', 'Nome della canzone');
  name.dataset.action = 'rename';

  const meta = document.createElement('div');
  meta.className = 'history-meta';
  const sourceLabel = { back: 'retro', knock: 'colpi sul Mac', screen: 'schermo', listen: 'ascolto', file: 'file' }[entry.source] || entry.source;
  meta.textContent = `${dateFormat.format(entry.createdAt)} · ${sourceLabel}`;

  li.append(value, tools);
  if (entry.key) {
    const key = document.createElement('div');
    key.className = 'history-key';
    const unsure = entry.key.alternative && !(entry.key.probability >= 0.8);
    const label = document.createElement('span');
    label.textContent = entry.key.confirmed ? `${entry.key.name} ✓ (scelta a orecchio)`
      : unsure ? `${entry.key.name} (oppure ${entry.key.alternative})` : entry.key.name;
    const play = chip('cadence', '▶', `Senti la cadenza di ${entry.key.name}`);
    play.classList.add('chip-small');
    key.append(play, label);
    li.append(key);
  }
  if (entry.chords?.length) {
    const row = document.createElement('div');
    row.className = 'history-chords';
    row.append(...entry.chords.map((label) => chordChip(label, entry.key, true)));
    li.append(row);
  }
  const structure = entry.structure && renderHistoryStructure(entry.structure, entry.key);
  if (structure) li.append(structure);
  li.append(name, meta);
  return li;
}

function chip(action, label, ariaLabel) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chip';
  button.dataset.action = action;
  button.textContent = label;
  button.setAttribute('aria-label', ariaLabel);
  return button;
}

els.historyList.addEventListener('click', (event) => {
  const expand = event.target.closest('button[data-expand]');
  if (expand) {
    const row = expand.closest('.group');
    row?.classList.add('expanded');
    const entry = history.find((e) => e.id === expand.closest('.history-item').dataset.id);
    const structure = entry && expandStructure(entry.structure);
    if (structure && row) {
      // Nello storico la riga si ridisegna da sola, con tutti gli accordi.
      toggleExpanded(structure, expand.dataset.expand);
      const list = document.createElement('ul');
      renderGroups(list, structure, entry.key, { playable: true, maxChords: 6 });
      const fresh = [...list.children].find((li) => li.querySelector('.group-badge')?.textContent === expand.dataset.expand);
      if (fresh) row.replaceWith(fresh);
    }
    return;
  }
  const play = event.target.closest('button[data-play]');
  if (play) {
    const entry = history.find((e) => e.id === play.closest('.history-item').dataset.id);
    const structure = entry && expandStructure(entry.structure);
    if (structure) playSection(structure, play.dataset.play, entry.bpm, play.dataset.alternative === '1');
    return;
  }
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const id = button.closest('.history-item').dataset.id;
  const entry = history.find((e) => e.id === id);
  if (!entry) return;
  const { action } = button.dataset;
  if (action === 'metro') {
    if (metronome.owner === id) stopMetronome();
    else { metronome.start(entry.bpm, id); renderMetronome(); }
    return;
  }
  if (action === 'cadence') {
    stopMetronome();
    playCadence(entry.key);
    return;
  }
  if (action === 'delete') {
    history = history.filter((e) => e.id !== id);
    if (state.savedId === id) state.savedId = null;
    if (metronome.owner === id) stopMetronome();
  } else {
    const factor = action === 'double' ? 2 : 0.5;
    entry.bpm *= factor;
    entry.halfWidth *= factor;
    if (state.phase === 'locked' && state.savedId === id) state.multiplier *= factor;
    if (metronome.owner === id) metronome.setBpm(entry.bpm);
    if (metronome.owner === 'main' && state.savedId === id) metronome.setBpm(metronome.bpm * factor);
  }
  saveHistory();
  renderHistory();
  render();
});

els.historyList.addEventListener('input', (event) => {
  if (event.target.dataset.action !== 'rename') return;
  const entry = history.find((e) => e.id === event.target.closest('.history-item').dataset.id);
  if (!entry) return;
  entry.name = event.target.value;
  saveHistory();
});

els.clearHistory.addEventListener('click', () => {
  if (!confirm('Cancellare tutte le misure salvate?')) return;
  if (metronome.owner && metronome.owner !== 'main') stopMetronome();
  history = [];
  state.savedId = null;
  saveHistory();
  renderHistory();
});

// ---------- Pannello del sensore ----------

function drawScope() {
  const canvas = els.scope;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.round(canvas.clientWidth * dpr);
  const height = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);

  const data = motion.scope;
  if (data.length < 2) return;
  const styles = getComputedStyle(document.documentElement);
  const maxValue = Math.max(0.05, ...data.map((d) => Math.max(d.s, d.thr * 1.6)));
  const x = (i) => (i / (SCOPE_SAMPLES - 1)) * width;
  const y = (v) => height - 4 * dpr - (v / maxValue) * (height - 10 * dpr);
  const offset = SCOPE_SAMPLES - data.length;

  ctx.lineWidth = 1.5 * dpr;
  ctx.strokeStyle = styles.getPropertyValue('--muted');
  ctx.beginPath();
  data.forEach((d, i) => (i ? ctx.lineTo(x(i + offset), y(d.s)) : ctx.moveTo(x(i + offset), y(d.s))));
  ctx.stroke();

  ctx.setLineDash([4 * dpr, 4 * dpr]);
  ctx.strokeStyle = styles.getPropertyValue('--faint');
  ctx.beginPath();
  data.forEach((d, i) => (i ? ctx.lineTo(x(i + offset), y(d.thr)) : ctx.moveTo(x(i + offset), y(d.thr))));
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.lineWidth = 2 * dpr;
  const colors = { tap: styles.getPropertyValue('--accent'), rejected: styles.getPropertyValue('--faint') };
  data.forEach((d, i) => {
    if (!d.mark) return;
    ctx.strokeStyle = colors[d.mark];
    ctx.beginPath();
    ctx.moveTo(x(i + offset), 0);
    ctx.lineTo(x(i + offset), height);
    ctx.stroke();
  });

  const times = motion.times;
  if (times.length > 10) {
    const hz = ((times.length - 1) * 1000) / (times[times.length - 1] - times[0]);
    els.sensorRate.textContent = `${Math.round(hz)} Hz`;
  }
}

els.sensorToggle.addEventListener('click', () => {
  const open = els.sensorPanel.hidden;
  els.sensorPanel.hidden = !open;
  els.sensorToggle.setAttribute('aria-expanded', String(open));
  if (open) ensureLoop();
});

els.sensitivity.addEventListener('input', () => {
  const value = Number(els.sensitivity.value);
  (MAC ? knockDetector : detector).setSensitivity(value);
  els.sensitivityOut.textContent = String(value);
  store.set(MAC ? KEYS.macSensitivity : KEYS.sensitivity, value);
});

// Esporta gli ultimi ~20 s di dati grezzi, per tarare il rilevamento sul proprio telefono.
els.exportData.addEventListener('click', async () => {
  const payload = {
    app: 'BPM Tap',
    exportedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    sensitivity: (MAC ? knockDetector : detector).cfg.sensitivity,
    device: MAC ? 'mac' : 'phone',
    columns: MAC ? ['t_ms', 'ax', 'ay', 'az', 'tap_ms'] : ['t_ms', 'ax', 'ay', 'az', 'rotAlpha', 'rotBeta', 'rotGamma', 'tap_ms'],
    samples: motion.raw,
    result: estimator.result(),
  };
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const file = new File([JSON.stringify(payload)], `bpm-tap-sensore-${stamp}.json`, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Dati sensore BPM Tap' });
      return;
    } catch (error) {
      if (error.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const link = Object.assign(document.createElement('a'), { href: url, download: file.name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ---------- Input ----------

els.pad.addEventListener('pointerdown', (event) => {
  if (state.mode !== 'screen' || event.target.closest('button')) return;
  event.preventDefault();
  onTap(eventTime(event), 'screen');
});

// Qualsiasi tocco sullo schermo o tasto premuto (sul Mac scuote la scocca) sospende per un
// attimo i tap dal sensore.
for (const type of ['pointerdown', 'pointerup', 'keydown']) {
  window.addEventListener(type, (event) => { state.lastTouch = eventTime(event); }, { capture: true, passive: true });
}

// Tastiera (sul computer è il modo principale): Spazio batte (o avvia e ferma l'ascolto),
// A ascolta, M metronomo, frecce ÷2 e ×2, Esc nuova misura. Spazio batte anche se un
// pulsante ha il focus; Invio su un pulsante lo preme, come sempre.
window.addEventListener('keydown', (event) => {
  if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('input, textarea, select')) return;
  if (!els.startSheet.hidden && event.code !== 'Escape') return;
  const onButton = Boolean(target?.closest('button'));
  if (event.code === 'Space' || (event.code === 'Enter' && !onButton)) {
    event.preventDefault();
    if (state.mode === 'listen') toggleListening();
    else onTap(eventTime(event), 'screen');
  } else if (event.code === 'Escape') {
    newMeasure();
  } else if (event.code === 'KeyM') {
    toggleMainMetronome();
  } else if (event.code === 'ArrowUp' && !els.doubleBtn.disabled) {
    event.preventDefault();
    scale(2);
  } else if (event.code === 'ArrowDown' && !els.halfBtn.disabled) {
    event.preventDefault();
    scale(0.5);
  } else if (event.code === 'KeyA') {
    if (state.mode !== 'listen') setMode('listen');
    toggleListening();
  }
});

els.modeButtons.forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
els.halfBtn.addEventListener('click', () => scale(0.5));
els.doubleBtn.addEventListener('click', () => scale(2));
els.resetBtn.addEventListener('click', newMeasure);
els.enableSensor.addEventListener('click', enableSensor);
els.useScreen.addEventListener('click', () => setMode('screen'));
els.useListen.addEventListener('click', () => setMode('listen'));
els.listenBtn.addEventListener('click', toggleListening);
els.skipCalibration.addEventListener('click', () => listener.skipCalibration());
els.keyCheckButtons.forEach((button) => button.addEventListener('click', () => chooseKey(Number(button.dataset.check))));
els.metroBtn.addEventListener('click', toggleMainMetronome);
els.fileInput.accept = FILE_ACCEPT;
els.fileBtn.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => {
  startFileAnalysis(els.fileInput.files[0]);
  els.fileInput.value = '';
});
// Trascina un file audio in qualsiasi punto della pagina.
let dragDepth = 0;
const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (event) => {
  if (!hasFiles(event)) return;
  dragDepth += 1;
  els.dropOverlay.hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) els.dropOverlay.hidden = true;
});
window.addEventListener('dragover', (event) => { if (hasFiles(event)) event.preventDefault(); });
window.addEventListener('drop', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  els.dropOverlay.hidden = true;
  startFileAnalysis(event.dataTransfer.files[0]);
});
for (const container of [els.chordChips, els.historyList]) {
  container.addEventListener('click', (event) => {
    const chip = event.target.closest('.chord-chip');
    if (!chip || chip.disabled) return;
    stopMetronome();
    playChord(Number(chip.dataset.chord));
  });
}

// ---------- Avvio ----------

els.sensitivity.value = String((MAC ? knockDetector : detector).cfg.sensitivity);
els.sensitivityOut.textContent = els.sensitivity.value;
for (const el of document.querySelectorAll('[data-device]')) el.hidden = el.dataset.device !== (MAC ? 'mac' : 'phone');
if (MAC) {
  document.querySelector('[data-mode="back"]').textContent = 'Bussa';
  els.lastHit.hidden = false;
  els.lastHit.textContent = 'Bussa sul Mac per vedere la forza dei colpi.';
} else if (!MOTION) {
  document.querySelector('[data-mode="back"]').hidden = true;
  els.sensorToggle.hidden = true;
}
renderHistory();
setMode(state.mode);

// Dove non serve un permesso esplicito (Android, desktop) il sensore parte da solo.
if (MOTION && state.mode === 'back' && typeof DeviceMotionEvent !== 'undefined' &&
  typeof DeviceMotionEvent.requestPermission !== 'function') {
  startMotion().catch(() => {});
}

navigator.storage?.persist?.().catch(() => {});

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
