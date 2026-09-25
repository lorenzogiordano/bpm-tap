// Rilevamento dei colpi sul retro del telefono dai dati di DeviceMotionEvent.
//
// Su iPhone WebKit legge CoreMotion con un timer a 1/60 s
// (kMotionUpdateInterval in WebCoreMotionManager.mm) e passa alla pagina
// l'ultimo campione disponibile: i dati arrivano a ~60 Hz, un campione ogni
// ~16.7 ms, senza un timestamp del sensore. (Il "Tocco posteriore" di iOS usa
// gli stessi sensori, ma sui dati grezzi ad alta frequenza e con un
// riconoscitore di sistema che non è accessibile alle pagine web.)
//
// Pipeline, sullo schema del ramo non-ML di Google Quick Tap (Columbus,
// TapRT.kt) e di Headtalk/Knock per iOS, più i controlli con cui gli
// accelerometri distinguono un colpo da un movimento (ADXL345: DUR; ST: QUIET):
// 1. jerk (variazione dell'accelerazione tra due campioni) sui tre assi: vale ~0
//    a telefono fermo e toglie la gravità; il punteggio è la componente z,
//    perché il dito sul retro spinge il telefono lungo z;
// 2. soglia adattiva: mediana + k·MAD del jerk nell'ultimo secondo e mezzo, con
//    un minimo assoluto; entrambi dipendono dalla sensibilità;
// 3. picco nei 3 campioni dopo il superamento della soglia, raffinato con
//    interpolazione parabolica;
// 4. un candidato è un colpo solo se ha la forma di un colpo:
//    - quiete prima: nei ~100 ms precedenti il segnale era basso (uno scossone
//      o uno spostamento invece cresce gradualmente);
//    - spinta e ritorno: attorno al picco (entro due campioni) il jerk cambia segno, come
//      nello schema di Quick Tap (picco positivo seguito da uno negativo);
//      uno spostamento liscio, anche brusco, non torna indietro così in fretta;
//    - direzione: il jerk è soprattutto lungo z (retro), non di lato;
//    - telefono non in rotazione veloce (scosso o girato);
//    - forza: dopo qualche colpo, non molto più debole dei colpi precedenti;
// 5. periodo refrattario di 140 ms contro gli "echi" del colpo.

export const DETECTOR_DEFAULTS = {
  sensitivity: 5,          // 1 (solo colpi forti) … 10 (anche colpi leggeri)
  refractoryMs: 140,       // sotto i 200 ms di un battito a 300 BPM
  noiseWindow: 90,         // campioni usati per stimare il rumore (~1.5 s a 60 Hz)
  warmup: 30,              // campioni prima di iniziare a rilevare (~0.5 s)
  peakWindow: 3,           // campioni in cui cercare il picco dopo la soglia
  quietSamples: 6,         // ~100 ms prima del colpo che devono essere tranquilli…
  quietRatio: 0.35,        // …cioè sotto questa frazione del picco
  reversalSamples: 2,      // campioni dopo il picco in cui cercare il "ritorno" del colpo…
  reversalRatio: 0.05,     // …di segno opposto e almeno questa frazione del picco
  echoMs: 90,              // dopo un colpo, per così tanto il segnale è ancora il suo rimbombo
  zShare: 0.6,             // quota minima del jerk lungo z (colpo sul retro)
  maxRotation: 200,        // °/s medi prima del colpo: oltre, il telefono si sta muovendo
  relativeStrength: 0.35,  // rispetto alla mediana degli ultimi colpi validi
  strengthMemoryMs: 4000,  // dopo una pausa così lunga si dimentica la forza dei colpi
};

// Sensibilità → moltiplicatore del rumore e forza minima assoluta (m/s² per campione).
export function thresholdParams(sensitivity) {
  const s = Math.min(10, Math.max(1, sensitivity));
  return {
    k: 4 + (10 - s) * 0.6,
    floor: 0.35 * 2 ** ((5 - s) / 1.5),
  };
}

export const REJECT_REASONS = {
  moving: 'il telefono si stava muovendo',
  smooth: 'movimento, non un colpo secco',
  sideways: 'colpo non sul retro',
  weak: 'molto più debole dei tuoi colpi',
};

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
    this.prev = null;
    this.index = 0;
    this.buffer = [];          // ultimi campioni { i, t, s, jx, jy, jz, rot }
    this.noise = [];           // ultimi valori del punteggio per stimare il rumore
    this.candidate = null;     // { start, peak }: indici del superamento e del picco
    this.lastTapTime = -Infinity;
    this.strengths = [];       // { t, strength } dei colpi validi recenti
    this.threshold = this.params.floor;
    this.noiseLevel = 0;       // livello "chiaramente sopra il rumore" (mediana + 3·MAD)
    this.score = 0;
  }

  // Aggiunge un campione: t in ms, x/y/z in m/s², rot = velocità di rotazione in °/s (o null).
  // Restituisce null, oppure l'esito di un candidato:
  // { time, strength, ok: true } per un colpo, { time, strength, ok: false, reason } se scartato.
  push(t, x, y, z, rot = null) {
    if (this.prev === null) {
      this.prev = { x, y, z };
      return null;
    }
    const jx = x - this.prev.x;
    const jy = y - this.prev.y;
    const jz = z - this.prev.z;
    this.prev = { x, y, z };
    const s = Math.abs(jz);
    this.score = s;

    const i = this.index++;
    this.buffer.push({ i, t, s, jx, jy, jz, rot });
    const keep = this.cfg.quietSamples + this.cfg.peakWindow + this.cfg.reversalSamples + 6;
    if (this.buffer.length > keep) this.buffer.shift();

    let event = null;
    if (this.candidate) {
      const c = this.candidate;
      if (i < c.start + this.cfg.peakWindow && s > this.at(c.peak).s) c.peak = i;
      if (i >= c.peak + this.cfg.reversalSamples && i >= c.start + this.cfg.peakWindow) {
        event = this.evaluate(c);
        this.candidate = null;
      }
    } else if (this.noise.length >= this.cfg.warmup && s > this.threshold &&
      t - this.lastTapTime > this.cfg.refractoryMs) {
      this.candidate = { start: i, peak: i };
    }

    // Il rumore di fondo si stima senza i candidati e senza il "rimbombo" dei colpi.
    if (!this.candidate && !event && t - this.lastTapTime > this.cfg.refractoryMs) this.updateNoise(s);
    return event;
  }

  // Campione con indice assoluto i, se ancora nel buffer.
  at(i) {
    return this.buffer[this.buffer.length - 1 - (this.index - 1 - i)];
  }

  evaluate(c) {
    const cfg = this.cfg;
    const strength = this.at(c.peak).s;
    const time = this.refine(c.peak);
    const verdict = (ok, reason) => {
      if (!ok) return { time, strength, ok: false, reason };
      this.lastTapTime = time;
      this.strengths = this.strengths.filter((e) => time - e.t < cfg.strengthMemoryMs);
      this.strengths.push({ t: time, strength });
      if (this.strengths.length > 8) this.strengths.shift();
      return { time, strength, ok: true };
    };

    // "Forte" = sopra la frazione del picco e chiaramente sopra il rumore della mano.
    const loud = (value, ratio) => value > Math.max(ratio * strength, this.noiseLevel);

    // Quiete prima. Si salta il campione subito prima del superamento, che può già
    // appartenere al fronte del colpo, e quelli ancora nel rimbombo del colpo precedente.
    const before = [];
    for (let i = c.start - 1 - cfg.quietSamples; i <= c.start - 2; i++) {
      const p = this.at(i);
      if (p && p.t - this.lastTapTime > cfg.echoMs) before.push(p);
    }
    if (before.some((p) => loud(p.s, cfg.quietRatio))) return verdict(false, 'moving');
    const rotations = before.map((p) => p.rot).filter((r) => typeof r === 'number');
    if (rotations.length && rotations.reduce((a, b) => a + b, 0) / rotations.length > cfg.maxRotation) {
      return verdict(false, 'moving');
    }

    // Spinta e ritorno: un colpo torna subito indietro, uno spostamento liscio no.
    // Il picco può essere la spinta o il ritorno, quindi si guarda tutto il colpo.
    const peak = this.at(c.peak);
    let reversal = 0;
    for (let i = c.start; i <= c.peak + cfg.reversalSamples; i++) {
      const p = this.at(i);
      if (Math.sign(p.jz) === -Math.sign(peak.jz)) reversal = Math.max(reversal, Math.abs(p.jz));
    }
    if (reversal < cfg.reversalRatio * strength) return verdict(false, 'smooth');

    // Direzione: quota del jerk lungo z sul fronte del colpo.
    let ez = 0;
    let eAll = 0;
    for (let i = c.start; i <= c.peak + 1; i++) {
      const p = this.at(i);
      ez += p.jz * p.jz;
      eAll += p.jx * p.jx + p.jy * p.jy + p.jz * p.jz;
    }
    if (eAll > 0 && Math.sqrt(ez / eAll) < cfg.zShare) return verdict(false, 'sideways');

    // Forza: dopo tre colpi validi, niente tocchi molto più deboli dei soliti.
    const recent = this.strengths.filter((e) => time - e.t < cfg.strengthMemoryMs).map((e) => e.strength);
    if (recent.length >= 3) {
      const sorted = [...recent].sort((a, b) => a - b);
      if (strength < cfg.relativeStrength * sorted[sorted.length >> 1]) return verdict(false, 'weak');
    }

    return verdict(true);
  }

  // Interpolazione parabolica del picco con i due campioni vicini.
  refine(peakIndex) {
    const prev = this.at(peakIndex - 1);
    const peak = this.at(peakIndex);
    const next = this.at(peakIndex + 1);
    if (!prev || !next) return peak.t;
    const denom = prev.s - 2 * peak.s + next.s;
    if (denom >= 0) return peak.t;
    const offset = Math.max(-0.5, Math.min(0.5, 0.5 * (prev.s - next.s) / denom));
    const step = offset < 0 ? peak.t - prev.t : next.t - peak.t;
    return peak.t + offset * step;
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
    this.noiseLevel = median + 3 * mad;
  }
}
