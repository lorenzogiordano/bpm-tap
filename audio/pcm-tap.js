// AudioWorklet: raccoglie i campioni del microfono (mono) in blocchi da 2048 e li
// passa al thread principale. Gira nel thread audio, quindi fa il minimo indispensabile.
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(2048);
    this.length = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    const first = channels[0];
    for (let i = 0; i < first.length; i++) {
      // Se arriva in stereo, si mescola in mono.
      let v = first[i];
      for (let c = 1; c < channels.length; c++) v += channels[c][i];
      this.block[this.length++] = v / channels.length;
      if (this.length === this.block.length) {
        this.port.postMessage(this.block, [this.block.buffer]);
        this.block = new Float32Array(2048);
        this.length = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-tap', PcmTap);
