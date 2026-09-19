export const MIN_PITCH_SEMITONES = -6;
export const MAX_PITCH_SEMITONES = 6;
// The delay-line shifter sweeps symmetrically around this latency. Keeping the
// dry path at the same delay makes switching the effect much less abrupt.
export const CLIENT_PITCH_LATENCY_SAMPLES = 1664;
export const PITCH_STEPS = Array.from(
  { length: MAX_PITCH_SEMITONES - MIN_PITCH_SEMITONES + 1 },
  (_, index) => MIN_PITCH_SEMITONES + index,
);

export type PitchMode = "client" | "server";

export function semitonesToRatio(semitones: number): number {
  return 2 ** (semitones / 12);
}

export function normalizePitchSemitones(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_PITCH_SEMITONES, Math.max(MIN_PITCH_SEMITONES, Math.round(parsed)));
}

export function parsePitchSemitones(value: string | null): number {
  if (value === null || value === "") return 0;
  if (!/^-?\d+$/.test(value)) throw new Error("Pitch must be a whole number of semitones.");
  const parsed = Number(value);
  if (parsed < MIN_PITCH_SEMITONES || parsed > MAX_PITCH_SEMITONES) {
    throw new Error(`Pitch must be between ${MIN_PITCH_SEMITONES} and +${MAX_PITCH_SEMITONES} semitones.`);
  }
  return parsed;
}

export function pitchCacheSegment(semitones: number): string {
  const normalized = normalizePitchSemitones(semitones);
  if (normalized === 0) return "original";
  return normalized > 0 ? `plus-${normalized}` : `minus-${Math.abs(normalized)}`;
}

export function formatPitchSemitones(semitones: number): string {
  if (semitones === 0) return "Original key";
  return `${semitones > 0 ? "+" : ""}${semitones} semitone${Math.abs(semitones) === 1 ? "" : "s"}`;
}
