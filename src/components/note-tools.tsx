"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "@/components/icons";
import {
  PITCH_CLASSES,
  frequencyForMidi,
  midiForPitch,
  noteLabel,
  pianoKeys,
} from "@/lib/notes";

type Instrument = "piano" | "pitch-pipe";
type PlayedNote = { instrument: Instrument; midi: number };
type Tone = { envelope: GainNode; instrument: Instrument; oscillators: OscillatorNode[] };
type ToneEngine = {
  context: AudioContext;
  master: GainNode;
  tones: Set<Tone>;
};

const PIPE_OCTAVES = [2, 3, 4, 5] as const;
const PIANO_KEYS = pianoKeys(3, 6);
const PIANO_WHITE_KEYS = PIANO_KEYS.filter((key) => !key.isBlack).length;
const MAX_PIANO_TONES = 8;

type AudioContextWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
};

function stopTone(tone: Tone, at: number) {
  tone.envelope.gain.cancelScheduledValues(at);
  tone.envelope.gain.setValueAtTime(Math.max(0.0001, tone.envelope.gain.value), at);
  tone.envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.04);
  for (const oscillator of tone.oscillators) {
    try {
      oscillator.stop(at + 0.05);
    } catch {
      // A naturally ended oscillator needs no further cleanup.
    }
  }
}

function createTone(engine: ToneEngine, midi: number, instrument: Instrument): Tone {
  const { context, master } = engine;
  const frequency = frequencyForMidi(midi);
  const now = context.currentTime;
  const envelope = context.createGain();
  const filter = context.createBiquadFilter();
  const isPipe = instrument === "pitch-pipe";
  const duration = isPipe ? 2.35 : 2.1;
  const peak = isPipe ? 0.16 : 0.2;
  const partials: ReadonlyArray<{ multiple: number; level: number; type: OscillatorType }> = isPipe
    ? [
        { multiple: 1, level: 0.78, type: "triangle" },
        { multiple: 2, level: 0.15, type: "sine" },
        { multiple: 3, level: 0.07, type: "sine" },
      ]
    : [
        { multiple: 1, level: 0.76, type: "triangle" },
        { multiple: 2, level: 0.17, type: "sine" },
        { multiple: 3, level: 0.07, type: "sine" },
      ];

  envelope.gain.setValueAtTime(0.0001, now);
  envelope.gain.exponentialRampToValueAtTime(peak, now + (isPipe ? 0.035 : 0.008));
  if (isPipe) {
    envelope.gain.exponentialRampToValueAtTime(0.11, now + 0.2);
    envelope.gain.setValueAtTime(0.11, now + 1.9);
  }
  envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  filter.type = "lowpass";
  filter.frequency.setValueAtTime(isPipe ? 2_100 : 2_800, now);
  filter.Q.setValueAtTime(isPipe ? 1.2 : 0.7, now);
  envelope.connect(filter).connect(master);

  const tone: Tone = { envelope, instrument, oscillators: [] };
  for (const partial of partials) {
    const oscillator = context.createOscillator();
    const partialGain = context.createGain();
    oscillator.type = partial.type;
    oscillator.frequency.setValueAtTime(frequency * partial.multiple, now);
    partialGain.gain.setValueAtTime(partial.level, now);
    oscillator.connect(partialGain).connect(envelope);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.06);
    tone.oscillators.push(oscillator);
  }

  tone.oscillators[0].addEventListener("ended", () => engine.tones.delete(tone), { once: true });
  engine.tones.add(tone);
  return tone;
}

function useTonePlayer() {
  const engineRef = useRef<ToneEngine | null>(null);
  const activeTimersRef = useRef<Map<string, number>>(new Map());
  const [activeNotes, setActiveNotes] = useState<Set<string>>(() => new Set());
  const [playedNote, setPlayedNote] = useState<PlayedNote | null>(null);
  const [error, setError] = useState("");

  const getEngine = useCallback((): ToneEngine => {
    if (engineRef.current && engineRef.current.context.state !== "closed") return engineRef.current;
    const AudioContextConstructor = window.AudioContext
      ?? (window as AudioContextWindow).webkitAudioContext;
    if (!AudioContextConstructor) throw new Error("This browser cannot play synthesized notes.");

    const context = new AudioContextConstructor({ latencyHint: "interactive" });
    const master = context.createGain();
    const limiter = context.createDynamicsCompressor();
    master.gain.value = 0.58;
    limiter.threshold.value = -16;
    limiter.knee.value = 12;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.12;
    master.connect(limiter).connect(context.destination);
    engineRef.current = { context, master, tones: new Set() };
    return engineRef.current;
  }, []);

  const play = useCallback((midi: number, instrument: Instrument) => {
    const activeKey = `${instrument}:${midi}`;
    setError("");
    setPlayedNote({ instrument, midi });
    setActiveNotes((current) => new Set(current).add(activeKey));
    const previousTimer = activeTimersRef.current.get(activeKey);
    if (previousTimer !== undefined) window.clearTimeout(previousTimer);
    activeTimersRef.current.set(activeKey, window.setTimeout(() => {
      setActiveNotes((current) => {
        const next = new Set(current);
        next.delete(activeKey);
        return next;
      });
      activeTimersRef.current.delete(activeKey);
    }, 520));

    try {
      const engine = getEngine();
      if (engine.context.state === "suspended") void engine.context.resume();
      const pianoTones = [...engine.tones].filter((tone) => tone.instrument === "piano");
      const tonesToStop = instrument === "pitch-pipe"
        ? [...engine.tones].filter((tone) => tone.instrument === "pitch-pipe")
        : pianoTones.slice(0, Math.max(0, pianoTones.length - MAX_PIANO_TONES + 1));
      for (const tone of tonesToStop) {
        engine.tones.delete(tone);
        stopTone(tone, engine.context.currentTime);
      }
      createTone(engine, midi, instrument);
    } catch (playError) {
      setError(playError instanceof Error ? playError.message : "This note could not be played.");
    }
  }, [getEngine]);

  useEffect(() => () => {
    for (const timer of activeTimersRef.current.values()) window.clearTimeout(timer);
    activeTimersRef.current.clear();
    const engine = engineRef.current;
    if (!engine) return;
    for (const tone of engine.tones) stopTone(tone, engine.context.currentTime);
    void engine.context.close();
    engineRef.current = null;
  }, []);

  return { activeNotes, error, play, playedNote };
}

function PitchPipe({ activeNotes, onPlay }: {
  activeNotes: ReadonlySet<string>;
  onPlay: (midi: number, instrument: Instrument) => void;
}) {
  const [octave, setOctave] = useState<number>(4);

  return (
    <section className="instrument-card pitch-pipe" aria-labelledby="pitch-pipe-heading">
      <header className="instrument-heading">
        <div>
          <p className="panel-kicker">Sustained tone</p>
          <h3 id="pitch-pipe-heading">Pitch pipe</h3>
        </div>
        <label className="octave-select">
          <span>Octave</span>
          <select onChange={(event) => setOctave(Number(event.target.value))} value={octave}>
            {PIPE_OCTAVES.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
      </header>
      <p className="instrument-description">Choose a chromatic pitch for a clear, sustained reference.</p>
      <div className="pitch-pipe-notes" role="group" aria-label={`Pitch pipe notes in octave ${octave}`}>
        {PITCH_CLASSES.map((pitch) => {
          const midi = midiForPitch(octave, pitch.semitone);
          const active = activeNotes.has(`pitch-pipe:${midi}`);
          return (
            <button
              aria-label={`Play ${pitch.spokenLabel} ${octave} on the pitch pipe`}
              className={active ? "is-active" : ""}
              key={pitch.semitone}
              onClick={() => onPlay(midi, "pitch-pipe")}
              title={`${pitch.label}${octave} · ${frequencyForMidi(midi).toFixed(1)} Hz`}
              type="button"
            >
              <strong>{pitch.shortLabel}</strong>
              <span>{octave}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function Piano({ activeNotes, onPlay }: {
  activeNotes: ReadonlySet<string>;
  onPlay: (midi: number, instrument: Instrument) => void;
}) {
  const keyboardStyle = { "--piano-white-keys": PIANO_WHITE_KEYS } as CSSProperties;

  return (
    <section className="instrument-card piano" aria-labelledby="piano-heading">
      <header className="instrument-heading">
        <div>
          <p className="panel-kicker">Three octaves</p>
          <h3 id="piano-heading">Piano keyboard</h3>
        </div>
        <span className="piano-range">C3–C6</span>
      </header>
      <p className="instrument-description">Play labeled piano-style keys. Scroll sideways to reach the full range.</p>
      <div className="piano-scroll" role="group" aria-label="Piano keyboard from C3 through C6">
        <div className="piano-keyboard" style={keyboardStyle}>
          {PIANO_KEYS.map((key) => {
            const active = activeNotes.has(`piano:${key.midi}`);
            const keyStyle = { "--key-position": key.whiteKeysBefore } as CSSProperties;
            return (
              <button
                aria-label={`Play ${key.spokenLabel} ${key.octave} on the piano`}
                className={`piano-key ${key.isBlack ? "piano-key-black" : "piano-key-white"} ${active ? "is-active" : ""}`}
                key={key.midi}
                onClick={(event) => {
                  if (event.detail === 0) onPlay(key.midi, "piano");
                }}
                onPointerDown={(event) => {
                  if (event.button === 0) onPlay(key.midi, "piano");
                }}
                style={keyStyle}
                title={`${key.label}${key.octave} · ${frequencyForMidi(key.midi).toFixed(1)} Hz`}
                type="button"
              >
                <span>{key.shortLabel}{key.shortLabel === "C" ? key.octave : ""}</span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function ToolContents({ instrument }: { instrument?: Instrument }) {
  const { activeNotes, error, play, playedNote } = useTonePlayer();
  const readout = useMemo(() => {
    if (error) return { note: "Audio unavailable", detail: error };
    if (!playedNote) return { note: "Ready", detail: "Tap a note, or focus one and press Enter or Space." };
    return {
      note: noteLabel(playedNote.midi),
      detail: `${frequencyForMidi(playedNote.midi).toFixed(1)} Hz · ${playedNote.instrument === "pitch-pipe" ? "Pitch pipe" : "Piano"}`,
    };
  }, [error, playedNote]);

  return (
    <div className="note-tools-content">
      <div className={`note-readout ${error ? "has-error" : ""}`} aria-live="polite" role={error ? "alert" : "status"}>
        <span className="note-readout-mark" aria-hidden="true">♪</span>
        <strong>{readout.note}</strong>
        <span>{readout.detail}</span>
      </div>
      <div className="instrument-list">
        {(!instrument || instrument === "pitch-pipe") && <PitchPipe activeNotes={activeNotes} onPlay={play} />}
        {(!instrument || instrument === "piano") && <Piano activeNotes={activeNotes} onPlay={play} />}
      </div>
    </div>
  );
}

export function NoteTools({ collapsible = false }: { collapsible?: boolean }) {
  const contentId = useId();
  const [activeInstrument, setActiveInstrument] = useState<Instrument | null>(null);

  if (collapsible) {
    return (
      <div className={`note-tools note-tools-embedded ${activeInstrument ? "is-open" : ""}`}>
        <div className="note-tools-launcher">
          <span className="note-tools-launcher-label"><Icon name="music" size={18} /> Reference tools</span>
          <div className="note-tools-launcher-buttons" role="group" aria-label="Open a reference instrument">
            <button
              aria-controls={contentId}
              aria-expanded={activeInstrument === "piano"}
              className={activeInstrument === "piano" ? "is-active" : ""}
              onClick={() => setActiveInstrument((current) => current === "piano" ? null : "piano")}
              type="button"
            >
              Piano
            </button>
            <button
              aria-controls={contentId}
              aria-expanded={activeInstrument === "pitch-pipe"}
              className={activeInstrument === "pitch-pipe" ? "is-active" : ""}
              onClick={() => setActiveInstrument((current) => current === "pitch-pipe" ? null : "pitch-pipe")}
              type="button"
            >
              Pitchpipe
            </button>
          </div>
        </div>
        {activeInstrument && (
          <div className="note-tools-embedded-content" id={contentId}>
            <ToolContents instrument={activeInstrument} key={activeInstrument} />
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="note-tools note-tools-standalone" aria-labelledby="note-tools-heading">
      <header className="note-tools-header">
        <div>
          <p className="panel-kicker">Reference tones</p>
          <h2 id="note-tools-heading">Pitch pipe & piano</h2>
        </div>
        <p>Everything plays in your browser. Nothing is recorded or sent anywhere.</p>
      </header>
      <ToolContents />
    </section>
  );
}
