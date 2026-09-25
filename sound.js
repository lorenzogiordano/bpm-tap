// Suoni dell'app: metronomo per ascoltare i BPM trovati e cadenze per sentire una
// tonalità. Un solo AudioContext, creato al primo tocco (iOS lo sblocca solo in un gesto).

let ctx = null;
let voice = null; // cadenza in corso

function context() {
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!ctx) ctx = new Context();
  // iPhone: suona anche con l'interruttore del silenzio (Audio Session API, Safari 16.4+).
  if (navigator.audioSession) navigator.audioSession.type = 'playback';
  if (ctx.state !== 'running') ctx.resume();
  return ctx;
}

// Da chiamare prima di aprire il microfono: la sessione "solo riproduzione" lo impedirebbe.
export function releaseAudioSession() {
  stopCadence();
  if (navigator.audioSession) navigator.audioSession.type = 'auto';
}

// ---------- Metronomo ----------

// "Colpo di legno": due sinusoidi acute con decadimento di ~40 ms, udibile sopra la musica.
function click(ac, time) {
  const gain = ac.createGain();
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(0.6, time + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.045);
  gain.connect(ac.destination);
  for (const [freq, level] of [[1250, 1], [2500, 0.35]]) {
    const osc = ac.createOscillator();
    osc.frequency.value = freq;
    const g = ac.createGain();
    g.gain.value = level;
    osc.connect(g).connect(gain);
    osc.start(time);
    osc.stop(time + 0.05);
  }
}

// Programmazione in anticipo sull'orologio dell'audio (C. Wilson, "A Tale of Two Clocks"):
// un timer ogni 25 ms fissa i colpi dei prossimi 120 ms, così il tempo resta esatto
// anche se il thread principale ha un attimo di ritardo.
export class Metronome {
  constructor({ onBeat } = {}) {
    this.onBeat = onBeat;
    this.bpm = 0;
    this.owner = null; // chi lo ha acceso (la misura in corso o una misura salvata)
    this.timer = null;
  }

  get playing() {
    return this.timer !== null;
  }

  start(bpm, owner) {
    const ac = context();
    stopCadence();
    this.bpm = bpm;
    this.owner = owner;
    if (this.timer) return;
    this.next = ac.currentTime + 0.1;
    this.timer = setInterval(() => this.schedule(), 25);
    this.schedule();
  }

  // Cambio di BPM al volo (÷2, ×2): vale dal colpo successivo.
  setBpm(bpm) {
    this.bpm = bpm;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.owner = null;
  }

  schedule() {
    const ac = ctx;
    while (this.next < ac.currentTime + 0.12) {
      click(ac, this.next);
      const delay = Math.max(0, (this.next - ac.currentTime) * 1000);
      if (this.onBeat) setTimeout(this.onBeat, delay);
      this.next += 60 / this.bpm;
    }
  }
}

// ---------- Cadenze ----------

// I–IV–V–I in maggiore, i–iv–V–i in minore (con la dominante maggiore, che porta la
// sensibile): è la successione con cui di solito si fa sentire una tonalità. Accordi in
// posizione stretta, con il basso sulla fondamentale. Semitoni dalla tonica.
const CADENCE = {
  major: { chords: [[0, 4, 7], [0, 5, 9], [-1, 2, 7], [0, 4, 7]], bass: [0, 5, -5, 0] },
  minor: { chords: [[0, 3, 7], [0, 5, 8], [-1, 2, 7], [0, 3, 7]], bass: [0, 5, -5, 0] },
};
const STEP = 0.75; // secondi per accordo; l'ultimo dura il doppio

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

function note(ac, destination, midi, start, length, level) {
  const gain = ac.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(level, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(level * 0.35, start + Math.min(0.6, length));
  gain.gain.setValueAtTime(level * 0.35, start + length - 0.08);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  gain.connect(destination);
  // Due triangoli leggermente scordati: un suono morbido, simile a un piano elettrico.
  for (const detune of [-4, 4]) {
    const osc = ac.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = hz(midi);
    osc.detune.value = detune;
    osc.connect(gain);
    osc.start(start);
    osc.stop(start + length + 0.02);
  }
}

export function stopCadence() {
  if (!voice) return;
  const { master, ac } = voice;
  master.gain.cancelScheduledValues(ac.currentTime);
  master.gain.setTargetAtTime(0, ac.currentTime, 0.02);
  setTimeout(() => master.disconnect(), 200);
  voice = null;
}

// Suona la cadenza della tonalità { tonic: 0–11 (Do = 0), mode }. Restituisce la durata (s).
export function playCadence({ tonic, mode }) {
  const ac = context();
  stopCadence();
  const master = ac.createGain();
  master.gain.value = 0.22;
  master.connect(ac.destination);
  voice = { master, ac };
  const { chords, bass } = CADENCE[mode === 'minor' ? 'minor' : 'major'];
  let root = 60 + tonic;       // tonica tra Fa#3 e Fa#4
  if (root > 66) root -= 12;
  const start = ac.currentTime + 0.05;
  chords.forEach((chord, i) => {
    const t = start + i * STEP;
    const length = i === chords.length - 1 ? 2 * STEP : STEP;
    for (const interval of chord) note(ac, master, root + interval, t, length, 0.5);
    note(ac, master, root - 12 + bass[i], t, length, 0.6);
  });
  return (chords.length + 1) * STEP;
}

// Un accordo (0–11 maggiori, 12–23 minori, Do = 0) in posizione fondamentale, con il basso.
export function playChord(label) {
  const ac = context();
  stopCadence();
  const master = ac.createGain();
  master.gain.value = 0.22;
  master.connect(ac.destination);
  voice = { master, ac };
  const tonic = label % 12;
  let root = 60 + tonic;
  if (root > 66) root -= 12;
  const third = label < 12 ? 4 : 3;
  const start = ac.currentTime + 0.03;
  for (const interval of [0, third, 7]) note(ac, master, root + interval, start, 1.6, 0.5);
  note(ac, master, root - 12, start, 1.6, 0.6);
}
