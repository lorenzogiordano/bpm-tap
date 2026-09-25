import { loadKeyData, aggregate } from './keylab.mjs';
import { keyReport } from './common.mjs';
import { PROFILES, keyScores, bestKey } from '../audio/key.js';
const clips = loadKeyData('gtzan', process.argv[2] || 'h4');
const groups = {};
for (const c of clips) (groups[c.item.genre] ??= []).push({ est: bestKey(keyScores(aggregate(c, { norm: 'max' }), PROFILES.bgate)), ref: c.key });
console.table(Object.fromEntries(Object.entries(groups).map(([g, p]) => { const r = keyReport(p); return [g, { n: r.n, esatta: r.exact, scala: r.scale, quinta: r.fifth, relativa: r.relative, parallela: r.parallel, altro: r.other, 'minori%': Math.round(100 * p.filter((x) => x.ref.mode === 'minor').length / p.length) }]; })));
