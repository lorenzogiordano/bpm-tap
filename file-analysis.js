// Analisi di un file audio intero, tutta nel dispositivo (il file non viene inviato a
// nessuno): decodifica a 22050 Hz (decodeAudioData ricampiona alla frequenza del contesto,
// così la memoria si dimezza), media dei canali, poi il Worker dell'ascolto.

// Niente "audio/*" da solo: su iPhone viene trattato come video/* e nasconde gli MP3
// (WebKit bug 242110). Estensioni e tipi espliciti.
export const FILE_ACCEPT = '.mp3,.m4a,.aac,.wav,.aif,.aiff,.caf,.flac,.ogg,.opus,.webm,audio/mpeg,audio/mp4,audio/wav,audio/x-wav,audio/aiff,audio/flac,audio/ogg';
const RATE = 22050;
const MAX_SECONDS = 15 * 60;

export async function decodeFile(file) {
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Offline) throw new Error('unsupported');
  const data = await file.arrayBuffer();
  const ctx = new Offline(1, 1, RATE);
  const buffer = await new Promise((resolve, reject) => {
    // Safari vecchi vogliono le callback; gli altri restituiscono una Promise.
    const pending = ctx.decodeAudioData(data, resolve, reject);
    if (pending && pending.then) pending.then(resolve, reject);
  }).catch(() => { throw new Error('decode'); });
  if (buffer.duration > MAX_SECONDS) throw new Error('too-long');
  const n = buffer.length;
  const mono = new Float32Array(n);
  const channels = buffer.numberOfChannels;
  for (let c = 0; c < channels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += ch[i] / channels;
  }
  return mono;
}

// Restituisce { promise, cancel }. onProgress(frazione 0–1, fase).
export function analyzeFile(file, { onProgress } = {}) {
  let worker = null;
  let cancelled = false;
  const promise = (async () => {
    onProgress?.(0, 'decode');
    const samples = await decodeFile(file);
    if (cancelled) throw new Error('cancelled');
    worker = new Worker(new URL('./audio/listen-worker.js', import.meta.url), { type: 'module' });
    return new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => {
        if (data.type === 'progress') onProgress?.(data.fraction, data.stage);
        else if (data.type === 'result') { worker.terminate(); resolve(data); }
        else if (data.type === 'error') { worker.terminate(); reject(new Error(data.message)); }
      };
      worker.onerror = (event) => { worker.terminate(); reject(new Error(event.message || 'worker')); };
      worker.postMessage({ type: 'file', samples }, [samples.buffer]);
    });
  })();
  return {
    promise,
    cancel() {
      cancelled = true;
      worker?.terminate();
    },
  };
}
