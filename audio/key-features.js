// Indizi per la tonalità e punteggio delle 24 tonalità: stesso codice per il banco di
// prova (lab/) e per l'app. Ogni indizio è un blocco di 12 valori indicizzato per classe
// di nota (Do = 0); per valutare la tonalità con tonica t il blocco viene "ruotato" su t,
// e i pesi (imparati in lab/) sono gli stessi per tutte le 12 toniche.

const triad = (c, r, third) => Math.cbrt(c[r] * c[(r + third) % 12] * c[(r + 7) % 12]);

// frames: [{ t: 12 valori (acuti), b: 12 valori (basso), tonal }], ciascuno già diviso per il suo massimo.
// Ogni frame pesa tonal^gamma: i momenti di sola batteria o rumore contano poco.
export function chromaBlocks(frames, { gamma = 2 } = {}) {
  const blocks = {
    treble: new Float64Array(12), bass: new Float64Array(12), active: new Float64Array(12),
    majtriad: new Float64Array(12), mintriad: new Float64Array(12),
  };
  let wsum = 0;
  for (const { t, b, tonal } of frames) {
    const w = (tonal || 0) ** gamma;
    wsum += w;
    for (let i = 0; i < 12; i++) {
      blocks.treble[i] += w * t[i];
      blocks.bass[i] += w * b[i];
      if (t[i] > 0.5) blocks.active[i] += w;
      blocks.majtriad[i] += w * triad(t, i, 4);
      blocks.mintriad[i] += w * triad(t, i, 3);
    }
  }
  for (const v of Object.values(blocks)) for (let i = 0; i < 12; i++) v[i] /= wsum || 1;
  // Affidabilità del basso: nella musica la nota al basso appartiene quasi sempre
  // all'armonia di sopra; ronzio e rumori bassi no.
  const corr = (x, y) => {
    const mx = x.reduce((a, v) => a + v, 0) / 12;
    const my = y.reduce((a, v) => a + v, 0) / 12;
    let sxy = 0; let sxx = 0; let syy = 0;
    for (let i = 0; i < 12; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
  };
  const reliability = Math.max(0, corr(blocks.bass, blocks.treble));
  blocks.gbass = blocks.bass.map((v) => v * reliability);
  return blocks;
}

// Blocchi da S-KEY: log-probabilità per tonica (maggiore, minore) e profili interni.
export function skeyBlocks({ p, deep }) {
  const out = { skmaj: new Float64Array(12), skmin: new Float64Array(12) };
  for (let t = 0; t < 12; t++) { out.skmaj[t] = Math.log(p[t] + 1e-4); out.skmin[t] = Math.log(p[t + 12] + 1e-4); }
  for (const [layer, { mean, sd }] of Object.entries(deep || {})) {
    const l = layer.slice(1);
    mean.forEach((v, c) => { out[`d${l}m_${c}`] = Float64Array.from(v); });
    sd.forEach((v, c) => { out[`d${l}s_${c}`] = Float64Array.from(v); });
  }
  return out;
}

// Centra ogni blocco (somma zero) e lo divide per la sua scala (imparata in lab/).
export function standardize(blocks, names, scales) {
  return names.map((name) => {
    const v = blocks[name] || new Float64Array(12);
    const m = v.reduce((a, x) => a + x, 0) / 12;
    const s = scales[name] || 1;
    return Float64Array.from(v, (x) => (x - m) / s);
  });
}

// Punteggi delle 24 tonalità (tonica + 12·minore) con pesi lineari [maggiore, minore].
export function scoreKeys(x, weights) {
  const dims = x.length * 12;
  const scores = new Float64Array(24);
  for (let t = 0; t < 12; t++) {
    for (let m = 0; m < 2; m++) {
      const w = weights[m];
      let s = 0;
      for (let b = 0; b < x.length; b++) {
        const v = x[b];
        const o = b * 12;
        for (let i = 0; i < 12; i++) s += w[o + i] * v[(i + t) % 12];
      }
      scores[t + 12 * m] = s;
    }
  }
  if (dims !== weights[0].length) throw new Error('pesi e indizi non corrispondono');
  return scores;
}

export function softmax(scores) {
  const max = Math.max(...scores);
  const e = Array.from(scores, (s) => Math.exp(s - max));
  const z = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / z);
}
