// Riferimento: i profili classici sulle due raccolte, con alcune varianti di aggregazione.
import { loadKeyData, evaluateProfiles } from './keylab.mjs';

const cache = process.argv[2] || 'base';
for (const dataset of ['gtzan', 'giantsteps_key']) {
  const clips = loadKeyData(dataset, cache);
  for (const options of [{ norm: 'max' }, { norm: 'sum' }, { norm: 'none' }]) {
    const rows = evaluateProfiles(clips, options);
    console.log(`\n${dataset} (${clips.length} brani) — cache ${cache}, normalizzazione per frame: ${options.norm}`);
    console.table(Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, { esatta: v.exact, mirex: v.mirex, scala: v.scale, quinta: v.fifth, relativa: v.relative, parallela: v.parallel, altro: v.other }])));
  }
}
