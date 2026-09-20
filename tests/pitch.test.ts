import { describe, expect, it } from "vitest";
import {
  formatPitchSemitones,
  normalizePitchSemitones,
  pitchFromUrl,
  semitonesToRatio,
} from "@/lib/pitch";

describe("pitch controls", () => {
  it("uses valid folder link pitches, including zero, and ignores invalid query values", () => {
    expect(pitchFromUrl("0")).toBe(0);
    expect(pitchFromUrl("-6")).toBe(-6);
    expect(pitchFromUrl("6")).toBe(6);
    for (const value of [undefined, "", "1.5", "7", "NaN", ["1", "2"]]) {
      expect(pitchFromUrl(value)).toBeUndefined();
    }
  });
  it("converts semitones to playback ratios", () => {
    expect(semitonesToRatio(0)).toBe(1);
    expect(semitonesToRatio(12)).toBe(2);
    expect(semitonesToRatio(-12)).toBe(0.5);
  });

  it("normalizes stored values", () => {
    expect(normalizePitchSemitones(3.4)).toBe(3);
    expect(normalizePitchSemitones(-20)).toBe(-6);
  });

  it("formats control values in musical terms", () => {
    expect(formatPitchSemitones(0)).toBe("Original key");
    expect(formatPitchSemitones(1)).toBe("+1 semitone");
    expect(formatPitchSemitones(-2)).toBe("-2 semitones");
  });
});
