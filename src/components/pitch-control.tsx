"use client";

import { formatPitchSemitones, MAX_PITCH_SEMITONES, MIN_PITCH_SEMITONES } from "@/lib/pitch";

export function PitchControl({ value, onChange, disabled = false, saving = false, tagTitle, compact = false }: {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  saving?: boolean;
  tagTitle?: string;
  compact?: boolean;
}) {
  return <div className={`pitch-stepper${compact ? " pitch-stepper-compact" : ""}`}>
    <button
      aria-label={tagTitle ? `Lower pitch for ${tagTitle}` : "Lower pitch one semitone"}
      disabled={disabled || value <= MIN_PITCH_SEMITONES}
      aria-disabled={saving || undefined}
      onClick={() => { if (!saving) onChange(Math.max(MIN_PITCH_SEMITONES, value - 1)); }}
      type="button"
    >−</button>
    <output aria-live="polite" aria-label={formatPitchSemitones(value)} title={formatPitchSemitones(value)}>
      {compact ? (value > 0 ? `+${value}` : String(value)) : formatPitchSemitones(value)}
    </output>
    <button
      aria-label={tagTitle ? `Raise pitch for ${tagTitle}` : "Raise pitch one semitone"}
      disabled={disabled || value >= MAX_PITCH_SEMITONES}
      aria-disabled={saving || undefined}
      onClick={() => { if (!saving) onChange(Math.min(MAX_PITCH_SEMITONES, value + 1)); }}
      type="button"
    >+</button>
  </div>;
}
