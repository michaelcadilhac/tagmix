import { describe, expect, it } from "vitest";
import { CLIENT_PITCH_LATENCY_SAMPLES, semitonesToRatio } from "@/lib/pitch";
import { RealtimePitchShifter } from "@/lib/realtime-pitch";

function strongestFrequency(
  samples: Float32Array,
  sampleRate: number,
  minimum: number,
  maximum: number,
): number {
  const start = 8_192;
  const length = 24_000;
  let bestFrequency = 0;
  let bestMagnitude = -1;
  for (let frequency = minimum; frequency <= maximum; frequency += 0.25) {
    let real = 0;
    let imaginary = 0;
    for (let offset = 0; offset < length; offset += 1) {
      const phase = 2 * Math.PI * frequency * offset / sampleRate;
      const sample = samples[start + offset];
      real += sample * Math.cos(phase);
      imaginary -= sample * Math.sin(phase);
    }
    const magnitude = real * real + imaginary * imaginary;
    if (magnitude > bestMagnitude) {
      bestMagnitude = magnitude;
      bestFrequency = frequency;
    }
  }
  return bestFrequency;
}

describe("plain-HTTP client pitch fallback", () => {
  it("transposes a tone without changing the output duration", () => {
    const sampleRate = 48_000;
    const input = Float32Array.from(
      { length: sampleRate * 2 },
      (_, index) => Math.sin(2 * Math.PI * 220 * index / sampleRate) * 0.5,
    );
    const output = new Float32Array(input.length);
    const shifter = new RealtimePitchShifter(CLIENT_PITCH_LATENCY_SAMPLES);
    const ratio = semitonesToRatio(3);
    const blockSize = 1_024;
    for (let offset = 0; offset < input.length; offset += blockSize) {
      shifter.processBlock(
        input.subarray(offset, offset + blockSize),
        output.subarray(offset, offset + blockSize),
        ratio,
      );
    }

    expect(output).toHaveLength(input.length);
    expect(strongestFrequency(output, sampleRate, 240, 280))
      .toBeCloseTo(220 * ratio, 0);
  });
});
