// Caratteristiche per la tonalità, per brano: blocchi di 12 valori indicizzati per
// classe di nota (o per fondamentale di accordo), da ruotare sulla tonica candidata.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fold36 } from './keylab.mjs';
import { CACHE } from './common.mjs';

const triad = (c, r, third) => Math.cbrt(c[r] * c[(r + third) % 12] * c[(r + 7) % 12]);

// Cromagramma a 12 classi di ogni frame (acuti e basso, normalizzati al massimo), saltando i frame vuoti.
export function frameSeries(clip) {
  const out = [];
  for (let f = 0; f < clip.n; f++) {
    const t = fold36(clip.frames, f * 72);
    const b = fold36(clip.frames, f * 72 + 36);
    const tm = Math.max(...t);
    if (!(tm > 0)) continue;
    const bm = Math.max(...b);
    out.push({ t: t.map((v) => v / tm), b: bm > 0 ? b.map((v) => v / bm) : new Float64Array(12) });
  }
  return out;
}

// Peso di ogni frame: 'none' (uguale), 'tonal' (quota di energia nelle note).
function frameWeights(clip, weighting, gamma) {
  const tonal = clip.meta?.tonal || [];
  const out = [];
  for (let f = 0; f < clip.n; f++) out.push(weighting === 'tonal' ? (tonal[f] || 0) ** gamma : 1);
  return out;
}

// Cromagrammi medi (acuti, basso) sugli intervalli tra battiti scelti, pesati.
function metricBlocks(clip, series, frameIndex) {
  const beats = clip.meta?.beats || [];
  const strength = clip.meta?.beatStrength || [];
  const hop = clip.meta?.hop || 4096 / 22050;
  const centre = (f) => f * hop + 0.186;
  const blocks = { strongtreble: new Float64Array(12), strongbass: new Float64Array(12), dbtreble: new Float64Array(12), dbbass: new Float64Array(12) };
  if (beats.length < 8) return blocks;
  // Cromagramma di ogni battito: media dei frame il cui centro cade nel battito.
  const beatChroma = [];
  let j = 0;
  for (let i = 0; i < beats.length - 1; i++) {
    const t = new Float64Array(12);
    const b = new Float64Array(12);
    let cnt = 0;
    while (j < series.length && centre(frameIndex[j]) < beats[i]) j += 1;
    for (let k = j; k < series.length && centre(frameIndex[k]) < beats[i + 1]; k++) {
      for (let p = 0; p < 12; p++) { t[p] += series[k].t[p]; b[p] += series[k].b[p]; }
      cnt += 1;
    }
    beatChroma.push(cnt ? { t: t.map((v) => v / cnt), b: b.map((v) => v / cnt), s: strength[i] || 0 } : null);
  }
  // Primo tempo della battuta: la fase (su 4) in cui il basso cambia di più rispetto al battito prima.
  const change = [0, 0, 0, 0];
  for (let i = 1; i < beatChroma.length; i++) {
    if (!beatChroma[i] || !beatChroma[i - 1]) continue;
    let d = 0;
    for (let p = 0; p < 12; p++) d += Math.abs(beatChroma[i].b[p] - beatChroma[i - 1].b[p]);
    change[i % 4] += d;
  }
  const phase = change.indexOf(Math.max(...change));
  let ws = 0;
  let wd = 0;
  beatChroma.forEach((c, i) => {
    if (!c) return;
    for (let p = 0; p < 12; p++) { blocks.strongtreble[p] += c.s * c.t[p]; blocks.strongbass[p] += c.s * c.b[p]; }
    ws += c.s;
    if (i % 4 === phase) {
      for (let p = 0; p < 12; p++) { blocks.dbtreble[p] += c.t[p]; blocks.dbbass[p] += c.b[p]; }
      wd += 1;
    }
  });
  for (let p = 0; p < 12; p++) {
    blocks.strongtreble[p] /= ws || 1; blocks.strongbass[p] /= ws || 1;
    blocks.dbtreble[p] /= wd || 1; blocks.dbbass[p] /= wd || 1;
  }
  return blocks;
}

// Blocchi disponibili. Le transizioni guardano a `lag` frame di distanza (~1 s).
export function clipBlocks(clip, { lag = 5, weighting = 'none', gamma = 1 } = {}) {
  const series = frameSeries(clip);
  const frameIndex = [];
  for (let f = 0; f < clip.n; f++) {
    let any = false;
    for (let b = 0; b < 36; b++) if (clip.frames[f * 72 + b] > 0) { any = true; break; }
    if (any) frameIndex.push(f);
  }
  const allWeights = frameWeights(clip, weighting, gamma);
  const weights = frameIndex.map((f) => allWeights[f]);
  const n = Math.max(1, series.length);
  const blocks = {
    treble: new Float64Array(12), bass: new Float64Array(12), active: new Float64Array(12),
    majtriad: new Float64Array(12), mintriad: new Float64Array(12),
    bassmaj: new Float64Array(12), bassmin: new Float64Array(12),
    cadmaj: new Float64Array(12), cadmin: new Float64Array(12),   // V(maggiore) → I, per tonica
    lastbass: new Float64Array(12),
  };
  // Coppie di note (intervallo, nota più bassa): 12 blocchi, uno per intervallo.
  for (let iv = 1; iv <= 6; iv++) blocks[`dyad${iv}`] = new Float64Array(12);
  const maj = [];
  const min = [];
  let wsum = 0;
  series.forEach(({ t, b }, si) => {
    const w = weights[si] ?? 1;
    wsum += w;
    const fm = new Float64Array(12);
    const fn = new Float64Array(12);
    for (let i = 0; i < 12; i++) {
      blocks.treble[i] += w * t[i];
      blocks.bass[i] += w * b[i];
      if (t[i] > 0.5) blocks.active[i] += w;
      fm[i] = triad(t, i, 4);
      fn[i] = triad(t, i, 3);
      blocks.majtriad[i] += w * fm[i];
      blocks.mintriad[i] += w * fn[i];
      blocks.bassmaj[i] += w * fm[i] * b[i];
      blocks.bassmin[i] += w * fn[i] * b[i];
      for (let iv = 1; iv <= 6; iv++) blocks[`dyad${iv}`][i] += w * Math.min(t[i], t[(i + iv) % 12]);
    }
    maj.push(fm);
    min.push(fn);
  });
  for (let f = lag; f < maj.length; f++) {
    for (let r = 0; r < 12; r++) {
      const dominant = maj[f - lag][(r + 7) % 12];
      blocks.cadmaj[r] += dominant * maj[f][r];
      blocks.cadmin[r] += dominant * min[f][r];
    }
  }
  // Basso degli ultimi secondi (dove la frase tende a risolvere): qui solo come prova.
  for (let f = Math.max(0, series.length - 16); f < series.length; f++) {
    for (let i = 0; i < 12; i++) blocks.lastbass[i] += series[f].b[i];
  }
  const norm = weighting === 'none' ? n : wsum || 1;
  for (const v of Object.values(blocks)) for (let i = 0; i < 12; i++) v[i] /= norm;
  // Affidabilità del basso: nella musica vera la nota al basso appartiene quasi sempre
  // all'armonia di sopra; ronzio e rumori bassi no. Pesa il basso con la correlazione
  // (positiva) tra cromagramma del basso e degli acuti.
  const corr = (x, y) => {
    const mx = x.reduce((a, b) => a + b, 0) / 12;
    const my = y.reduce((a, b) => a + b, 0) / 12;
    let sxy = 0; let sxx = 0; let syy = 0;
    for (let i = 0; i < 12; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
  };
  const reliability = Math.max(0, corr(blocks.bass, blocks.treble));
  const gbass = blocks.bass.map((v) => v * reliability);
  return { ...blocks, gbass, ...metricBlocks(clip, series, frameIndex) };
}

// Probabilità di S-KEY (ordine: tonica C=0, maggiori 0-11, minori 12-23), se calcolate.
const skeyCache = new Map();
function skeyProbs(clip) {
  const ds = `${clip.item.dataset}${clip.condition ? `-${clip.condition}` : ''}`;
  if (!skeyCache.has(ds)) {
    const path = join(CACHE, '..', 'skey', `${ds}.json`);
    skeyCache.set(ds, existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {});
  }
  return skeyCache.get(ds)[clip.item.id] || null;
}

// Strati interni di S-KEY (profili sulle 12 note per canale), se calcolati.
const deepCache = new Map();
function skeyDeep(clip) {
  const key = `${clip.item.dataset}${clip.condition ? `-${clip.condition}` : ''}`;
  if (!deepCache.has(key)) {
    const path = join(CACHE, '..', 'skey', `${key}.deep.json`);
    deepCache.set(key, existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {});
  }
  return deepCache.get(key)[clip.item.id] || null;
}

function withSkey(clip, blocks) {
  const p = skeyProbs(clip);
  const skmaj = new Float64Array(12);
  const skmin = new Float64Array(12);
  if (p) for (let t = 0; t < 12; t++) { skmaj[t] = Math.log(p[t] + 1e-4); skmin[t] = Math.log(p[t + 12] + 1e-4); }
  const out = { ...blocks, skmaj, skmin };
  const deep = skeyDeep(clip);
  if (deep) {
    for (const [layer, { mean, sd }] of Object.entries(deep)) {
      const l = layer.slice(1);
      mean.forEach((v, c) => { out[`d${l}m_${c}`] = Float64Array.from(v); });
      sd.forEach((v, c) => { out[`d${l}s_${c}`] = Float64Array.from(v); });
    }
  }
  return out;
}

// Abbreviazioni: deep5 → d5m_0 … d5m_9 (medie), deep5s → d5s_* (deviazioni).
const CHANNELS = { 3: 40, 4: 30, 5: 10, 6: 3 };
export function expandBlocks(names) {
  return names.flatMap((n) => {
    const m = n.match(/^deep(\d)(s?)$/);
    if (!m) return [n];
    return Array.from({ length: CHANNELS[m[1]] }, (_, c) => `d${m[1]}${m[2] ? 's' : 'm'}_${c}`);
  });
}

// Centra ogni blocco e lo scala con la deviazione standard globale di quel tipo di blocco.
export function prepare(clips, blockNames, options) {
  const raw = clips.map((c) => {
    const blocks = withSkey(c, clipBlocks(c, options));
    // Seconda variante del cromagramma (se presente): blocchi con prefisso "alt_".
    if (c.alt) for (const [name, v] of Object.entries(clipBlocks(c.alt, options))) blocks[`alt_${name}`] = v;
    return { key: c.key, clip: c, blocks };
  });
  const scale = {};
  for (const name of blockNames) {
    let sum = 0;
    let cnt = 0;
    for (const r of raw) {
      const v = r.blocks[name] || (r.blocks[name] = new Float64Array(12)); // indizio mancante: zeri
      const m = v.reduce((a, b) => a + b, 0) / 12;
      for (const x of v) { sum += (x - m) ** 2; cnt += 1; }
    }
    scale[name] = Math.sqrt(sum / cnt) || 1;
  }
  const result = raw.map((r) => ({
    key: r.key,
    label: r.key.tonic + (r.key.mode === 'minor' ? 12 : 0),
    genre: r.clip.item.genre,
    raw: r.blocks,
    x: blockNames.map((name) => {
      const v = r.blocks[name];
      const m = v.reduce((a, b) => a + b, 0) / 12;
      return Float64Array.from(v, (x) => (x - m) / scale[name]);
    }),
  }));
  result.scale = scale;
  return result;
}

export function rotated(x, t) {
  const out = new Float64Array(x.length * 12);
  x.forEach((v, b) => { for (let i = 0; i < 12; i++) out[b * 12 + i] = v[(i + t) % 12]; });
  return out;
}
