// Tabelle dei passaggi tra accordi (bigrammi), relative alla tonica, separate per modo:
// P(accordo successivo | accordo) contando solo i cambi (non le ripetizioni dello stesso
// accordo). Fonti: McGill Billboard (CC0) e l'analisi armonica di RS 200 di de Clercq &
// Temperley ("A corpus analysis of rock harmony", Popular Music 2011; CC BY 4.0).
// Uso: node lab/progressions-tables.mjs [--write]  → audio/progression-model.json
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA } from './common.mjs';
import { loadBillboard } from './billboard.mjs';

// ---------- Billboard ----------

// Successione degli accordi di un brano (cache di billboard.mjs) come stati relativi 0–23
// (grado + 12 se minore), con null dove la catena si interrompe (N, esclusi, cambio di tonica).
export function billboardSequence(song) {
  if (!song.key) return [];
  const out = [];
  let prevTonic = null;
  for (const bar of song.bars) {
    if (bar.tonic == null) { out.push(null); continue; }
    if (prevTonic !== null && bar.tonic !== prevTonic) out.push(null);
    prevTonic = bar.tonic;
    for (const l of bar.labels) {
      if (l < 0 || l >= 24) { out.push(null); continue; }
      out.push(((l % 12) - bar.tonic + 12) % 12 + (l < 12 ? 0 : 12));
    }
  }
  return out;
}

// ---------- RS 200 ----------

const RS = join(DATA, 'rs200', 'rock_corpus_v2-1', 'rs200_harmony');
const MAJOR_SCALE = { I: 0, II: 2, III: 4, IV: 5, V: 7, VI: 9, VII: 11 };

// Un simbolo come "bVII", "V7/IV", "ii6", "viix7" → stato relativo 0–23, o null (diminuiti,
// semidiminuiti, aumentati: fuori dal vocabolario maggiore/minore).
export function rsChord(token) {
  const [main, applied] = token.split('/');
  const m = /^([b#]*)(VII|VI|V|IV|III|II|I|vii|vi|v|iv|iii|ii|i)(.*)$/.exec(main);
  if (!m) return null;
  const suffix = m[3];
  if (/[oxha+]/.test(suffix.replace(/d7/, ''))) return null;
  let root = MAJOR_SCALE[m[2].toUpperCase()] + [...m[1]].reduce((a, ch) => a + (ch === 'b' ? -1 : 1), 0);
  if (applied) {
    const a = /^([b#]*)(VII|VI|V|IV|III|II|I|vii|vi|v|iv|iii|ii|i)/.exec(applied);
    if (!a) return null;
    root += MAJOR_SCALE[a[2].toUpperCase()] + [...a[1]].reduce((x, ch) => x + (ch === 'b' ? -1 : 1), 0);
  }
  const minor = m[2] === m[2].toLowerCase();
  return (((root % 12) + 12) % 12) + (minor ? 12 : 0);
}

// Espande le regole (macro $Nome, *N, |*N) del file .har e restituisce la successione di
// accordi del brano (regola S), con null ai cambi di tonalità e alle pause.
export function rsSequence(text) {
  const rules = {};
  for (const raw of text.split('\n')) {
    const line = raw.replace(/%.*$/, '').trim();
    const m = /^(\w+):\s*(.*)$/.exec(line);
    if (m) rules[m[1]] = m[2];
  }
  const expand = (body, depth = 0) => {
    if (depth > 20) return [];
    const out = [];
    const tokens = body.split(/\s+/).filter(Boolean);
    let lastBar = [];
    let bar = [];
    for (const tok of tokens) {
      const macro = /^\$(\w+)(?:\*(\d+))?$/.exec(tok);
      if (macro) {
        const inner = expand(rules[macro[1]] || '', depth + 1);
        for (let k = 0; k < Number(macro[2] || 1); k++) out.push(...inner);
        continue;
      }
      const repeat = /^\|\*(\d+)$/.exec(tok);
      if (tok === '|' || repeat) {
        const content = bar.length ? bar : lastBar;
        const times = repeat ? Number(repeat[1]) : 1;
        for (let k = 0; k < times; k++) out.push(...content);
        if (bar.length) lastBar = bar;
        bar = [];
        continue;
      }
      if (/^\[.*\]$/.test(tok)) { if (/^\[[A-G]/.test(tok)) out.push(null); continue; }
      if (tok === '.') continue;
      if (tok === 'R') { bar.push(null); continue; }
      bar.push(rsChord(tok));
    }
    out.push(...bar);
    return out;
  };
  return rules.S ? expand(rules.S) : [];
}

export function rsSongs() {
  if (!existsSync(RS)) return [];
  return readdirSync(RS).filter((f) => f.endsWith('_dt.har')).map((f) => ({ id: f, sequence: rsSequence(readFileSync(join(RS, f), 'utf8')) }));
}

// ---------- Tabelle ----------

// Modo del brano: minore se l'accordo minore sulla tonica è più frequente di quello maggiore.
const modeOf = (seq) => (seq.filter((x) => x === 12).length > seq.filter((x) => x === 0).length ? 'minor' : 'major');

export function countBigrams(sequences) {
  const counts = { major: Array.from({ length: 24 }, () => new Float64Array(24)), minor: Array.from({ length: 24 }, () => new Float64Array(24)) };
  for (const seq of sequences) {
    const mode = modeOf(seq);
    let prev = null;
    for (const x of seq) {
      if (x === null) { prev = null; continue; }
      if (prev !== null && x !== prev) counts[mode][prev][x] += 1;
      prev = x;
    }
  }
  return counts;
}

// log P(b | a) con lisciatura di Lidstone (alpha), arrotondato a 2 decimali.
export function bigramTable(counts, alpha = 0.5) {
  const out = {};
  for (const mode of ['major', 'minor']) {
    out[mode] = counts[mode].map((row, a) => {
      const z = row.reduce((s, v) => s + v, 0) + alpha * 23;
      return Array.from(row, (v, b) => (a === b ? 0 : Math.round(Math.log((v + alpha) / z) * 100) / 100));
    });
  }
  return out;
}

export function sequencesFor(billboardSongs, { rs200 = true } = {}) {
  return [...billboardSongs.map(billboardSequence), ...(rs200 ? rsSongs().map((s) => s.sequence) : [])];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bb = loadBillboard();
  const rs = rsSongs();
  const counts = countBigrams(sequencesFor(bb));
  const total = (m) => counts[m].reduce((s, row) => s + row.reduce((a, v) => a + v, 0), 0);
  console.log(`Billboard ${bb.length} brani + RS 200 ${rs.length}: ${total('major')} cambi in maggiore, ${total('minor')} in minore`);
  const names = ['I', '♭II', 'II', '♭III', 'III', 'IV', '♯IV', 'V', '♭VI', 'VI', '♭VII', 'VII'];
  const nameOf = (s) => (s < 12 ? names[s] : names[s - 12].toLowerCase());
  for (const mode of ['major', 'minor']) {
    const top = [];
    counts[mode].forEach((row, a) => row.forEach((v, b) => top.push([v, a, b])));
    top.sort((x, y) => y[0] - x[0]);
    console.log(mode, top.slice(0, 12).map(([v, a, b]) => `${nameOf(a)}→${nameOf(b)} ${v}`).join(', '));
  }
  if (process.argv.includes('--write')) {
    const out = { version: 1, source: 'McGill Billboard (CC0) + RS 200, de Clercq & Temperley 2011 (CC BY 4.0)', states: 'grado 0–11 maggiore, 12–23 minore', bigram: bigramTable(counts) };
    writeFileSync(new URL('../audio/progression-model.json', import.meta.url), JSON.stringify(out));
    console.log('scritto audio/progression-model.json', JSON.stringify(out).length, 'byte');
  }
}
