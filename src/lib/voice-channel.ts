import { VOICES, type Voice } from "@/lib/types";

export type StereoSide = "left" | "right";

export type StereoSamples = {
  left: ArrayLike<number>;
  right: ArrayLike<number>;
};

export type VoiceChannelProfile = {
  sampleCount: number;
  covariance: number[][];
  rms: number[];
};

export type VoiceChannelSelection = {
  channels: Record<Voice, StereoSide>;
  confidence: number;
  method: "cross-track-reconstruction-v1" | "lower-energy-fallback-v1";
  runnerUpScore: number;
  score: number;
};

const SIGNAL_COUNT = VOICES.length * 2;
const MIN_RECONSTRUCTION_CONFIDENCE = 0.05;

function signalIndex(voiceIndex: number, side: StereoSide): number {
  return voiceIndex * 2 + (side === "right" ? 1 : 0);
}

function opposite(side: StereoSide): StereoSide {
  return side === "left" ? "right" : "left";
}

function sideForMask(mask: number, voiceIndex: number): StereoSide {
  return mask & (1 << voiceIndex) ? "right" : "left";
}

function channelsForMask(mask: number): Record<Voice, StereoSide> {
  return Object.fromEntries(VOICES.map((voice, index) => [voice, sideForMask(mask, index)])) as Record<
    Voice,
    StereoSide
  >;
}

function solveLinearSystem(matrix: number[][], vector: number[]): number[] | null {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);

  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-14) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];

    for (let row = column + 1; row < size; row += 1) {
      const factor = augmented[row][column] / augmented[column][column];
      for (let item = column; item <= size; item += 1) {
        augmented[row][item] -= factor * augmented[column][item];
      }
    }
  }

  const solution = Array<number>(size).fill(0);
  for (let row = size - 1; row >= 0; row -= 1) {
    let value = augmented[row][size];
    for (let column = row + 1; column < size; column += 1) {
      value -= augmented[row][column] * solution[column];
    }
    solution[row] = value / augmented[row][row];
  }
  return solution;
}

function unexplainedVariance(profile: VoiceChannelProfile, target: number, predictors: number[]): number {
  const targetVariance = profile.covariance[target][target];
  if (!Number.isFinite(targetVariance) || targetVariance <= 1e-12) return 1;

  const gram = predictors.map((left) => predictors.map((right) => profile.covariance[left][right]));
  const cross = predictors.map((predictor) => profile.covariance[predictor][target]);
  const trace = gram.reduce((sum, row, index) => sum + row[index], 0);
  const ridge = Math.max(trace * 1e-8, 1e-12);
  for (let index = 0; index < gram.length; index += 1) gram[index][index] += ridge;

  const coefficients = solveLinearSystem(gram, cross);
  if (!coefficients) return 1;
  const explained = coefficients.reduce((sum, coefficient, index) => sum + coefficient * cross[index], 0);
  return Math.min(1, Math.max(0, 1 - explained / targetVariance));
}

function reconstructionScore(profile: VoiceChannelProfile, mask: number): number {
  const selected = VOICES.map((_, index) => signalIndex(index, sideForMask(mask, index)));
  const residuals = VOICES.map((_, voiceIndex) => {
    const target = signalIndex(voiceIndex, opposite(sideForMask(mask, voiceIndex)));
    const predictors = selected.filter((_, predictorVoiceIndex) => predictorVoiceIndex !== voiceIndex);
    return unexplainedVariance(profile, target, predictors);
  });
  return residuals.reduce((sum, residual) => sum + residual, 0) / residuals.length;
}

function validateProfile(profile: VoiceChannelProfile): void {
  if (!Number.isInteger(profile.sampleCount) || profile.sampleCount < 16) {
    throw new Error("At least 16 aligned stereo samples are required for channel analysis.");
  }
  if (profile.covariance.length !== SIGNAL_COUNT || profile.rms.length !== SIGNAL_COUNT) {
    throw new Error(`Channel analysis requires ${SIGNAL_COUNT} signals.`);
  }
  for (const row of profile.covariance) {
    if (row.length !== SIGNAL_COUNT || row.some((value) => !Number.isFinite(value))) {
      throw new Error("Channel covariance matrix is invalid.");
    }
  }
  if (profile.rms.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Channel energy values are invalid.");
  }
}

/**
 * Builds the compact signal profile used by the selector. Samples must be aligned
 * versions of the four learning tracks; extra samples in longer tracks are ignored.
 */
export function buildVoiceChannelProfile(
  tracks: Record<Voice, StereoSamples>,
): VoiceChannelProfile {
  const signals = VOICES.flatMap((voice) => [tracks[voice].left, tracks[voice].right]);
  const sampleCount = Math.min(...signals.map((signal) => signal.length));
  if (!Number.isInteger(sampleCount) || sampleCount < 16) {
    throw new Error("The learning tracks do not contain enough aligned audio to analyze.");
  }

  const means = signals.map((signal) => {
    let sum = 0;
    for (let index = 0; index < sampleCount; index += 1) sum += signal[index];
    return sum / sampleCount;
  });
  const covariance = Array.from({ length: SIGNAL_COUNT }, () => Array<number>(SIGNAL_COUNT).fill(0));

  for (let left = 0; left < SIGNAL_COUNT; left += 1) {
    for (let right = left; right < SIGNAL_COUNT; right += 1) {
      let sum = 0;
      for (let index = 0; index < sampleCount; index += 1) {
        sum += (signals[left][index] - means[left]) * (signals[right][index] - means[right]);
      }
      covariance[left][right] = sum / sampleCount;
      covariance[right][left] = covariance[left][right];
    }
  }

  return {
    sampleCount,
    covariance,
    rms: covariance.map((row, index) => Math.sqrt(Math.max(0, row[index]))),
  };
}

/**
 * The named channel is the assignment whose four opposite channels are best
 * reconstructed from the other three named voices. This tests every left/right
 * combination, so neither a site-wide side nor a per-tag side is assumed.
 */
export function selectVoiceChannels(profile: VoiceChannelProfile): VoiceChannelSelection {
  validateProfile(profile);
  const candidates = Array.from({ length: 1 << VOICES.length }, (_, mask) => ({
    mask,
    score: reconstructionScore(profile, mask),
  })).sort((left, right) => left.score - right.score || left.mask - right.mask);

  const best = candidates[0];
  const runnerUp = candidates[1];
  const confidence = Math.min(
    1,
    Math.max(0, (runnerUp.score - best.score) / Math.max(runnerUp.score, 1e-12)),
  );

  if (confidence >= MIN_RECONSTRUCTION_CONFIDENCE) {
    return {
      channels: channelsForMask(best.mask),
      confidence,
      method: "cross-track-reconstruction-v1",
      runnerUpScore: runnerUp.score,
      score: best.score,
    };
  }

  const fallback = Object.fromEntries(
    VOICES.map((voice, index) => {
      const leftEnergy = profile.rms[signalIndex(index, "left")];
      const rightEnergy = profile.rms[signalIndex(index, "right")];
      const bestSide = sideForMask(best.mask, index);
      const side = Math.abs(leftEnergy - rightEnergy) <= 1e-9
        ? bestSide
        : rightEnergy < leftEnergy
          ? "right"
          : "left";
      return [voice, side];
    }),
  ) as Record<Voice, StereoSide>;

  return {
    channels: fallback,
    confidence,
    method: "lower-energy-fallback-v1",
    runnerUpScore: runnerUp.score,
    score: best.score,
  };
}
