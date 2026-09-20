export type PitchClass = {
  semitone: number;
  label: string;
  shortLabel: string;
  spokenLabel: string;
  isBlack: boolean;
};

export type PianoKey = PitchClass & {
  midi: number;
  octave: number;
  whiteKeysBefore: number;
};

export const PITCH_CLASSES: readonly PitchClass[] = [
  { semitone: 0, label: "C", shortLabel: "C", spokenLabel: "C", isBlack: false },
  { semitone: 1, label: "C♯ / D♭", shortLabel: "C♯", spokenLabel: "C sharp or D flat", isBlack: true },
  { semitone: 2, label: "D", shortLabel: "D", spokenLabel: "D", isBlack: false },
  { semitone: 3, label: "D♯ / E♭", shortLabel: "E♭", spokenLabel: "D sharp or E flat", isBlack: true },
  { semitone: 4, label: "E", shortLabel: "E", spokenLabel: "E", isBlack: false },
  { semitone: 5, label: "F", shortLabel: "F", spokenLabel: "F", isBlack: false },
  { semitone: 6, label: "F♯ / G♭", shortLabel: "F♯", spokenLabel: "F sharp or G flat", isBlack: true },
  { semitone: 7, label: "G", shortLabel: "G", spokenLabel: "G", isBlack: false },
  { semitone: 8, label: "G♯ / A♭", shortLabel: "A♭", spokenLabel: "G sharp or A flat", isBlack: true },
  { semitone: 9, label: "A", shortLabel: "A", spokenLabel: "A", isBlack: false },
  { semitone: 10, label: "A♯ / B♭", shortLabel: "B♭", spokenLabel: "A sharp or B flat", isBlack: true },
  { semitone: 11, label: "B", shortLabel: "B", spokenLabel: "B", isBlack: false },
] as const;

export function midiForPitch(octave: number, semitone: number): number {
  if (!Number.isInteger(octave) || !Number.isInteger(semitone) || semitone < 0 || semitone > 11) {
    throw new Error("A note requires an integer octave and a semitone from 0 through 11.");
  }
  return (octave + 1) * 12 + semitone;
}

/** The written tonic in octave 4, shifted by the rehearsal pitch setting. */
export function midiForKey(key: string, pitchSemitones = 0): number | null {
  const match = /^([a-g])\s*([#♯b♭]?)(?:\s+(?:major|minor|dorian|phrygian|lydian|mixolydian|aeolian|ionian|locrian))?$/i.exec(key.trim());
  if (!match || !Number.isInteger(pitchSemitones)) return null;
  const natural = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const semitone = natural[match[1].toUpperCase() as keyof typeof natural];
  const accidental = match[2] === "#" || match[2] === "♯" ? 1 : match[2] ? -1 : 0;
  return midiForPitch(4, semitone) + accidental + pitchSemitones;
}

export function frequencyForMidi(midi: number): number {
  if (!Number.isFinite(midi)) throw new Error("A MIDI note must be finite.");
  return 440 * 2 ** ((midi - 69) / 12);
}

export function pitchForMidi(midi: number): PitchClass & { octave: number } {
  if (!Number.isInteger(midi)) throw new Error("A MIDI note must be an integer.");
  const normalizedSemitone = ((midi % 12) + 12) % 12;
  return {
    ...PITCH_CLASSES[normalizedSemitone],
    octave: Math.floor(midi / 12) - 1,
  };
}

export function noteLabel(midi: number): string {
  const pitch = pitchForMidi(midi);
  return `${pitch.label}${pitch.octave}`;
}

export function pianoKeys(startOctave: number, endOctave: number): PianoKey[] {
  if (!Number.isInteger(startOctave) || !Number.isInteger(endOctave) || endOctave <= startOctave) {
    throw new Error("A piano range requires integer octaves in ascending order.");
  }

  const firstMidi = midiForPitch(startOctave, 0);
  const lastMidi = midiForPitch(endOctave, 0);
  let whiteKeysBefore = 0;
  const keys: PianoKey[] = [];

  for (let midi = firstMidi; midi <= lastMidi; midi += 1) {
    const pitch = pitchForMidi(midi);
    keys.push({ ...pitch, midi, whiteKeysBefore });
    if (!pitch.isBlack) whiteKeysBefore += 1;
  }

  return keys;
}
