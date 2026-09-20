import { describe, expect, it } from "vitest";
import {
  PITCH_CLASSES,
  frequencyForMidi,
  midiForPitch,
  midiForKey,
  noteLabel,
  pianoKeys,
} from "@/lib/notes";

describe("reference-note tools", () => {
  it("plays the written tonic for major, minor, and modal keys", () => {
    expect(midiForKey("C Major")).toBe(60);
    expect(midiForKey("A Minor")).toBe(69);
    expect(midiForKey("B♭ Dorian")).toBe(70);
    expect(midiForKey(" F# Minor ")).toBe(66);
    expect(midiForKey("Eb Major")).toBe(63);
    expect(midiForKey("C♭ Major")).toBe(59);
  });

  it("transposes the tonic across octave boundaries and rejects unknown keys", () => {
    expect(midiForKey("B Major", 2)).toBe(73);
    expect(midiForKey("C Major", -6)).toBe(54);
    expect(frequencyForMidi(midiForKey("A Major", 3)!)).toBeCloseTo(440 * 2 ** (3 / 12), 8);
    for (const key of ["", "Unknown", "Concert C", "C Major / D Major", "H Major"]) expect(midiForKey(key)).toBeNull();
    expect(midiForKey("C Major", NaN)).toBeNull();
  });

  it("maps equal-tempered notes from concert A", () => {
    expect(frequencyForMidi(69)).toBe(440);
    expect(frequencyForMidi(midiForPitch(4, 0))).toBeCloseTo(261.6256, 4);
    expect(frequencyForMidi(midiForPitch(5, 0))).toBeCloseTo(frequencyForMidi(midiForPitch(4, 0)) * 2, 8);
  });

  it("provides every chromatic pitch with readable enharmonic names", () => {
    expect(PITCH_CLASSES).toHaveLength(12);
    expect(PITCH_CLASSES[3]).toMatchObject({ label: "D♯ / E♭", shortLabel: "E♭", isBlack: true });
    expect(noteLabel(70)).toBe("A♯ / B♭4");
  });

  it("builds a complete C3 through C6 keyboard with aligned black keys", () => {
    const keys = pianoKeys(3, 6);
    expect(keys).toHaveLength(37);
    expect(keys.filter((key) => !key.isBlack)).toHaveLength(22);
    expect(keys.filter((key) => key.isBlack)).toHaveLength(15);
    expect(keys[0]).toMatchObject({ midi: 48, shortLabel: "C", octave: 3, whiteKeysBefore: 0 });
    expect(keys[1]).toMatchObject({ midi: 49, shortLabel: "C♯", whiteKeysBefore: 1 });
    expect(keys.at(-1)).toMatchObject({ midi: 84, shortLabel: "C", octave: 6 });
  });
});
