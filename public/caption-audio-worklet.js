const OUTPUT_RATE = 16000;
const PACKET_SAMPLES = 1600;

class CortexCaptionCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inputIndex = 0;
    this.nextOutputPosition = 0;
    this.previousSample = 0;
    this.hasPreviousSample = false;
    this.packet = new Int16Array(PACKET_SAMPLES);
    this.packetLength = 0;
    this.port.onmessage = (event) => {
      if (event.data?.type === "flush") {
        this.emitPacket();
        this.port.postMessage({ type: "flushed" });
      }
    };
  }

  emitPacket() {
    if (!this.packetLength) return;
    const pcm = this.packet.slice(0, this.packetLength);
    this.packetLength = 0;
    this.port.postMessage({ type: "pcm", pcm: pcm.buffer }, [pcm.buffer]);
  }

  append(sample) {
    const clipped = Math.max(-1, Math.min(1, sample));
    this.packet[this.packetLength++] = Math.max(-32768, Math.min(32767, Math.round(clipped * 32767)));
    if (this.packetLength === this.packet.length) this.emitPacket();
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input?.length) return true;
    const blockStart = this.inputIndex;
    const blockEnd = blockStart + input.length;
    const ratio = sampleRate / OUTPUT_RATE;

    while (this.nextOutputPosition < blockEnd - 1) {
      const lower = Math.floor(this.nextOutputPosition);
      const upper = lower + 1;
      const lowerLocal = lower - blockStart;
      const upperLocal = upper - blockStart;
      let first;
      if (lowerLocal === -1 && this.hasPreviousSample) first = this.previousSample;
      else if (lowerLocal >= 0 && lowerLocal < input.length) first = input[lowerLocal];
      else break;
      if (upperLocal < 0 || upperLocal >= input.length) break;
      const fraction = this.nextOutputPosition - lower;
      this.append(first + (input[upperLocal] - first) * fraction);
      this.nextOutputPosition += ratio;
    }

    this.inputIndex = blockEnd;
    this.previousSample = input[input.length - 1];
    this.hasPreviousSample = true;
    return true;
  }
}

registerProcessor("cortex-caption-capture", CortexCaptionCaptureProcessor);
