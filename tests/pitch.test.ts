import { describe, expect, it } from "vitest";
import {
  formatPitchSemitones,
  normalizePitchSemitones,
  parsePitchSemitones,
  pitchCacheSegment,
  semitonesToRatio,
} from "@/lib/pitch";

describe("pitch controls", () => {
  it("converts semitones to playback ratios", () => {
    expect(semitonesToRatio(0)).toBe(1);
    expect(semitonesToRatio(12)).toBe(2);
    expect(semitonesToRatio(-12)).toBe(0.5);
  });

  it("strictly validates server pitch queries", () => {
    expect(parsePitchSemitones(null)).toBe(0);
    expect(parsePitchSemitones("-6")).toBe(-6);
    expect(parsePitchSemitones("6")).toBe(6);
    expect(() => parsePitchSemitones("1.5")).toThrow("whole number");
    expect(() => parsePitchSemitones("7")).toThrow("between -6 and +6");
  });

  it("normalizes stored values and creates safe cache names", () => {
    expect(normalizePitchSemitones(3.4)).toBe(3);
    expect(normalizePitchSemitones(-20)).toBe(-6);
    expect(pitchCacheSegment(-3)).toBe("minus-3");
    expect(pitchCacheSegment(4)).toBe("plus-4");
  });

  it("formats control values in musical terms", () => {
    expect(formatPitchSemitones(0)).toBe("Original key");
    expect(formatPitchSemitones(1)).toBe("+1 semitone");
    expect(formatPitchSemitones(-2)).toBe("-2 semitones");
  });
});
