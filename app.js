import { TempoEstimator, DEFAULTS, formatBpm, formatHalfWidth, quality } from './tempo.js';
import { TapDetector, REJECT_REASONS } from './detector.js';

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
  sensorError: $('sensorError'),
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

const state = {
  mode: store.get(KEYS.mode, 'back'), // back | screen
  phase: 'idle',                      // idle | tapping | locked
  multiplier: 1,
  source: null,
  lockedResult: null,
  savedId: null,
  outcome: null,                      // saved | too-few
  sensorOn: false,
  lastTouch: -Infinity,
};

const estimator = new TempoEstimator();
const detector = new TapDetector({ sensitivity: store.get(KEYS.sensitivity, 5) });
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
  if (state.phase === 'tapping') finalize();
  estimator.reset();
  Object.assign(state, { phase: 'idle', multiplier: 1, lockedResult: null, savedId: null, outcome: null });
  render();
}

// ×2 / ÷2: vale per la misura in corso e per quella appena salvata.
function scale(factor) {
  state.multiplier *= factor;
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
  if (state.phase === 'locked') return state.lockedResult;
  return null;
}

function render() {
  const result = currentResult();
  const m = state.multiplier;

  let visual = state.phase;
  if (state.phase === 'tapping' && (!result || !result.valid)) visual = 'rough';
  els.pad.dataset.state = visual;

  if (result) {
    const bpm = result.bpm * m;
    const hw = result.halfWidth * m;
    const { int, dec } = formatBpm(bpm, hw);
    els.bpmInt.textContent = int;
    els.bpmDec.textContent = dec;
    els.plusMinus.textContent = `${formatHalfWidth(hw)} BPM`;
    els.tapCount.textContent = `${result.taps} tap`;
    const q = quality({ ...result, halfWidth: hw });
    els.qualityFill.style.transform = `scaleX(${q.level})`;
    els.qualityLabel.textContent = q.label;
  } else {
    els.bpmInt.textContent = '—';
    els.bpmDec.textContent = '';
    els.plusMinus.textContent = '';
    els.tapCount.textContent = state.phase === 'tapping' ? '1 tap' : '';
    els.qualityFill.style.transform = 'scaleX(0)';
    els.qualityLabel.textContent = state.phase === 'tapping' ? 'Continua a battere…' : '';
  }

  els.status.textContent = statusText(result);
  els.halfBtn.disabled = els.doubleBtn.disabled = !result;
  els.resetBtn.disabled = state.phase === 'idle';
  if (state.phase !== 'tapping') {
    els.timerArc.style.removeProperty('stroke-dashoffset');
    els.timerArc.style.removeProperty('opacity');
  }
}

function statusText(result) {
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
  if (state.mode === 'screen') return 'Batti qui sopra a tempo con la canzone.';
  return state.sensorOn
    ? 'Batti sul retro a tempo con la canzone.'
    : 'Attiva il sensore per battere sul retro.';
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

  let tap = null;
  if (hit && state.mode === 'back') {
    const touched = t - state.lastTouch <= TOUCH_GUARD_MS;
    const ok = hit.ok && !touched;
    if (ok) tap = hit.time;
    // L'esito arriva qualche campione dopo il picco: il segno va sul campione giusto.
    const back = Math.round((t - hit.time) / (1000 / 60));
    motion.scope[Math.max(0, motion.scope.length - 1 - back)].mark = ok ? 'tap' : 'rejected';
    showLastHit(hit, touched);
  }

  motion.raw.push([t, src.x, src.y, src.z, r?.alpha, r?.beta, r?.gamma, tap]
    .map((v) => (typeof v === 'number' ? Math.round(v * 10000) / 10000 : v ?? null)));
  if (motion.raw.length > EXPORT_SAMPLES) motion.raw.shift();

  if (tap !== null) onTap(tap, 'back');
}

// Nel pannello del sensore: forza dell'ultimo colpo e, se scartato, il perché.
function showLastHit(hit, touched) {
  if (els.sensorPanel.hidden) return;
  const strength = hit.strength.toFixed(2);
  const threshold = detector.threshold.toFixed(2);
  if (hit.ok && !touched) {
    els.lastHit.textContent = `Ultimo colpo: forza ${strength} (soglia ${threshold})`;
  } else {
    const why = touched ? 'stavi toccando lo schermo' : REJECT_REASONS[hit.reason];
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
  };
  let text = messages[code] || messages['no-data'];
  if (!window.isSecureContext) text = 'Il sensore funziona solo con una connessione sicura (https).';
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
});

// ---------- Modalità ----------

function setMode(mode) {
  if (state.phase === 'tapping') finalize();
  state.mode = mode;
  store.set(KEYS.mode, mode);
  els.pad.dataset.mode = mode;
  for (const button of els.modeButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  }
  if (mode === 'back' && !state.sensorOn) showStartSheet();
  else els.startSheet.hidden = true;
  if (mode === 'back' && state.sensorOn) requestWakeLock();
  render();
}

function showStartSheet() {
  const onboarded = store.get(KEYS.onboarded, false);
  els.startSheet.classList.toggle('compact', onboarded);
  els.sheetTitle.textContent = onboarded ? 'Riattiva il sensore' : 'Batti sul retro';
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
}

function historyItem(entry) {
  const li = document.createElement('li');
  li.className = 'history-item';
  li.dataset.id = entry.id;

  const value = document.createElement('div');
  value.className = 'history-bpm';
  const { int, dec } = formatBpm(entry.bpm, entry.halfWidth);
  const detail = document.createElement('small');
  detail.textContent = `${formatHalfWidth(entry.halfWidth)} · ${entry.taps} tap`;
  value.append(`${int}${dec}`, detail);

  const tools = document.createElement('div');
  tools.className = 'history-tools';
  tools.append(
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
  meta.textContent = `${dateFormat.format(entry.createdAt)} · ${entry.source === 'back' ? 'retro' : 'schermo'}`;

  li.append(value, tools, name, meta);
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
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const id = button.closest('.history-item').dataset.id;
  const entry = history.find((e) => e.id === id);
  if (!entry) return;
  const { action } = button.dataset;
  if (action === 'delete') {
    history = history.filter((e) => e.id !== id);
    if (state.savedId === id) state.savedId = null;
  } else {
    const factor = action === 'double' ? 2 : 0.5;
    entry.bpm *= factor;
    entry.halfWidth *= factor;
    if (state.phase === 'locked' && state.savedId === id) state.multiplier *= factor;
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
  detector.setSensitivity(value);
  els.sensitivityOut.textContent = String(value);
  store.set(KEYS.sensitivity, value);
});

// Esporta gli ultimi ~20 s di dati grezzi, per tarare il rilevamento sul proprio telefono.
els.exportData.addEventListener('click', async () => {
  const payload = {
    app: 'BPM Tap',
    exportedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    sensitivity: detector.cfg.sensitivity,
    columns: ['t_ms', 'ax', 'ay', 'az', 'rotAlpha', 'rotBeta', 'rotGamma', 'tap_ms'],
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
  if (state.mode !== 'screen') return;
  event.preventDefault();
  onTap(eventTime(event), 'screen');
});

// Qualsiasi tocco sullo schermo sospende per un attimo i tap dal sensore.
for (const type of ['pointerdown', 'pointerup']) {
  window.addEventListener(type, (event) => { state.lastTouch = eventTime(event); }, { capture: true, passive: true });
}

window.addEventListener('keydown', (event) => {
  if (event.repeat || (event.target instanceof Element && event.target.closest('input, textarea, select, button'))) return;
  if (event.code === 'Space' || event.code === 'Enter') {
    event.preventDefault();
    onTap(eventTime(event), 'screen');
  } else if (event.code === 'Escape') {
    newMeasure();
  }
});

els.modeButtons.forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
els.halfBtn.addEventListener('click', () => scale(0.5));
els.doubleBtn.addEventListener('click', () => scale(2));
els.resetBtn.addEventListener('click', newMeasure);
els.enableSensor.addEventListener('click', enableSensor);
els.useScreen.addEventListener('click', () => setMode('screen'));

// ---------- Avvio ----------

els.sensitivity.value = String(detector.cfg.sensitivity);
els.sensitivityOut.textContent = String(detector.cfg.sensitivity);
renderHistory();
setMode(state.mode);

// Dove non serve un permesso esplicito (Android, desktop) il sensore parte da solo.
if (state.mode === 'back' && typeof DeviceMotionEvent !== 'undefined' &&
  typeof DeviceMotionEvent.requestPermission !== 'function') {
  startMotion().catch(() => {});
}

navigator.storage?.persist?.().catch(() => {});

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
