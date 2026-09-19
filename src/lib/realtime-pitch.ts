const RING_SIZE = 32_768;
const BASE_DELAY_SAMPLES = 128;

function clampPitchRatio(value: number): number {
  return Math.min(2, Math.max(0.5, Number.isFinite(value) ? value : 1));
}

/**
 * Same-duration pitch shifter used when AudioWorklet is unavailable, notably
 * on phones opening a development server over plain HTTP. Keep its DSP in
 * sync with public/audio/pitch-shifter.worklet.js.
 */
export class RealtimePitchShifter {
  private readonly delaySpan: number;
  private readonly latencySamples: number;
  private phase = 0;
  private readonly ring = new Float32Array(RING_SIZE);
  private writePosition = 0;

  constructor(latencySamples: number) {
    this.latencySamples = Math.max(BASE_DELAY_SAMPLES + 1, Math.round(latencySamples));
    this.delaySpan = Math.min(
      RING_SIZE / 4,
      Math.max(256, (this.latencySamples - BASE_DELAY_SAMPLES) * 2),
    );
  }

  private read(position: number): number {
    const lower = Math.floor(position);
    if (lower < 0 || lower < this.writePosition - RING_SIZE) return 0;
    const fraction = position - lower;
    const first = this.ring[((lower % RING_SIZE) + RING_SIZE) % RING_SIZE];
    const second = this.ring[(((lower + 1) % RING_SIZE) + RING_SIZE) % RING_SIZE];
    return first + (second - first) * fraction;
  }

  processBlock(input: Float32Array, output: Float32Array, requestedRatio: number): void {
    const ratio = clampPitchRatio(requestedRatio);
    for (let index = 0; index < output.length; index += 1) {
      this.ring[this.writePosition % RING_SIZE] = input[index] ?? 0;

      if (Math.abs(ratio - 1) < 0.00001) {
        output[index] = this.read(this.writePosition - this.latencySamples);
      } else {
        const secondPhase = (this.phase + 0.5) % 1;
        const risingDelay = ratio < 1;
        const firstDelay = BASE_DELAY_SAMPLES
          + (risingDelay ? this.phase : 1 - this.phase) * this.delaySpan;
        const secondDelay = BASE_DELAY_SAMPLES
          + (risingDelay ? secondPhase : 1 - secondPhase) * this.delaySpan;
        const firstWeight = 0.5 - 0.5 * Math.cos(2 * Math.PI * this.phase);
        const secondWeight = 0.5 - 0.5 * Math.cos(2 * Math.PI * secondPhase);
        output[index] = this.read(this.writePosition - firstDelay) * firstWeight
          + this.read(this.writePosition - secondDelay) * secondWeight;
        this.phase = (this.phase + Math.abs(1 - ratio) / this.delaySpan) % 1;
      }
      this.writePosition += 1;
    }
  }
}

export type ControllablePitchNode = {
  dispose?: () => void;
  node: AudioNode;
  setPitchRatio: (ratio: number, atTime?: number) => void;
};

export function createScriptProcessorPitchNode(
  context: AudioContext,
  initialRatio: number,
  latencySamples: number,
): ControllablePitchNode {
  const processor = context.createScriptProcessor(1_024, 1, 1);
  const shifter = new RealtimePitchShifter(latencySamples);
  let ratio = clampPitchRatio(initialRatio);
  processor.onaudioprocess = (event) => {
    shifter.processBlock(
      event.inputBuffer.getChannelData(0),
      event.outputBuffer.getChannelData(0),
      ratio,
    );
  };

  return {
    dispose: () => {
      processor.onaudioprocess = null;
    },
    node: processor,
    setPitchRatio: (nextRatio) => {
      ratio = clampPitchRatio(nextRatio);
    },
  };
}
