// Colpi sul MacBook dal sensore di movimento interno (circa 800 campioni al secondo).
//
// Un colpo di nocche sulla scocca è un impatto netto seguito da un'oscillazione smorzata
// (sul MacBook Pro misurata a ~41 Hz, spenta in ~150 ms). Quindi:
//   1. passa-alto a ~10 Hz sui tre assi (via la gravità e gli spostamenti lenti) e modulo;
//   2. un candidato parte quando il modulo supera la soglia: il massimo tra la forza
//      minima (dalla sensibilità) e 6 volte il rumore di fondo recente;
//   3. dopo ogni evento la soglia sale alla coda attesa della sua oscillazione (1,5 volte
//      un inviluppo esponenziale di 60 ms): la coda non diventa un secondo colpo;
//   4. dopo 25 ms si decide: quiete nei 80 ms prima (uno spostamento o la battitura
//      crescono gradualmente o si sovrappongono); oscillazione, cioè il segnale lungo la
//      direzione del picco torna indietro oltre il 30% (un colpo fa vibrare la scocca, uno
//      spostamento no); forza relativa ai colpi precedenti; 120 ms refrattari.
//      L'istante del colpo è il primo campione a metà della forza.
// Gli altoparlanti del Mac non muovono il sensore (verificato a volume massimo).

export const KNOCK_DEFAULTS = {
  sensitivity: 5,        // 1–10
  cutoffHz: 10,          // passa-alto
  decideMs: 25,          // finestra per il massimo del colpo
  preQuietMs: 80,
  preQuietRatio: 0.35,
  ringMs: 60,            // costante di tempo della coda dopo un colpo
  ringMargin: 1.5,
  refractoryMs: 120,
  noiseFactor: 6,
  relativeStrength: 0.3, // dopo 3 colpi, sotto il 30% della forza tipica si scarta
  reversal: 0.3,         // ritorno minimo lungo la direzione del picco
};

export const KNOCK_REJECT_REASONS = {
  moving: 'il Mac si stava muovendo (o stavi scrivendo)',
  smooth: 'spinta senza vibrazione: uno spostamento, non un colpo',
  weak: 'più debole dei colpi precedenti',
  soon: 'troppo vicino al colpo precedente',
};

export class KnockDetector {
  constructor(options = {}) {
    this.cfg = { ...KNOCK_DEFAULTS, ...options };
    this.reset();
  }

  reset() {
    this.lp = null;
    this.lastT = null;
    this.noise = 0.002;
    this.recent = [];          // [t, m] degli ultimi preQuietMs + decideMs
    this.candidate = null;
    this.eventT = -Infinity;   // ultimo evento (accettato o no), per la coda
    this.eventPeak = 0;
    this.acceptedT = -Infinity;
    this.strengths = [];
    this.score = 0;
  }

  setSensitivity(s) {
    this.cfg.sensitivity = s;
  }

  // Forza minima in g: 0,022 g a sensibilità 5 (un colpo di nocche normale, non forte),
  // ×1,25 per ogni passo in meno. Il fondo a riposo sta sotto 0,006 g.
  get minPeak() {
    return 0.022 * 1.25 ** (5 - this.cfg.sensitivity);
  }

  get threshold() {
    return Math.max(this.minPeak, this.cfg.noiseFactor * this.noise);
  }

  // t in ms; x, y, z in g. Restituisce un colpo { time, strength, ok, reason } o null.
  push(t, x, y, z) {
    const { cfg } = this;
    const dt = this.lastT === null ? 1.25 : Math.min(20, Math.max(0.1, t - this.lastT));
    this.lastT = t;
    if (!this.lp) this.lp = [x, y, z];
    const alpha = 1 - Math.exp((-2 * Math.PI * cfg.cutoffHz * dt) / 1000);
    const hx = x - this.lp[0];
    const hy = y - this.lp[1];
    const hz = z - this.lp[2];
    this.lp[0] += alpha * hx;
    this.lp[1] += alpha * hy;
    this.lp[2] += alpha * hz;
    const m = Math.hypot(hx, hy, hz);
    this.score = m;

    this.recent.push([t, m]);
    while (this.recent.length && this.recent[0][0] < t - cfg.preQuietMs - cfg.decideMs - 5) this.recent.shift();

    const ring = this.eventPeak * Math.exp(-(t - this.eventT) / cfg.ringMs) * cfg.ringMargin;
    if (!this.candidate) {
      // Rumore di fondo: media lenta (~0,5 s) aggiornata solo fuori dai colpi e dalle code.
      if (m < this.threshold && ring < this.threshold) this.noise += (m - this.noise) * Math.min(1, dt / 500);
      if (m > this.threshold && m > ring) this.candidate = { start: t, peak: m, peakVec: [hx, hy, hz], samples: [[t, m, hx, hy, hz]] };
      return null;
    }
    const c = this.candidate;
    c.samples.push([t, m, hx, hy, hz]);
    if (m > c.peak) { c.peak = m; c.peakVec = [hx, hy, hz]; }
    if (t - c.start < cfg.decideMs) return null;
    this.candidate = null;
    return this.decide(c);
  }

  decide(c) {
    const { cfg } = this;
    const strength = c.peak;
    const onset = c.samples.find(([, m]) => m >= 0.5 * strength)[0];
    let before = 0;
    for (const [t, m] of this.recent) if (t >= c.start - cfg.preQuietMs && t < c.start - 5) before = Math.max(before, m);
    // Coda del colpo precedente: non conta come "movimento".
    const ringBefore = this.eventPeak * Math.exp(-(c.start - cfg.preQuietMs - this.eventT) / cfg.ringMs);
    // Ritorno: il minimo della proiezione sulla direzione del picco.
    const [px, py, pz] = c.peakVec;
    let back = 0;
    for (const [, , x, y, z] of c.samples) back = Math.min(back, (x * px + y * py + z * pz) / strength);
    let reason = null;
    if (c.start - this.acceptedT < cfg.refractoryMs) reason = 'soon';
    else if (before > cfg.preQuietRatio * strength && before > ringBefore) reason = 'moving';
    else if (-back < cfg.reversal * strength) reason = 'smooth';
    else if (this.strengths.length >= 3) {
      const typical = [...this.strengths].sort((a, b) => a - b)[this.strengths.length >> 1];
      if (strength < cfg.relativeStrength * typical) reason = 'weak';
    }
    this.eventT = c.start;
    this.eventPeak = strength;
    const ok = reason === null;
    if (ok) {
      this.acceptedT = c.start;
      this.strengths.push(strength);
      if (this.strengths.length > 8) this.strengths.shift();
    }
    return { time: onset, strength, ok, reason };
  }
}
