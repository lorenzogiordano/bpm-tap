import { loadKeyData } from './keylab.mjs';
for (const d of ['gtzan', 'giantsteps_key']) {
  const t = loadKeyData(d).map((c) => c.tuning).sort((a, b) => a - b);
  const q = (p) => t[Math.floor(p * (t.length - 1))].toFixed(1);
  console.log(d, 'intonazione stimata (centesimi): p5', q(0.05), 'p25', q(0.25), 'mediana', q(0.5), 'p75', q(0.75), 'p95', q(0.95), '| |x|>25:', t.filter((x) => Math.abs(x) > 25).length);
}
