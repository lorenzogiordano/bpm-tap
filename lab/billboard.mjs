// McGill Billboard (Burgoyne, Wild, Fujinaga, ISMIR 2011; CC0): accordi, sezioni e
// funzioni annotati a mano su ~740 canzoni delle classifiche 1958–1991. Niente audio, ma per
// ogni brano ci sono il cromagramma NNLS di Chordino (basso e acuti, lo stesso tipo del
// nostro) e l'analisi di Echo Nest (battiti, battute, volume e timbro per segmento).
//
// Questo modulo legge il formato "salami_chords" e costruisce la cache per le prove della
// struttura: per ogni brano, battiti di Echo Nest con cromagramma medio, volume e timbro, più
// il riferimento (sezioni con lettera e funzione, battute con i loro accordi, tonica).
// Uso: node lab/billboard.mjs  → cache/structure/billboard.json
//
// Dati in lab/work/data/billboard/raw/McGill-Billboard/<id>/ (salami_chords.txt,
// bothchroma.csv, echonest.json), dagli archivi del sito DDMAL (vedi lab/README.md).

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA, CACHE } from './common.mjs';

export const BILLBOARD = join(DATA, 'billboard', 'raw', 'McGill-Billboard');

const PITCH = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function pitchClass(name) {
  let pc = PITCH[name[0]];
  for (const ch of name.slice(1)) pc += ch === '#' ? 1 : ch === 'b' ? -1 : 0;
  return ((pc % 12) + 12) % 12;
}

// Accordo Harte → etichetta 0–23 (maggiori, minori), 24 = nessun accordo, -1 = escluso
// (diminuiti, aumentati, sospesi, bicordi: come nella valutazione MIREX "majmin").
const MAJOR = new Set(['maj', '7', 'maj7', 'maj6', '9', 'maj9', '11', '13', 'maj13', 'maj11']);
const MINOR = new Set(['min', 'min7', 'min6', 'min9', 'min11', 'min13', 'minmaj7']);
export function harteLabel(token) {
  if (token === 'N' || token === '&pause') return 24;
  const m = /^([A-G][b#]*):([^/(]*)/.exec(token);
  if (!m) return -1;
  const root = pitchClass(m[1]);
  const quality = m[2] || 'maj';
  if (MAJOR.has(quality)) return root;
  if (MINOR.has(quality)) return root + 12;
  return -1;
}

// Una riga di salami_chords: elementi separati da virgole. Lettera di sezione (maiuscole con
// eventuali apici), funzioni (parole minuscole), battute (| … |, con xN e (n/d)), strumenti.
export function parseLine(content) {
  const out = { letter: null, functions: [], bars: null, silence: false };
  const text = content.trim();
  if (/^(silence|end|fadeout|applause|noise|talking)$/i.test(text) || text === '') {
    out.silence = true;
    out.marker = text.toLowerCase();
    return out;
  }
  // Le battute non contengono virgole: si separa semplicemente sulle virgole.
  const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    if (/^[A-Z]'*$/.test(part)) out.letter = part;
    else if (part.startsWith('|')) out.bars = parseBars(part);
    else if (/^[a-z][a-z -]*$/.test(part)) out.functions.push(part);
    else if (/^(silence|end)$/i.test(part)) out.silence = true;
  }
  return out;
}

// "| A:min | F:maj G:maj | x2" → battute con i loro accordi e i battiti di ciascuna.
function parseBars(text) {
  const repeat = /x(\d+)\s*$/.exec(text);
  const body = text.replace(/x\d+\s*$/, '').trim();
  const bars = [];
  const chunks = body.split('|').map((s) => s.trim()).filter((s) => s.length > 0 && s !== '->');
  let prev = -1;
  for (const chunk of chunks) {
    let tokens = chunk.split(/\s+/).filter((t) => t && t !== '->');
    let beats = null;
    const sig = tokens.length && /^\((\d+)\/(\d+)\)$/.exec(tokens[0]);
    if (sig) { beats = Number(sig[1]) * (Number(sig[2]) === 8 ? 0.5 : 1); tokens = tokens.slice(1); }
    if (!tokens.length) continue;
    const labels = tokens.map((t) => {
      if (t === '.') return prev;
      if (t === '*') return -1;
      prev = harteLabel(t);
      return prev;
    });
    bars.push({ labels, beats });
  }
  const n = repeat ? Number(repeat[1]) : 1;
  const out = [];
  for (let k = 0; k < n; k++) for (const b of bars) out.push({ labels: [...b.labels], beats: b.beats });
  return out;
}

// Brano completo: sezioni [inizio, fine, lettera, funzione], battute [inizio, fine, etichette],
// toniche (con i cambi), metro.
export function parseSalami(text) {
  const lines = text.split('\n');
  const head = {};
  const rows = [];
  let tonic = null;
  let metre = null;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    if (line.startsWith('#')) {
      const m = /^#\s*(\w+):\s*(.*)$/.exec(line);
      if (!m) continue;
      if (m[1] === 'tonic') tonic = m[2].trim();
      if (m[1] === 'metre') metre = m[2].trim();
      if (!(m[1] in head)) head[m[1]] = m[2].trim();
      continue;
    }
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const time = Number(line.slice(0, tab));
    rows.push({ time, tonic, metre, ...parseLine(line.slice(tab + 1)) });
  }
  const [num, den] = (head.metre || '4/4').split('/').map(Number);
  const beatsPerBar = den === 8 && num % 3 === 0 ? num / 3 : num;
  // Battute: ogni riga copre fino alla riga successiva, divisa tra le sue battute in
  // proporzione ai battiti (le battute in 2/4 durano metà).
  const bars = [];
  rows.forEach((row, i) => {
    if (!row.bars || !row.bars.length) return;
    const end = i + 1 < rows.length ? rows[i + 1].time : row.time;
    const weights = row.bars.map((b) => b.beats ?? beatsPerBar);
    const total = weights.reduce((a, b) => a + b, 0);
    let t = row.time;
    row.bars.forEach((b, k) => {
      const d = ((end - row.time) * weights[k]) / total;
      bars.push({ start: t, end: t + d, labels: b.labels, beats: weights[k], tonic: row.tonic && pitchClass(row.tonic) });
      t += d;
    });
  });
  // Sezioni: da una riga con la lettera alla successiva (o al primo silenzio/fine).
  const sections = [];
  rows.forEach((row, i) => {
    if (!row.letter) return;
    let j = i + 1;
    while (j < rows.length && !rows[j].letter && !rows[j].silence) j += 1;
    const end = j < rows.length ? rows[j].time : row.time;
    sections.push({ start: row.time, end, letter: row.letter, function: row.functions[0] || null });
  });
  const endRow = rows.find((r) => r.marker === 'end');
  return {
    title: head.title || '',
    artist: head.artist || '',
    metre: head.metre || '4/4',
    beatsPerBar,
    tonic: head.tonic ? pitchClass(head.tonic) : null,
    tonicChanges: rows.filter((r, i) => i > 0 && r.tonic !== rows[i - 1].tonic).length,
    end: endRow ? endRow.time : rows.length ? rows[rows.length - 1].time : 0,
    bars,
    sections,
  };
}

// Modo (non annotato): minore se la triade minore sulla tonica dura più di quella maggiore.
export function inferMode(song) {
  let major = 0;
  let minor = 0;
  for (const b of song.bars) {
    const share = (b.end - b.start) / b.labels.length;
    for (const l of b.labels) {
      if (b.tonic == null || l < 0 || l >= 24) continue;
      if (l === b.tonic) major += share;
      if (l === b.tonic + 12) minor += share;
    }
  }
  return minor > major ? 'minor' : 'major';
}

// Accordo annotato all'istante t (-1 fuori dalle battute).
export function labelAt(song, t) {
  for (const b of song.bars) {
    if (t < b.start || t >= b.end) continue;
    const k = Math.min(b.labels.length - 1, Math.floor(((t - b.start) / (b.end - b.start)) * b.labels.length));
    return b.labels[k];
  }
  return -1;
}

// Funzioni di Billboard → categorie dell'app.
export function canonicalFunction(f) {
  if (!f) return null;
  if (/^(verse|verse \w+|spoken verse|pre-verse)$/.test(f)) return f === 'pre-verse' ? 'other' : 'verse';
  if (/^(chorus|chorus [ab]|refrain)$/.test(f)) return 'chorus';
  if (/^(pre-chorus|prechorus|pre chorus|pre-chorus \w+)$/.test(f)) return 'prechorus';
  if (f === 'bridge') return 'bridge';
  if (/^(intro|intro[- ]?[ab]|pre-intro|fadein|fade in)$/.test(f)) return 'intro';
  if (/^(outro|fadeout|coda|ending)$/.test(f)) return 'outro';
  if (/^(solo|instrumental|interlude|instrumental break|theme|main theme|secondary theme)$/.test(f)) return 'instrumental';
  return 'other';
}

// ---------- Cache: battiti di Echo Nest con cromagramma, volume e timbro ----------

function readChroma(file) {
  const text = readFileSync(file, 'utf8');
  const times = [];
  const bass = [];
  const treble = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const cells = line.split(',');
    const t = Number(cells[1]);
    if (!Number.isFinite(t)) continue;
    // 12 bassi poi 12 acuti, a partire da La: si ruota a Do = 0 (Do è l'indice 3).
    const v = cells.slice(2, 26).map(Number);
    const b = new Float64Array(12);
    const tr = new Float64Array(12);
    for (let pc = 0; pc < 12; pc++) { b[pc] = v[(pc + 3) % 12]; tr[pc] = v[12 + ((pc + 3) % 12)]; }
    times.push(t);
    bass.push(b);
    treble.push(tr);
  }
  return { times, bass, treble };
}

const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

// Media per battito (come beatChroma nell'app: normalizzata al massimo, energia in log).
function beatFeatures(chroma, echo, beatTimes) {
  const out = [];
  let j = 0;
  let s = 0;
  const segs = echo.segments;
  for (let i = 0; i + 1 < beatTimes.length; i++) {
    const a = beatTimes[i];
    const b = beatTimes[i + 1];
    const t = new Float64Array(12);
    const bs = new Float64Array(12);
    let n = 0;
    while (j < chroma.times.length && chroma.times[j] < a) j += 1;
    for (let k = j; k < chroma.times.length && chroma.times[k] < b; k++) {
      for (let p = 0; p < 12; p++) { t[p] += chroma.treble[k][p]; bs[p] += chroma.bass[k][p]; }
      n += 1;
    }
    const tm = Math.max(...t);
    const bm = Math.max(...bs);
    // Volume e timbro: media dei segmenti di Echo Nest che toccano il battito, pesata sulla sovrapposizione.
    const timbre = new Float64Array(12);
    let loud = 0;
    let w = 0;
    while (s < segs.length && segs[s].start + segs[s].duration < a) s += 1;
    for (let k = s; k < segs.length && segs[k].start < b; k++) {
      const overlap = Math.min(b, segs[k].start + segs[k].duration) - Math.max(a, segs[k].start);
      if (overlap <= 0) continue;
      loud += overlap * segs[k].loudness_max;
      for (let p = 0; p < 12; p++) timbre[p] += overlap * segs[k].timbre[p];
      w += overlap;
    }
    out.push({
      start: round(a),
      end: round(b),
      treble: Array.from(t, (v) => round(tm > 0 ? v / tm : 0)),
      bass: Array.from(bs, (v) => round(bm > 0 ? v / bm : 0)),
      energy: round(Math.log(1e-6 + (n ? t.reduce((x, v) => x + v, 0) / n : 0))),
      loud: round(w ? loud / w : -60, 2),
      timbre: Array.from(timbre, (v) => round(w ? v / w : 0, 2)),
    });
  }
  return out;
}

export function buildSong(id) {
  const dir = join(BILLBOARD, id);
  const song = parseSalami(readFileSync(join(dir, 'salami_chords.txt'), 'utf8'));
  const echo = JSON.parse(readFileSync(join(dir, 'echonest.json'), 'utf8'));
  const chroma = readChroma(join(dir, 'bothchroma.csv'));
  const beatTimes = echo.beats.map((b) => b.start);
  const beats = beatFeatures(chroma, echo, beatTimes);
  const mode = inferMode(song);
  for (const b of beats) b.ref = labelAt(song, (b.start + b.end) / 2);
  return {
    id,
    title: song.title,
    artist: song.artist,
    metre: song.metre,
    beatsPerBar: song.beatsPerBar,
    key: song.tonic == null ? null : { tonic: song.tonic, mode },
    tonicChanges: song.tonicChanges,
    end: song.end,
    echoBars: echo.bars.map((b) => round(b.start)),
    beats,
    bars: song.bars.map((b) => ({ start: round(b.start), end: round(b.end), labels: b.labels, beats: b.beats, tonic: b.tonic })),
    sections: song.sections.map((s) => ({ ...s, start: round(s.start), end: round(s.end), kind: canonicalFunction(s.function) })),
  };
}

// Brani unici (in Billboard alcune canzoni compaiono più volte, a date diverse).
export function uniqueIds() {
  const ids = readdirSync(BILLBOARD).filter((id) => existsSync(join(BILLBOARD, id, 'salami_chords.txt'))).sort();
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    const song = parseSalami(readFileSync(join(BILLBOARD, id, 'salami_chords.txt'), 'utf8'));
    const k = `${song.title.toLowerCase().trim()}|${song.artist.toLowerCase().trim()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(id);
  }
  return out;
}

// Gruppo della validazione incrociata (5 gruppi) dal titolo e dall'artista.
export function foldOf(song, folds = 5) {
  let h = 2166136261;
  for (const ch of `${song.title}|${song.artist}`.toLowerCase()) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0) % folds;
}

export function loadBillboard() {
  const file = join(CACHE, 'structure', 'billboard.json');
  return JSON.parse(readFileSync(file, 'utf8'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ids = uniqueIds();
  const out = [];
  const started = Date.now();
  for (const id of ids) {
    const dir = join(BILLBOARD, id);
    if (!existsSync(join(dir, 'bothchroma.csv')) || !existsSync(join(dir, 'echonest.json'))) continue;
    try { out.push(buildSong(id)); } catch (e) { console.error(id, e.message); }
    if (out.length % 100 === 0) console.log(`  ${out.length}/${ids.length} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  }
  mkdirSync(join(CACHE, 'structure'), { recursive: true });
  writeFileSync(join(CACHE, 'structure', 'billboard.json'), JSON.stringify(out));
  console.log(`Billboard: ${out.length} brani unici (su ${readdirSync(BILLBOARD).length}), ${out.reduce((a, s) => a + s.beats.length, 0)} battiti`);
}
