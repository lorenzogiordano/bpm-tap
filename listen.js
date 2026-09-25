// Ascolto dal microfono: cattura (AudioWorklet), analisi in un Worker, aggiornamenti all'app.
//
// Su iPhone: la cattura va avviata da un tocco; mentre il microfono è attivo iOS
// mette in pausa la musica che suona sullo stesso telefono (la sessione audio
// diventa PlayAndRecord), quindi la canzone deve suonare da un altro dispositivo.
// echoCancellation: false spegne l'elaborazione "da telefonata" di WebKit
// (cancellazione dell'eco e controllo automatico del volume).

const MAX_SECONDS = 120;

export class Listener {
  constructor({ onUpdate, onEnd }) {
    this.onUpdate = onUpdate;
    this.onEnd = onEnd;
    this.active = false;
  }

  // Va chiamato dentro un gestore di click. calibrate: ascolta prima qualche secondo di
  // silenzio per l'impronta del rumore (si può saltare con skipCalibration()).
  async start({ calibrate = true } = {}) {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context || !navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
    this.ctx = new Context();
    const resumed = this.ctx.resume(); // ancora dentro il gesto, prima di qualsiasi await
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (error) {
      this.cleanup();
      throw error;
    }
    await resumed;
    if (this.ctx.state !== 'running') await this.ctx.resume();

    this.worker = new Worker(new URL('./audio/listen-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'error') { console.error(data.message); return; }
      if (data.type !== 'update') return;
      this.onUpdate(data);
      if (data.seconds >= MAX_SECONDS) this.stop('limit');
    };
    this.worker.postMessage({ type: 'start', sampleRate: this.ctx.sampleRate, calibrate });

    await this.ctx.audioWorklet.addModule(new URL('./audio/pcm-tap.js', import.meta.url));
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-tap');
    this.node.port.onmessage = ({ data }) => this.worker?.postMessage({ type: 'pcm', samples: data }, [data.buffer]);
    // Uscita a volume zero: alcuni motori elaborano il nodo solo se collegato all'uscita.
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    source.connect(this.node);
    this.node.connect(sink);
    sink.connect(this.ctx.destination);

    const [track] = this.stream.getAudioTracks();
    track.onended = () => this.stop('ended');
    this.active = true;
  }

  skipCalibration() {
    this.worker?.postMessage({ type: 'skip-calibration' });
  }

  stop(reason = 'user') {
    if (!this.active) {
      this.cleanup();
      return;
    }
    this.active = false;
    this.cleanup();
    this.onEnd(reason);
  }

  cleanup() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.node?.disconnect();
    this.worker?.terminate();
    this.ctx?.close().catch(() => {});
    this.stream = null;
    this.node = null;
    this.worker = null;
    this.ctx = null;
  }
}
