// Collegamento al programma mac/bpm-knock.py, che legge il sensore di movimento del
// MacBook (nessun browser può farlo) e lo manda qui come Server-Sent Events.

export const HELPER_PORT = 8765;
export const HELPER_FILE = 'mac/bpm-knock.py';

// Pagina servita dal programma stesso (stessa origine) o dal sito pubblicato.
export const servedByHelper = () => ['localhost', '127.0.0.1'].includes(location.hostname) && location.port === String(HELPER_PORT);
const motionUrl = () => (servedByHelper() ? '/motion' : `http://localhost:${HELPER_PORT}/motion`);

export class MacMotion {
  // onSample(t, x, y, z): t sulla scala di performance.now() (ms), accelerazione in g.
  constructor({ onSample, onLost }) {
    this.onSample = onSample;
    this.onLost = onLost;
    this.source = null;
    this.offsets = []; // [arrivo, scarto] recenti per allineare gli orologi
  }

  get connected() {
    return Boolean(this.source && this.source.readyState === EventSource.OPEN && this.ready);
  }

  // Si collega; risolve true al primo pacchetto di dati, false se entro 2,5 s non arriva.
  connect() {
    this.close();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!ok) this.close();
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), 2500);
      let source;
      try {
        source = new EventSource(motionUrl());
      } catch {
        finish(false);
        return;
      }
      this.source = source;
      this.ready = false;
      source.onmessage = (event) => {
        this.ready = true;
        finish(true);
        this.handle(JSON.parse(event.data));
      };
      source.onerror = () => {
        if (!settled) { finish(false); return; }
        // Programma chiuso a sessione avviata.
        this.close();
        this.onLost?.();
      };
    });
  }

  close() {
    if (this.source) this.source.close();
    this.source = null;
    this.ready = false;
  }

  // Orologio del sensore → orologio della pagina: lo scarto più piccolo tra arrivo e
  // istante dell'ultimo campione negli ultimi 5 s è il meno ritardato dalla consegna.
  handle(batch) {
    if (!batch.length) return;
    const now = performance.now();
    this.offsets.push([now, now - batch[batch.length - 1][0]]);
    while (this.offsets.length && this.offsets[0][0] < now - 5000) this.offsets.shift();
    let offset = Infinity;
    for (const [, o] of this.offsets) if (o < offset) offset = o;
    for (const [t, x, y, z] of batch) this.onSample(t + offset, x, y, z);
  }
}
