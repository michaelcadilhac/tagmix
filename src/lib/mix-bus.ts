export const MIX_BUS_HEADROOM_DB = -3;
export const MIX_BUS_GAIN = 10 ** (MIX_BUS_HEADROOM_DB / 20);
export const MIX_OUTPUT_TRIM_DB = -2;
export const MIX_OUTPUT_GAIN = 10 ** (MIX_OUTPUT_TRIM_DB / 20);

export const MIX_LIMITER = {
  attack: 0.001,
  knee: 0,
  ratio: 20,
  release: 0.12,
  thresholdDb: -1,
} as const;

type GainForMixBus = Pick<GainNode, "gain">;
type LimiterForMixBus = Pick<
  DynamicsCompressorNode,
  "attack" | "knee" | "ratio" | "release" | "threshold"
>;
type GainForMonoInput = Pick<GainNode, "channelCount" | "channelCountMode" | "channelInterpretation">;

export function configureMixBus(
  master: GainForMixBus,
  limiter: LimiterForMixBus,
  output: GainForMixBus,
): void {
  master.gain.value = MIX_BUS_GAIN;
  limiter.threshold.value = MIX_LIMITER.thresholdDb;
  limiter.knee.value = MIX_LIMITER.knee;
  limiter.ratio.value = MIX_LIMITER.ratio;
  limiter.attack.value = MIX_LIMITER.attack;
  limiter.release.value = MIX_LIMITER.release;
  output.gain.value = MIX_OUTPUT_GAIN;
}

/**
 * Processed learning tracks are dual mono. Explicitly downmixing before the
 * StereoPanner keeps its equal-power mono panning law from treating them as a
 * stereo image and summing two identical channels near the pan extremes.
 */
export function configureVoiceGainForMonoInput(gain: GainForMonoInput): void {
  gain.channelCount = 1;
  gain.channelCountMode = "explicit";
  gain.channelInterpretation = "speakers";
}

/** Static transfer estimate used for deterministic headroom regression tests. */
export function estimateMixBusPeakDb(inputPeakDb: number): number {
  const afterHeadroom = inputPeakDb + MIX_BUS_HEADROOM_DB;
  const afterLimiter = afterHeadroom <= MIX_LIMITER.thresholdDb
    ? afterHeadroom
    : MIX_LIMITER.thresholdDb
      + (afterHeadroom - MIX_LIMITER.thresholdDb) / MIX_LIMITER.ratio;
  return afterLimiter + MIX_OUTPUT_TRIM_DB;
}
