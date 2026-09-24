// Rilevamento dei tap sul retro del telefono dai dati di DeviceMotionEvent.
//
// Su iPhone WebKit legge CoreMotion con un timer a 1/60 s
// (kMotionUpdateInterval in WebCoreMotionManager.mm) e passa alla pagina
// l'ultimo campione disponibile: i dati arrivano a ~60 Hz, un campione ogni
// ~16.7 ms, senza un timestamp del sensore.
//
// Pipeline euristica, sullo schema del ramo non-ML di Google Quick Tap
// (Columbus, TapRT.kt) e di Headtalk/Knock per iOS:
// 1. asse z dell'accelerazione: il dito sul retro spinge il telefono lungo z;
// 2. derivata prima (jerk): vale ~0 a telefono fermo o in movimento lento e
//    mette in risalto i transitori rapidi di un colpo (Columbus "slope",
//    TapNet: "change of force on the housing");
// 3. soglia adattiva: mediana + k·MAD del jerk nell'ultimo secondo e mezzo,
//    con un minimo assoluto; entrambi dipendono dalla sensibilità scelta;
// 4. il picco più alto nei 3 campioni dopo il superamento della soglia, poi un
//    periodo refrattario per ignorare gli "echi" del colpo (gli accelerometri
//    ADXL345/LIS3DH usano finestre di latenza di 20–100 ms per lo stesso motivo);
// 5. istante del picco raffinato con interpolazione parabolica tra i campioni.
//
// Un tap perso pesa più di uno registrato qualche millisecondo fuori posto.
// Quando si sa dove cadrà il prossimo battito (expect), in una finestra attorno
// a quel momento la soglia si abbassa: un colpo debole o catturato a metà tra
// due campioni viene preso lo stesso. Il tap "aiutato" è segnalato come tale.
//
// Il derivare toglie anche la gravità costante, quindi se `acceleration`
// manca si può usare `accelerationIncludingGravity` senza cambiare nulla.

export const DETECTOR_DEFAULTS = {
  sensitivity: 6,     // 1 (poco sensibile) … 10 (molto sensibile)
  refractoryMs: 140,  // sotto i 200 ms di un battito a 300 BPM
  noiseWindow: 90,    // campioni usati per stimare il rumore (~1.5 s a 60 Hz)
  warmup: 30,         // campioni prima di iniziare a rilevare (~0.5 s)
  peakWindow: 3,      // campioni in cui cercare il picco dopo la soglia
  assistFactor: 0.55, // soglia vicino al battito atteso, in frazione di quella normale (sopra il rumore)
};

// Sensibilità → moltiplicatore del rumore e soglia minima assoluta (m/s² per campione).
// Con rumore gaussiano k = 7 dà meno di un falso tap al minuto; i falsi tap
// fuori tempo vengono comunque scartati dalla stima dei BPM.
export function thresholdParams(sensitivity) {
  const s = Math.min(10, Math.max(1, sensitivity));
  return {
    k: 4 + (10 - s) * 0.75,
    floor: 0.08 * 2 ** ((6 - s) / 1.5),
  };
}

export class TapDetector {
  constructor(options = {}) {
    this.cfg = { ...DETECTOR_DEFAULTS, ...options };
    this.setSensitivity(this.cfg.sensitivity);
    this.reset();
  }

  setSensitivity(sensitivity) {
    this.cfg.sensitivity = sensitivity;
    this.params = thresholdParams(sensitivity);
  }

  reset() {
    this.prevZ = null;
    this.noise = [];          // ultimi valori di |jerk| per stimare il rumore
    this.recent = [];         // ultimi campioni { t, s } per il picco e i vicini
    this.candidate = null;    // picco in osservazione dopo il superamento della soglia
    this.lastTapTime = -Infinity;
    this.threshold = this.params.floor;
    this.assistThreshold = this.params.floor;
    this.expectation = null;  // { time, halfWidth, assist }: prossimo battito atteso
    this.quiet = null;        // { from, to }: intervallo escluso dalla stima del rumore
    this.score = 0;
  }

  // Indica dove si attende il prossimo battito (ms) e con quale margine; null per annullare.
  // Con assist la soglia si abbassa in quella finestra; in ogni caso i campioni
  // della finestra (e del possibile "rimbombo" successivo) non contano come rumore:
  // un tap debole non visto non deve alzare la soglia e far perdere i successivi.
  expect(time, halfWidth, assist = true) {
    if (time === null) {
      this.expectation = null;
      return;
    }
    this.expectation = { time, halfWidth, assist };
    this.quiet = { from: time - halfWidth, to: time + halfWidth + this.cfg.refractoryMs };
  }

  // Soglia in vigore all'istante t: più bassa nella finestra del battito atteso.
  thresholdAt(t) {
    const e = this.expectation;
    if (e && t > e.time + e.halfWidth) this.expectation = null;
    const inWindow = this.expectation && this.expectation.assist && Math.abs(t - e.time) <= e.halfWidth;
    return inWindow ? this.assistThreshold : this.threshold;
  }

  isQuiet(t) {
    return this.quiet !== null && t >= this.quiet.from && t <= this.quiet.to;
  }

  // Aggiunge un campione: t in ms, z in m/s².
  // Restituisce { time, assisted } quando riconosce un tap, altrimenti null.
  push(t, z) {
    if (this.prevZ === null) {
      this.prevZ = z;
      return null;
    }
    const s = Math.abs(z - this.prevZ);
    this.prevZ = z;
    this.score = s;

    this.recent.push({ t, s });
    if (this.recent.length > this.cfg.peakWindow + 2) this.recent.shift();

    // Il picco si cerca nei primi peakWindow campioni; se ne attende uno in più
    // perché l'interpolazione ha bisogno del vicino successivo al picco.
    let tap = null;
    const threshold = this.thresholdAt(t);
    if (this.candidate) {
      const c = this.candidate;
      c.seen += 1;
      if (c.seen <= this.cfg.peakWindow && s > c.s) Object.assign(c, { t, s });
      if (c.seen > this.cfg.peakWindow) tap = this.finishCandidate();
    } else if (this.noise.length >= this.cfg.warmup && s > threshold &&
      t - this.lastTapTime > this.cfg.refractoryMs) {
      this.candidate = { t, s, seen: 1 };
    }

    // Il rumore di fondo si stima senza il colpo, il suo "rimbombo" e i battiti attesi.
    if (!this.candidate && !tap && t - this.lastTapTime > this.cfg.refractoryMs && !this.isQuiet(t)) {
      this.updateNoise(s);
    }
    return tap;
  }

  finishCandidate() {
    const c = this.candidate;
    this.candidate = null;
    const time = this.refine(c);
    this.lastTapTime = time;
    this.expectation = null;
    return { time, assisted: c.s <= this.threshold };
  }

  // Interpolazione parabolica del picco con i due campioni vicini, se disponibili.
  refine(c) {
    const i = this.recent.findIndex((p) => p.t === c.t);
    const prev = this.recent[i - 1];
    const next = this.recent[i + 1];
    if (!prev || !next) return c.t;
    const denom = prev.s - 2 * c.s + next.s;
    if (denom >= 0) return c.t;
    const offset = Math.max(-0.5, Math.min(0.5, 0.5 * (prev.s - next.s) / denom));
    const step = offset < 0 ? c.t - prev.t : next.t - c.t;
    return c.t + offset * step;
  }

  updateNoise(s) {
    this.noise.push(s);
    if (this.noise.length > this.cfg.noiseWindow) this.noise.shift();
    if (this.noise.length < 10) return;
    const sorted = [...this.noise].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    const deviations = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
    const mad = 1.4826 * deviations[deviations.length >> 1];
    this.threshold = Math.max(this.params.floor, median + this.params.k * mad);
    this.assistThreshold = Math.max(this.params.floor * this.cfg.assistFactor,
      median + this.params.k * this.cfg.assistFactor * mad);
  }
}
