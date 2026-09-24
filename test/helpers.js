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
