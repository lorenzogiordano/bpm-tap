// Strumenti di base per l'analisi audio: FFT, finestre, ricampionamento.
// Tutto in JavaScript puro, identico nel browser e in Node (per i test).

// FFT complessa radix-2, in place, su array di reali e immaginari (Float64Array).
export class FFT {
  constructor(size) {
    if (size & (size - 1)) throw new Error('La dimensione della FFT deve essere una potenza di 2');
    this.size = size;
    this.rev = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / size);
    }
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
  }

  transform(re, im, inverse = false) {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sign = inverse ? -1 : 1;
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let start = 0; start < n; start += len) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step];
          const wi = sign * this.sin[k * step];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
  }

  // Spettro di ampiezza (n/2 + 1 valori) di un frame reale già finestrato.
  magnitudes(frame, out = new Float64Array(this.size / 2 + 1)) {
    const { re, im } = this;
    re.set(frame);
    im.fill(0);
    this.transform(re, im);
    for (let k = 0; k < out.length; k++) out[k] = Math.hypot(re[k], im[k]);
    return out;
  }
}

export function hann(size) {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return w;
}

// Accumula campioni e restituisce frame sovrapposti di `size` campioni ogni `hop`.
export class Framer {
  constructor(size, hop) {
    this.size = size;
    this.hop = hop;
    this.buffer = new Float64Array(size * 2);
    this.length = 0;
    this.total = 0;       // campioni ricevuti in tutto
    this.nextEnd = size;  // a quanti campioni totali finisce il prossimo frame
  }

  // Chiama onFrame(frame) per ogni frame completo; il frame è riusato, va copiato se serve.
  push(samples, onFrame) {
    for (let i = 0; i < samples.length; i++) {
      if (this.length === this.buffer.length) {
        this.buffer.copyWithin(0, this.length - this.size, this.length);
        this.length = this.size;
      }
      this.buffer[this.length++] = samples[i];
      this.total += 1;
      if (this.total === this.nextEnd) {
        onFrame(this.buffer.subarray(this.length - this.size, this.length));
        this.nextEnd += this.hop;
      }
    }
  }
}

// Ricampionamento con interpolazione sinc a finestra (Blackman), in streaming.
// Scendendo di frequenza il filtro taglia sotto la nuova Nyquist per evitare aliasing.
export class Resampler {
  constructor(fromRate, toRate, halfWidth = 16) {
    this.ratio = fromRate / toRate;
    this.cutoff = Math.min(1, toRate / fromRate) * 0.95;
    this.halfWidth = Math.ceil(halfWidth / this.cutoff);
    this.history = new Float64Array(0);
    this.position = 0; // posizione (in campioni d'ingresso) del prossimo campione in uscita
    this.table = Resampler.kernelTable(this.halfWidth, this.cutoff);
  }

  static kernelTable(halfWidth, cutoff, phases = 512) {
    const size = 2 * halfWidth;
    const table = new Float64Array((phases + 1) * size);
    for (let p = 0; p <= phases; p++) {
      const frac = p / phases;
      for (let j = 0; j < size; j++) {
        const x = j - halfWidth + 1 - frac;
        const arg = Math.PI * x * cutoff;
        const sinc = x === 0 ? 1 : Math.sin(arg) / arg;
        const w = 0.42 + 0.5 * Math.cos((Math.PI * x) / halfWidth) + 0.08 * Math.cos((2 * Math.PI * x) / halfWidth);
        table[p * size + j] = cutoff * sinc * (Math.abs(x) <= halfWidth ? w : 0);
      }
    }
    return { table, phases, size };
  }

  process(input) {
    if (this.ratio === 1) return Float64Array.from(input);
    const data = new Float64Array(this.history.length + input.length);
    data.set(this.history);
    data.set(input, this.history.length);
    const { table, phases, size } = this.table;
    const out = [];
    const hw = this.halfWidth;
    while (this.position + hw < data.length) {
      const base = Math.floor(this.position);
      const frac = this.position - base;
      const pf = frac * phases;
      const p0 = Math.floor(pf);
      const t = pf - p0;
      let acc = 0;
      const start = base - hw + 1;
      for (let j = 0; j < size; j++) {
        const idx = start + j;
        if (idx < 0) continue;
        const k = (1 - t) * table[p0 * size + j] + t * table[(p0 + 1) * size + j];
        acc += data[idx] * k;
      }
      out.push(acc);
      this.position += this.ratio;
    }
    const keepFrom = Math.max(0, Math.floor(this.position) - hw);
    this.history = data.slice(keepFrom);
    this.position -= keepFrom;
    return Float64Array.from(out);
  }
}
