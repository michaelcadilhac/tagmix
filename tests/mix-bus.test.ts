import { describe, expect, it } from "vitest";
import {
  MIX_BUS_GAIN,
  MIX_LIMITER,
  MIX_OUTPUT_GAIN,
  configureMixBus,
  configureVoiceGainForMonoInput,
  estimateMixBusPeakDb,
} from "@/lib/mix-bus";

function audioParam(): AudioParam {
  return { value: Number.NaN } as AudioParam;
}

describe("mixer output protection", () => {
  it("puts measured Tag 37 default playback below full scale", () => {
    const measuredUnprotectedPeakDb = 1.125555;

    expect(estimateMixBusPeakDb(measuredUnprotectedPeakDb)).toBeCloseTo(-3.874445, 5);
    expect(estimateMixBusPeakDb(measuredUnprotectedPeakDb)).toBeLessThan(0);
  });

  it("limits the worst-case coherent sum of four full-scale mono tracks", () => {
    const fourTrackPeakDb = 20 * Math.log10(4);

    expect(estimateMixBusPeakDb(fourTrackPeakDb)).toBeLessThan(0);
  });

  it("applies the headroom and fast-limiter configuration used by the graph", () => {
    const master = { gain: audioParam() } as GainNode;
    const output = { gain: audioParam() } as GainNode;
    const limiter = {
      attack: audioParam(),
      knee: audioParam(),
      ratio: audioParam(),
      release: audioParam(),
      threshold: audioParam(),
    } as DynamicsCompressorNode;

    configureMixBus(master, limiter, output);

    expect(master.gain.value).toBeCloseTo(MIX_BUS_GAIN);
    expect(limiter.threshold.value).toBe(MIX_LIMITER.thresholdDb);
    expect(limiter.knee.value).toBe(0);
    expect(limiter.ratio.value).toBe(20);
    expect(limiter.attack.value).toBe(0.001);
    expect(limiter.release.value).toBe(0.12);
    expect(output.gain.value).toBeCloseTo(MIX_OUTPUT_GAIN);
  });

  it("forces dual-mono files to one channel before spatial panning", () => {
    const gain = {
      channelCount: 2,
      channelCountMode: "max",
      channelInterpretation: "discrete",
    } as GainNode;

    configureVoiceGainForMonoInput(gain);

    expect(gain.channelCount).toBe(1);
    expect(gain.channelCountMode).toBe("explicit");
    expect(gain.channelInterpretation).toBe("speakers");
  });
});
