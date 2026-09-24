// Stima del tempo (BPM) da una sequenza di tap.
//
// Metodo: regressione lineare ai minimi quadrati dei tempi dei tap rispetto
// all'indice del battito, t_k ≈ a + P·k. La pendenza P è il periodo.
// È lo stimatore di nayuki.io/page/tap-to-measure-tempo-javascript e di
// lindr0s/bpm-counter. Con un errore casuale σ su ogni tap il suo errore
// standard vale σ·√(12 / (n(n²−1))), cioè scala come n^-1.5; la media degli
// intervalli invece si riduce a (ultimo − primo)/(n − 1) e scala come n^-1.
// Per questo la precisione cresce così in fretta con il numero di tap.
//
// Robustezza:
// - a ogni tap si assegna l'indice di battito più vicino alla griglia prevista,
//   così un battito saltato non falsa la stima (ArduinoTapTempo gestisce allo
//   stesso modo intervalli di 1.75–2.75 periodi);
// - i tap lontani dalla griglia vengono scartati; se più tap consecutivi sono
//   fuori griglia ma coerenti tra loro, il tempo è cambiato e si riparte;
// - la sessione finisce dopo una pausa (2–3 s nelle app esistenti).

export const DEFAULTS = {
  minBpm: 30,
  maxBpm: 300,
  // Scarto tipico di un tap rispetto al battito, in frazione del periodo.
  // Repp (2005): ~2% per musicisti esperti, almeno il doppio per non esperti.
  priorJitter: 0.04,
  // Peso della stima a priori, in gradi di libertà: con pochi tap il margine
  // d'errore non crolla solo perché due o tre tap sono capitati allineati.
  priorWeight: 4,
  // Scarto ammesso dalla griglia: toleranceSigmas volte l'errore di previsione
  // (largo con pochi tap, stretto quando la stima è solida), entro
  // [minTolerance, maxTolerance] periodi.
  toleranceSigmas: 3.5,
  minTolerance: 0.15,
  maxTolerance: 0.4,
  // Quanto devono essere regolari tra loro i tap scartati per dire "è cambiato il tempo".
  changeTolerance: 0.25,
  // Distanza massima, in battiti, tra due tap consecutivi (1 = nessun battito
  // saltato). Un tap perso è più probabile di un tap in più, quindi se ne
  // accetta uno già dal terzo tap; con la griglia solida anche di più.
  earlyMaxGap: 2,
  maxGap: 4,
  minTapsForLongGaps: 5,
  // Tap fuori griglia consecutivi (e coerenti tra loro) che indicano un cambio di tempo.
  changeAfter: 3,
  // Tap minimi perché la misura sia considerata valida (Mixxx: 4).
  minTaps: 4,
  // Pausa che chiude la sessione: timeoutBeats periodi, entro [timeoutMin, timeoutMax] ms.
  timeoutBeats: 2.5,
  timeoutMin: 2000,
  timeoutMax: 5000,
};

const Z95 = 1.96;

export class TempoEstimator {
  constructor(options = {}) {
    this.cfg = { ...DEFAULTS, ...options };
    this.minPeriod = 60000 / this.cfg.maxBpm;
    this.maxPeriod = 60000 / this.cfg.minBpm;
    this.reset();
  }

  reset() {
    this.origin = 0;       // tempo assoluto del primo tap: i tempi interni sono relativi
    this.taps = [];        // { t, k }: tempo relativo (ms) e indice del battito
    this.streak = [];      // tempi assoluti dei tap scartati consecutivi
    this.offGrid = [];     // tempi relativi dei tap scartati perché fuori griglia
    this.lastTime = null;  // tempo assoluto dell'ultimo tap accettato
    this.fitCache = null;
  }

  get count() {
    return this.taps.length;
  }

  // Periodo corrente: dalla regressione, o dall'unico intervallo disponibile.
  currentPeriod() {
    return this.taps.length >= 2 ? this.fit().period : null;
  }

  timeoutMs() {
    const period = this.currentPeriod();
    if (period === null) return this.maxPeriod + 250;
    const { timeoutBeats, timeoutMin, timeoutMax } = this.cfg;
    return Math.min(timeoutMax, Math.max(timeoutMin, timeoutBeats * period));
  }

  isExpired(now) {
    return this.lastTime === null || now - this.lastTime > this.timeoutMs();
  }

  // Registra un tap al tempo `time` (ms). Restituisce cosa è successo:
  // start | accepted | rejected | restart, più il motivo dello scarto.
  addTap(time) {
    if (this.isExpired(time)) {
      this.startAt([time]);
      return { status: 'start' };
    }

    const t = time - this.origin;
    const last = this.taps[this.taps.length - 1];

    if (this.taps.length === 1) {
      const dt = t - last.t;
      if (dt < this.minPeriod) return this.reject(time, 'too-close');
      if (dt > this.maxPeriod) {
        this.startAt([time]);
        return { status: 'start' };
      }
      this.accept(t, 1, time);
      return { status: 'accepted' };
    }

    const f = this.fit();
    const k = Math.round((t - f.intercept) / f.period);
    const gap = k - last.k;
    if (gap < 1) return this.reject(time, 'too-close');

    const maxGap = this.taps.length >= this.cfg.minTapsForLongGaps ? this.cfg.maxGap : this.cfg.earlyMaxGap;
    const residual = t - (f.intercept + f.period * k);
    const { toleranceSigmas, minTolerance, maxTolerance } = this.cfg;
    const allowed = f.period * Math.min(maxTolerance,
      Math.max(minTolerance, toleranceSigmas * this.predictionError(f, k) / f.period));

    if (gap > maxGap || Math.abs(residual) > allowed) return this.reject(time, 'off-grid');

    this.accept(t, k, time);
    return { status: 'accepted' };
  }

  startAt(times) {
    this.reset();
    this.origin = times[0];
    times.forEach((time, i) => this.taps.push({ t: time - this.origin, k: i }));
    this.lastTime = times[times.length - 1];
  }

  accept(t, k, time) {
    this.taps.push({ t, k });
    this.lastTime = time;
    this.streak = [];
    this.fitCache = null;
  }

  reject(time, reason) {
    // I doppi tap (echi, rimbalzi) non dicono nulla sul tempo: si ignorano e basta.
    if (reason !== 'off-grid') return { status: 'rejected', reason };

    this.offGrid.push(time - this.origin);
    if (this.offGrid.length > 8) this.offGrid.shift();
    if (this.tryHalfGrid(time)) return { status: 'accepted', reason: 'half-grid' };

    this.streak.push(time);
    if (this.streak.length > this.cfg.changeAfter) this.streak.shift();

    // Cambio di tempo: gli ultimi tap scartati formano da soli una griglia coerente.
    if (this.streak.length === this.cfg.changeAfter) {
      const gaps = this.streak.slice(1).map((v, i) => v - this.streak[i]);
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const coherent = mean >= this.minPeriod && mean <= this.maxPeriod &&
        gaps.every((g) => Math.abs(g - mean) <= this.cfg.changeTolerance * mean);
      if (coherent) {
        this.startAt(this.streak);
        return { status: 'restart', reason: 'tempo-change' };
      }
    }
    return { status: 'rejected', reason };
  }

  // Se il secondo tap si perde, il primo intervallo vale due battiti e la griglia
  // nasce a metà tempo: da lì un tap su due cade esattamente a metà tra due
  // battiti e verrebbe scartato. Quando almeno due tap scartati stanno a metà
  // griglia, la griglia si dimezza e quei tap vengono recuperati.
  tryHalfGrid(time) {
    const f = this.fit();
    const half = f.period / 2;
    if (half < this.minPeriod) return false;
    const halfway = this.offGrid.filter((t) => {
      const x = (t - f.intercept) / half;
      const k = Math.round(x);
      return Math.abs(x - k) < 0.2 && Math.abs(k % 2) === 1;
    });
    if (halfway.length < 2) return false;

    const times = [...this.taps.map((p) => p.t), ...halfway].sort((a, b) => a - b);
    const ks = times.map((t) => Math.round((t - f.intercept) / half));
    if (ks.some((k, i) => i > 0 && k <= ks[i - 1])) return false;

    const backup = this.taps;
    this.taps = times.map((t, i) => ({ t, k: ks[i] - ks[0] }));
    this.fitCache = null;
    const nf = this.fit();
    if (Math.sqrt(nf.sse / Math.max(1, nf.n - 2)) > 0.2 * nf.period) {
      this.taps = backup;
      this.fitCache = null;
      return false;
    }
    this.offGrid = this.offGrid.filter((t) => !halfway.includes(t));
    this.streak = [];
    this.lastTime = Math.max(this.lastTime, time);
    return true;
  }

  // Regressione centrata (numericamente stabile) di t rispetto a k.
  fit() {
    if (this.fitCache) return this.fitCache;
    const taps = this.taps;
    const n = taps.length;
    let mk = 0;
    let mt = 0;
    for (const p of taps) { mk += p.k; mt += p.t; }
    mk /= n;
    mt /= n;
    let skk = 0;
    let skt = 0;
    for (const p of taps) {
      const dk = p.k - mk;
      skk += dk * dk;
      skt += dk * (p.t - mt);
    }
    const period = skt / skk;
    const intercept = mt - period * mk;
    let sse = 0;
    for (const p of taps) {
      const r = p.t - (intercept + period * p.k);
      sse += r * r;
    }
    // Varianza del tap: media pesata tra la stima a priori e i residui osservati.
    const prior = this.cfg.priorJitter * period;
    const dof = n - 2;
    const variance = (this.cfg.priorWeight * prior * prior + sse) / (this.cfg.priorWeight + dof);
    this.fitCache = { n, mk, skk, period, intercept, sse, variance };
    return this.fitCache;
  }

  // Dove cadrà il primo battito dopo l'istante `after` (tempo assoluto, ms) e con che margine.
  nextBeat(after = this.lastTime) {
    if (this.taps.length < 2) return null;
    const f = this.fit();
    let k = this.taps[this.taps.length - 1].k + 1;
    const beatTime = (i) => this.origin + f.intercept + f.period * i;
    while (beatTime(k) < after + 0.5 * f.period) k += 1;
    const halfWidth = Math.min(0.3 * f.period, Math.max(60, 3 * this.predictionError(f, k)));
    return { time: beatTime(k), halfWidth };
  }

  // Errore standard della posizione prevista del battito k (intervallo di previsione).
  predictionError(f, k) {
    return Math.sqrt(f.variance * (1 + 1 / f.n + ((k - f.mk) ** 2) / f.skk));
  }

  result() {
    if (this.taps.length < 2) return null;
    const f = this.fit();
    const bpm = 60000 / f.period;
    const sePeriod = Math.sqrt(f.variance / f.skk);
    const seBpm = bpm * sePeriod / f.period;
    return {
      bpm,
      period: f.period,
      seBpm,
      halfWidth: Z95 * seBpm,
      taps: f.n,
      beats: this.taps[this.taps.length - 1].k + 1,
      jitterMs: f.n > 2 ? Math.sqrt(f.sse / (f.n - 2)) : null,
      valid: f.n >= this.cfg.minTaps,
    };
  }
}

// ---------- Presentazione ----------

// Un decimale solo quando il margine al 95% scende sotto 1 BPM,
// così il numero non "balla" sui decimali finché la stima è grezza.
export function formatBpm(bpm, halfWidth) {
  const decimals = halfWidth < 1 ? 1 : 0;
  const text = bpm.toFixed(decimals);
  const [int, dec] = text.split('.');
  return { int, dec: dec ? `.${dec}` : '', decimals };
}

export function formatHalfWidth(halfWidth) {
  if (halfWidth >= 10) return `±${Math.round(halfWidth)}`;
  return `±${halfWidth.toFixed(halfWidth < 1 ? 2 : 1)}`;
}

// Livello di precisione 0–1 (scala logaritmica: ±5 BPM → 0, ±0.1 BPM → 1) ed etichetta.
export function quality(result, minTaps = DEFAULTS.minTaps) {
  if (!result) return { level: 0, label: '' };
  const level = Math.min(1, Math.max(0, Math.log(5 / result.halfWidth) / Math.log(50)));
  if (result.taps < minTaps) return { level, label: 'Continua a battere…' };
  const hw = result.halfWidth;
  const label = hw >= 3 ? 'Stima grezza'
    : hw >= 1 ? 'Si sta stabilizzando'
    : hw >= 0.4 ? 'Buona'
    : hw >= 0.15 ? 'Precisa'
    : 'Molto precisa';
  return { level, label };
}
