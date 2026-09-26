// Struttura della canzone a schermo: linea del tempo delle sezioni (blocchi colorati con la
// lettera o il ruolo) e, per ogni lettera, il suo giro di accordi in ordine con i gradi.
// Serve sia al risultato appena trovato sia alle misure salvate (in forma compatta).

import { romanNumeral } from './audio/progressions.js';
import { chordName } from './chord-names.js';

export const ROLE_NAMES = {
  intro: 'Intro',
  verse: 'Strofa',
  prechorus: 'Pre-ritornello',
  chorus: 'Ritornello',
  bridge: 'Bridge',
  instrumental: 'Strumentale',
  outro: 'Finale',
  other: 'Passaggio',
};

// Colore di una lettera: A → 1, B → 2… (8 colori, in ordine fisso); le varianti A′ hanno il
// colore della lettera, più tenue.
export function letterSlot(letter) {
  return ((letter.charCodeAt(0) - 65) % 8) + 1;
}

const baseLetter = (letter) => letter.replace(/′/g, '');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------- Forma compatta per lo storico ----------

const r1 = (x) => Math.round(x * 10) / 10;

export function compactStructure(st) {
  if (!st || !st.shown) return undefined;
  const prog = (p) => p && {
    c: p.chords.map((c) => [c.chord, c.units, c.p]),
    loop: p.loop ? 1 : 0,
    bars: p.bars,
    rep: p.repeats,
    named: p.named || undefined,
    alt: p.alternative ? { c: p.alternative.chords, id: p.alternative.id, name: p.alternative.name } : undefined,
  };
  const used = new Set(st.sections.map((s) => s.letter));
  return {
    v: 1,
    m: st.meter,
    u: st.unitsPerBar,
    s: st.sections.map((s) => [r1(s.start), r1(s.end), s.letter, s.role || 0]),
    p: Object.fromEntries(Object.entries(st.progressions).filter(([l]) => used.has(l)).map(([l, p]) => [l, prog(p)])),
    w: st.whole ? prog(st.whole) : undefined,
  };
}

export function expandStructure(c) {
  if (!c || c.v !== 1) return null;
  const prog = (p) => p && {
    chords: p.c.map(([chord, units, prob]) => ({ chord, units, p: prob })),
    loop: Boolean(p.loop),
    bars: p.bars,
    repeats: p.rep,
    named: p.named || null,
    alternative: p.alt ? { chords: p.alt.c, id: p.alt.id, name: p.alt.name } : null,
  };
  return {
    shown: true,
    meter: c.m,
    unitsPerBar: c.u,
    sections: c.s.map(([start, end, letter, role]) => ({ start, end, letter, role: role || null })),
    progressions: Object.fromEntries(Object.entries(c.p).map(([l, p]) => [l, prog(p)])),
    whole: c.w ? prog(c.w) : null,
  };
}

// ---------- Suono ----------

// Il giro di una lettera come [{ chord, beats }] per sound.js: una passata (due se è corta).
export function progressionToPlay(st, letter, { alternative = false } = {}) {
  const p = letter === '*' ? st.whole : st.progressions[letter];
  if (!p) return [];
  const beatsPerUnit = st.meter / st.unitsPerBar;
  let chords;
  if (alternative && p.alternative) {
    const w = p.chords.reduce((a, c) => a + c.units, 0) / p.alternative.chords.length;
    chords = p.alternative.chords.map((chord) => ({ chord, beats: w * beatsPerUnit }));
  } else {
    chords = p.chords.map((c) => ({ chord: c.chord, beats: c.units * beatsPerUnit }));
  }
  const bars = chords.reduce((a, c) => a + c.beats, 0) / st.meter;
  return p.loop && bars <= 2 ? [...chords, ...chords] : chords;
}

// Accordi principali nell'ordine del giro dell'intero brano (quelli fuori dal giro dopo).
export function orderByLoop(labels, st) {
  if (!st?.whole || !labels.length) return labels;
  const order = [];
  for (const c of st.whole.chords) if (!order.includes(c.chord)) order.push(c.chord);
  const inLoop = order.filter((c) => labels.includes(c));
  return [...inLoop, ...labels.filter((c) => !inLoop.includes(c))];
}

// ---------- Resa ----------

function sectionName(section) {
  return section.role ? ROLE_NAMES[section.role] : section.letter;
}

// Durata di un accordo del giro: niente per una battuta, altrimenti "½ batt.", "2 batt."…
function durationLabel(units, upb) {
  const bars = units / upb;
  if (bars === 1) return '';
  const n = bars === 0.5 ? '½' : Number.isInteger(bars) ? `${bars}` : `${Math.floor(bars)}½`;
  return `${n} batt.`;
}

function romanLine(chords, key) {
  return chords.map((c) => romanNumeral(c, key)).join('–');
}

// Linea del tempo: un blocco per sezione, largo quanto dura. playable: blocchi-pulsante.
export function renderTimeline(container, st, { playable = false, small = false } = {}) {
  const total = st.sections[st.sections.length - 1].end - st.sections[0].start || 1;
  const blocks = st.sections.map((s) => {
    const block = el(playable ? 'button' : 'span', `tl-block${s.letter.includes('′') ? ' variant' : ''}`);
    if (playable) { block.type = 'button'; block.dataset.play = s.letter; }
    block.style.flexGrow = String(Math.max(0.5, s.end - s.start) / total * 100);
    block.style.setProperty('--c', `var(--s${letterSlot(s.letter)})`);
    const name = sectionName(s);
    // Etichetta solo se il blocco è abbastanza largo (il nome resta nel titolo).
    if (!small && (s.end - s.start) / total >= 0.035) block.append(el('span', 'tl-label', name));
    const what = s.role ? `${ROLE_NAMES[s.role]} (${s.letter})` : `Sezione ${s.letter}`;
    block.title = `${what}, ${clock(s.start)}–${clock(s.end)}`;
    block.setAttribute('aria-label', playable ? `${what}, da ${clock(s.start)} a ${clock(s.end)}: ascolta il giro` : `${what}, da ${clock(s.start)} a ${clock(s.end)}`);
    return block;
  });
  container.replaceChildren(...blocks);
}

// Righe aperte per intero ("+N" toccato), per struttura: sopravvivono ai ridisegni.
const expanded = new WeakMap();

export function toggleExpanded(st, letter) {
  if (!expanded.has(st)) expanded.set(st, new Set());
  const set = expanded.get(st);
  if (set.has(letter)) set.delete(letter); else set.add(letter);
}

// Una riga per lettera, nell'ordine in cui compaiono: nome, quante volte torna, giro.
export function renderGroups(container, st, key, { playable = false, maxChords = 8 } = {}) {
  const letters = [];
  for (const s of st.sections) if (!letters.includes(s.letter)) letters.push(s.letter);
  // Le varianti subito dopo la loro lettera.
  letters.sort((a, b) => letters.indexOf(baseLetter(a)) - letters.indexOf(baseLetter(b)) || a.length - b.length);
  const rows = letters.map((letter) => {
    const own = st.sections.filter((s) => s.letter === letter);
    const p = st.progressions[letter];
    const row = el('li', 'group');
    row.style.setProperty('--c', `var(--s${letterSlot(letter)})`);
    const head = el('div', 'group-head');
    const badge = el('span', `group-badge${letter.includes('′') ? ' variant' : ''}`, letter);
    const roles = [...new Set(own.map((s) => s.role).filter(Boolean))].map((r) => ROLE_NAMES[r]);
    const title = el('span', 'group-title', roles.length ? roles.join(' / ') : letter.includes('′') ? `variante di ${baseLetter(letter)}` : `Sezione ${letter}`);
    const times = el('span', 'group-times', own.length === 1 ? '1 volta' : `${own.length} volte`);
    head.append(badge, title, times);
    if (playable && p) {
      const play = el('button', 'chip chip-small', '▶');
      play.type = 'button';
      play.dataset.play = letter;
      play.setAttribute('aria-label', `Ascolta il giro della sezione ${letter}`);
      head.append(play);
    }
    row.append(head);
    const all = expanded.get(st)?.has(letter);
    if (p) row.append(progressionLine(p, st.unitsPerBar, key, all ? Infinity : maxChords, letter), progressionNote(p, key, letter, playable));
    return row;
  });
  container.replaceChildren(...rows);
}

function progressionLine(p, upb, key, maxChords, letter) {
  const line = el('div', 'prog');
  const shown = p.chords.length > maxChords + 1 ? p.chords.slice(0, maxChords) : p.chords;
  for (const c of shown) {
    const item = el('span', `prog-chord${c.p < 0.5 ? ' unsure' : ''}`);
    item.append(el('b', '', chordName(c.chord, key) + (c.p < 0.5 ? '?' : '')));
    const roman = romanNumeral(c.chord, key);
    if (roman) item.append(el('small', 'prog-roman', roman));
    const d = durationLabel(c.units, upb);
    if (d) item.append(el('small', 'prog-bars', d));
    item.title = `${chordName(c.chord, key)}${roman ? ` (${roman})` : ''}: ${c.units / upb} battut${c.units === upb ? 'a' : 'e'}, sicurezza ${Math.round(c.p * 100)}%`;
    line.append(item);
  }
  if (shown.length < p.chords.length) {
    const more = el('button', 'prog-more', `+${p.chords.length - shown.length}`);
    more.type = 'button';
    more.dataset.expand = letter;
    more.setAttribute('aria-label', `Mostra tutti gli accordi della sezione ${letter}`);
    line.append(more);
  }
  return line;
}

function progressionNote(p, key, letter, playable) {
  const note = el('p', 'prog-note');
  const bars = (n) => `${n} battut${n === 1 ? 'a' : 'e'}`;
  if (p.loop) {
    const times = p.repeats >= 1.5 ? `, ×${Math.round(p.repeats)} ogni volta` : '';
    note.append(`Giro di ${bars(p.bars)}${times}`);
    if (p.named) {
      const roman = romanLine(p.chords.map((c) => c.chord), key);
      note.append(' · ', el('span', 'prog-named', `${p.named.name} (${roman})`));
    }
  } else {
    note.append(`Nessun giro fisso: la sezione intera, ${bars(p.bars)}`);
  }
  if (p.alternative && key) {
    // Solo un'ipotesi da verificare a orecchio: il giro trovato resta com'è.
    const alt = el(playable ? 'button' : 'span', 'prog-alt', `forse ${p.alternative.name} (${romanLine(p.alternative.chords, key)})?`);
    if (playable) { alt.type = 'button'; alt.dataset.play = letter; alt.dataset.alternative = '1'; }
    note.append(' · ', alt);
  }
  return note;
}

// Pannello completo del risultato.
export function renderStructurePanel(els, st, key, { playable }) {
  const show = Boolean(st && st.shown);
  els.panel.hidden = !show;
  if (!show) return;
  const minutes = clock(st.sections[st.sections.length - 1].end - st.sections[0].start);
  els.meta.textContent = `${st.bars || ''}${st.bars ? ' battute · ' : ''}${minutes}`;
  renderTimeline(els.timeline, st, { playable });
  els.whole.hidden = !st.whole;
  if (st.whole) {
    const names = st.whole.chords.map((c) => chordName(c.chord, key)).join(' – ');
    els.whole.replaceChildren(el('span', '', 'Tutto il brano gira sullo stesso giro: '), el('b', '', names));
    if (key) els.whole.append(el('small', 'prog-roman', ` ${romanLine(st.whole.chords.map((c) => c.chord), key)}`));
  }
  renderGroups(els.groups, st, key, { playable });
  const named = st.sections.some((s) => s.role);
  els.note.textContent = named
    ? 'Lettere uguali = stessa musica. I nomi (strofa, ritornello…) compaiono solo quando il ritornello è netto.'
    : playable
      ? 'Lettere uguali = stessa musica. Tocca una sezione per sentirne il giro.'
      : 'Lettere uguali = stessa musica. Si aggiorna mentre ascolti.';
}

// Nello storico: una linea del tempo sottile e i giri in un riquadro da aprire.
export function renderHistoryStructure(compact, key) {
  const st = expandStructure(compact);
  if (!st) return null;
  const box = el('details', 'history-structure');
  const summary = el('summary', 'history-structure-summary');
  const bar = el('span', 'timeline timeline-small');
  renderTimeline(bar, st, { small: true });
  summary.append(bar, el('span', 'history-structure-label', 'Struttura e giri'));
  const groups = el('ul', 'groups');
  renderGroups(groups, st, key, { playable: true, maxChords: 6 });
  box.append(summary, groups);
  return box;
}
