export const MIN_PITCH_SEMITONES = -6;
export const MAX_PITCH_SEMITONES = 6;
// The delay-line shifter sweeps symmetrically around this latency. Keeping the
// dry path at the same delay makes switching the effect much less abrupt.
export const CLIENT_PITCH_LATENCY_SAMPLES = 1664;
export const PITCH_STEPS = Array.from(
  { length: MAX_PITCH_SEMITONES - MIN_PITCH_SEMITONES + 1 },
  (_, index) => MIN_PITCH_SEMITONES + index,
);

export function semitonesToRatio(semitones: number): number {
  return 2 ** (semitones / 12);
}

export function isPitchSemitones(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
    && value >= MIN_PITCH_SEMITONES && value <= MAX_PITCH_SEMITONES;
}

export function pitchFromUrl(value: string | string[] | undefined): number | undefined {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return undefined;
  const pitch = Number(value);
  return isPitchSemitones(pitch) ? pitch : undefined;
}

export function normalizePitchSemitones(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_PITCH_SEMITONES, Math.max(MIN_PITCH_SEMITONES, Math.round(parsed)));
}

export function formatPitchSemitones(semitones: number): string {
  if (semitones === 0) return "Original key";
  return `${semitones > 0 ? "+" : ""}${semitones} semitone${Math.abs(semitones) === 1 ? "" : "s"}`;
}
