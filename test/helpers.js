// Generatore pseudo-casuale deterministico (mulberry32) e gaussiana (Box–Muller),
// per test riproducibili.
export function rng(seed) {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => {
    const u = Math.max(uniform(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * uniform());
  };
  return { uniform, gauss };
}

// Tempi di tap umani: griglia di battiti + scarto gaussiano indipendente su ogni tap.
export function humanTaps({ bpm, n, jitterMs, start = 1000, random }) {
  const period = 60000 / bpm;
  return Array.from({ length: n }, (_, i) => start + i * period + jitterMs * random.gauss());
}

// Canzone sintetica per le prove della struttura: sezioni con il loro giro (accordi 0–23, una
// battuta ciascuno salvo [accordo, battute]), basso, accordo ribattuto, cassa e charleston.
// level: volume della sezione (il ritornello più forte). Restituisce Float32Array mono.
export function synthSong(sections, { bpm = 100, sampleRate = 22050, seed = 1 } = {}) {
  const random = rng(seed);
  const beat = 60 / bpm;
  const bars = [];
  for (const sec of sections) {
    for (let r = 0; r < (sec.repeat || 1); r++) {
      for (const item of sec.chords) {
        const [chord, length] = Array.isArray(item) ? item : [item, 1];
        for (let k = 0; k < length; k++) bars.push({ chord, level: sec.level || 1, busy: sec.busy || false });
      }
    }
  }
  const total = Math.ceil(bars.length * 4 * beat * sampleRate);
  const out = new Float32Array(total);
  const hz = (m) => 440 * 2 ** ((m - 69) / 12);
  const add = (start, length, fn) => {
    const s0 = Math.round(start * sampleRate);
    const n = Math.round(length * sampleRate);
    for (let j = 0; j < n && s0 + j < total; j++) out[s0 + j] += fn(j / sampleRate);
  };
  bars.forEach((bar, b) => {
    const root = bar.chord % 12;
    const third = bar.chord < 12 ? 4 : 3;
    const notes = [60 + root, 60 + root + third, 60 + root + 7].map((m) => (m > 71 ? m - 12 : m));
    const bass = 36 + root;
    for (let q = 0; q < 4; q++) {
      const t = (b * 4 + q) * beat;
      const env = (x) => Math.min(1, x * 200) * Math.exp(-3 * x);
      // Accordo sul primo e terzo battito (sugli altri più piano), basso sul primo e terzo.
      const chordLevel = (q % 2 === 0 ? 0.05 : 0.03) * bar.level;
      add(t, beat, (x) => env(x) * chordLevel * notes.reduce((a, m) => a + Math.sin(2 * Math.PI * hz(m) * x) + 0.4 * Math.sin(4 * Math.PI * hz(m) * x), 0));
      if (q % 2 === 0) add(t, beat * 1.9, (x) => env(x) * 0.08 * bar.level * (Math.sin(2 * Math.PI * hz(bass) * x) + 0.5 * Math.sin(4 * Math.PI * hz(bass) * x)));
      // Cassa sui battiti 1 e 3, rullante (rumore) su 2 e 4, charleston a ottavi se "busy".
      if (q % 2 === 0) add(t, 0.15, (x) => 0.25 * bar.level * Math.exp(-25 * x) * Math.sin(2 * Math.PI * (60 + 60 * Math.exp(-30 * x)) * x));
      else add(t, 0.12, (x) => 0.08 * bar.level * Math.exp(-30 * x) * (random.uniform() * 2 - 1));
      if (bar.busy) for (const h of [0, 0.5]) add(t + h * beat, 0.04, (x) => 0.03 * Math.exp(-80 * x) * (random.uniform() * 2 - 1));
    }
  });
  return out;
}
