/* global AudioWorkletProcessor, registerProcessor */

const RING_SIZE = 32768;
const BASE_DELAY_SAMPLES = 128;
const DEFAULT_LATENCY_SAMPLES = 1664;

// Keep this delay-line DSP in sync with src/lib/realtime-pitch.ts, which is
// the plain-HTTP compatibility path for browsers that hide AudioWorklet.

class TagMixPitchShifter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{
      name: "pitchRatio",
      defaultValue: 1,
      minValue: 0.5,
      maxValue: 2,
      automationRate: "k-rate",
    }];
  }

  constructor(options) {
    super();
    this.ring = new Float32Array(RING_SIZE);
    this.writePosition = 0;
    this.phase = 0;
    this.latencySamples = Math.max(
      BASE_DELAY_SAMPLES + 1,
      Math.round(options.processorOptions?.latencySamples ?? DEFAULT_LATENCY_SAMPLES),
    );
    this.delaySpan = Math.min(
      RING_SIZE / 4,
      Math.max(256, (this.latencySamples - BASE_DELAY_SAMPLES) * 2),
    );
  }

  read(position) {
    const lower = Math.floor(position);
    if (lower < 0 || lower < this.writePosition - RING_SIZE) return 0;
    const fraction = position - lower;
    const first = this.ring[((lower % RING_SIZE) + RING_SIZE) % RING_SIZE];
    const second = this.ring[(((lower + 1) % RING_SIZE) + RING_SIZE) % RING_SIZE];
    return first + (second - first) * fraction;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;

    const ratio = Math.min(2, Math.max(0.5, parameters.pitchRatio[0] ?? 1));
    for (let index = 0; index < output.length; index += 1) {
      this.ring[this.writePosition % RING_SIZE] = input?.[index] ?? 0;

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
    return true;
  }
}

registerProcessor("tagmix-pitch-shifter", TagMixPitchShifter);
