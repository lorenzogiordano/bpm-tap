import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KnockDetector } from '../knock.js';

// Segnale del sensore del MacBook a ~794 Hz. Un colpo di nocche, come misurato su un
// MacBook Pro M3 Max: oscillazione smorzata a ~41 Hz lungo z (il Mac rimbalza sui piedini),
// primo semiciclo di ~0,19 g, spenta in ~150 ms.
const DT = 1.26;
function rng(seed) { let s = seed; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

function signal(seconds, events, random = rng(1)) {
  const out = [];
  for (let t = 0; t < seconds * 1000; t += DT) {
    let x = 0.001 * (random() - 0.5);
    let y = 0.001 * (random() - 0.5);
    let z = -0.985 + 0.001 * (random() - 0.5);
    for (const e of events) {
      const u = t - e.t;
      if (e.kind === 'knock' && u >= 0 && u < 250) {
        const v = -e.amp * Math.sin((2 * Math.PI * 41 * u) / 1000) * Math.exp(-u / 45) * Math.min(1, u / 4);
        z += v;
        x += 0.05 * v;
      }
      if (e.kind === 'move' && u >= 0 && u < e.length) {
        // Spostamento lento: mezza sinusoide di accelerazione sui tre assi.
        const v = e.amp * Math.sin((Math.PI * u) / e.length);
        x += v; y += 0.5 * v; z += 0.3 * v;
      }
    }
    out.push([t, x, y, z]);
  }
  return out;
}

function run(samples, options) {
  const det = new KnockDetector(options);
  const hits = [];
  for (const [t, x, y, z] of samples) {
    const hit = det.push(t, x, y, z);
    if (hit) hits.push(hit);
  }
  return hits;
}

test('colpi normali a 110 BPM: tutti contati, uno per colpo, istanti precisi', () => {
  const period = 60000 / 110;
  const events = Array.from({ length: 20 }, (_, k) => ({ kind: 'knock', t: 500 + k * period + 0.37 * k, amp: 0.19 }));
  const ok = run(signal(12.5, events)).filter((h) => h.ok);
  assert.equal(ok.length, 20);
  // Un ritardo uguale per tutti (l'istante è a metà della forza) non cambia i BPM: conta la regolarità.
  const lags = ok.map((h, k) => h.time - events[k].t);
  const mean = lags.reduce((a, b) => a + b, 0) / lags.length;
  assert.ok(mean >= 0 && mean < 8, `ritardo medio ${mean.toFixed(1)} ms`);
  lags.forEach((lag, k) => assert.ok(Math.abs(lag - mean) < 1.5, `colpo ${k}: scarto ${(lag - mean).toFixed(2)} ms`));
});

test('un colpo fortissimo non diventa due: la coda del rimbalzo resta sotto la soglia', () => {
  const events = [0, 600, 1200, 1800].map((t) => ({ kind: 'knock', t: 300 + t, amp: 0.6 }));
  const hits = run(signal(2.6, events)).filter((h) => h.ok);
  assert.equal(hits.length, 4);
});

// Battitura più forte: nell'app ogni tasto premuto sospende il sensore per 200 ms.
test('battitura leggera sulla tastiera (scosse piccole e fitte): nessun colpo', () => {
  const random = rng(3);
  const events = [];
  for (let t = 200; t < 8000; t += 90 + 200 * random()) events.push({ kind: 'knock', t, amp: 0.005 + 0.01 * random() });
  assert.equal(run(signal(8.2, events)).filter((h) => h.ok).length, 0);
});

test('spostare il Mac sul tavolo (accelerazione lenta): nessun colpo', () => {
  const events = [{ kind: 'move', t: 300, length: 400, amp: 0.3 }, { kind: 'move', t: 1500, length: 250, amp: -0.4 }];
  assert.equal(run(signal(2.2, events)).filter((h) => h.ok).length, 0);
});

test('sensibilità: i colpi leggeri contano solo alzandola', () => {
  const events = Array.from({ length: 8 }, (_, k) => ({ kind: 'knock', t: 400 + k * 550, amp: 0.018 }));
  const samples = signal(5, events);
  assert.equal(run(samples, { sensitivity: 5 }).filter((h) => h.ok).length, 0);
  assert.equal(run(samples, { sensitivity: 9 }).filter((h) => h.ok).length, 8);
});
