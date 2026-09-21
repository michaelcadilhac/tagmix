"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/icons";
import { PitchControl } from "@/components/pitch-control";
import { useAccount } from "@/components/account-provider";
import { useAccountResource } from "@/components/account-resource";
import { accountRequest, errorMessage } from "@/lib/account-client";
import type { CueMark } from "@/lib/account-types";
import { formatTime } from "@/lib/format";
import { configureMixBus, configureVoiceGainForMonoInput } from "@/lib/mix-bus";
import {
  CLIENT_PITCH_LATENCY_SAMPLES,
  normalizePitchSemitones,
  semitonesToRatio,
} from "@/lib/pitch";
import {
  createScriptProcessorPitchNode,
  type ControllablePitchNode,
} from "@/lib/realtime-pitch";
import {
  DEFAULT_MIX,
  VOICE_COLORS,
  VOICE_LABELS,
  VOICES,
  type Tag,
  type Voice,
} from "@/lib/types";

type VoiceMix = { volume: number; pan: number; muted: boolean };
type MixState = Record<Voice, VoiceMix>;
type TrackState = "loading" | "ready" | "error";
type AudioMap = Partial<Record<Voice, HTMLAudioElement>>;
type MixerGraph = {
  context: AudioContext;
  dryPitchGains: Record<Voice, GainNode>;
  gains: Record<Voice, GainNode>;
  limiter: DynamicsCompressorNode;
  master: GainNode;
  output: GainNode;
  panners: Record<Voice, StereoPannerNode>;
  pitchProcessors: Record<Voice, ControllablePitchNode>;
  wetPitchGains: Record<Voice, GainNode>;
};
type ClientPitchBackend = "worklet" | "fallback";

const SPEEDS = [0.25, 0.5, 0.75, 1] as const;

function defaultMix(): MixState {
  return Object.fromEntries(
    VOICES.map((voice) => [voice, { ...DEFAULT_MIX[voice], muted: false }]),
  ) as MixState;
}

function loadingStates(): Record<Voice, TrackState> {
  return Object.fromEntries(VOICES.map((voice) => [voice, "loading"])) as Record<Voice, TrackState>;
}

function clamp(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function loadStoredMix(tagId: number): {
  mix: MixState;
  pitchSemitones: number;
  speed: number;
} {
  const fallback = { mix: defaultMix(), pitchSemitones: 0, speed: 1 };
  try {
    const raw = window.localStorage.getItem(`tagmix:mix:${tagId}`);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as {
      mix?: Partial<Record<Voice, Partial<VoiceMix>>>;
      pitchSemitones?: number;
      speed?: number;
    };
    const mix = defaultMix();
    for (const voice of VOICES) {
      const saved = parsed.mix?.[voice];
      if (!saved) continue;
      mix[voice] = {
        volume: clamp(saved.volume, 0, 1, mix[voice].volume),
        pan: clamp(saved.pan, -1, 1, mix[voice].pan),
        muted: Boolean(saved.muted),
      };
    }
    const speed = SPEEDS.includes(parsed.speed as (typeof SPEEDS)[number]) ? Number(parsed.speed) : 1;
    const pitchSemitones = normalizePitchSemitones(parsed.pitchSemitones);
    return { mix, pitchSemitones, speed };
  } catch {
    return fallback;
  }
}

function panLabel(pan: number): string {
  const left = Math.round((1 - pan) * 50);
  return `L${left} · R${100 - left}`;
}

function statusCopy(statuses: Record<Voice, TrackState>): string {
  const errors = VOICES.filter((voice) => statuses[voice] === "error");
  if (errors.length) return `Couldn’t prepare ${errors.map((voice) => VOICE_LABELS[voice]).join(", ")}`;
  const ready = VOICES.filter((voice) => statuses[voice] === "ready").length;
  return ready === VOICES.length ? "All four parts ready" : `Preparing parts · ${ready} of ${VOICES.length}`;
}

export function Mixer({ tag, pitchSemitones, onPitchChange, initialPitch }: {
  tag: Tag;
  pitchSemitones: number;
  onPitchChange: (pitch: number) => void;
  initialPitch?: number;
}) {
  const [mix, setMix] = useState<MixState>(defaultMix);
  const [solo, setSolo] = useState<Set<Voice>>(new Set());
  const [speed, setSpeed] = useState(1);
  const [clientPitchBackend, setClientPitchBackend] = useState<ClientPitchBackend | null>(null);
  const [statuses, setStatuses] = useState<Record<Voice, TrackState>>(loadingStates);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [playbackError, setPlaybackError] = useState("");
  const { user, loading: accountLoading } = useAccount();
  const marksResource = useAccountResource<{ marks: CueMark[] }>(`marks/${tag.id}`, user?.id);
  const marks = marksResource.data?.marks ?? [];
  const [marksSaving, setMarksSaving] = useState(false);
  const [marksError, setMarksError] = useState("");
  const marksBusy = useRef(false);
  const [storageReady, setStorageReady] = useState(false);
  const audiosRef = useRef<AudioMap>({});
  const graphRef = useRef<MixerGraph | null>(null);
  const mixRef = useRef(mix);
  const soloRef = useRef(solo);
  const pitchSemitonesRef = useRef(pitchSemitones);

  const allReady = VOICES.every((voice) => statuses[voice] === "ready");
  const hasError = VOICES.some((voice) => statuses[voice] === "error");

  const pausePlayback = useCallback(() => {
    for (const voice of VOICES) audiosRef.current[voice]?.pause();
    setIsPlaying(false);
    // Paused media still leaves the pitch worklets processing silence unless
    // the context itself sleeps. Play resumes this same graph and position.
    const context = graphRef.current?.context;
    if (context && context.state !== "closed") void context.suspend().catch(() => {});
  }, []);

  const applyGraphMix = useCallback(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const soloed = soloRef.current;
    const now = graph.context.currentTime;
    for (const voice of VOICES) {
      const settings = mixRef.current[voice];
      const audible = !settings.muted && (soloed.size === 0 || soloed.has(voice));
      graph.gains[voice].gain.setTargetAtTime(audible ? settings.volume : 0, now, 0.015);
      graph.panners[voice].pan.setTargetAtTime(settings.pan, now, 0.015);
    }
  }, []);

  const applyGraphPitch = useCallback(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const useClientPitch = pitchSemitonesRef.current !== 0;
    const ratio = useClientPitch ? semitonesToRatio(pitchSemitonesRef.current) : 1;
    const now = graph.context.currentTime;
    for (const voice of VOICES) {
      graph.pitchProcessors[voice].setPitchRatio(ratio, now);
      graph.dryPitchGains[voice].gain.setTargetAtTime(useClientPitch ? 0 : 1, now, 0.01);
      graph.wetPitchGains[voice].gain.setTargetAtTime(useClientPitch ? 1 : 0, now, 0.01);
    }
  }, []);

  useEffect(() => {
    mixRef.current = mix;
    soloRef.current = solo;
    applyGraphMix();
  }, [applyGraphMix, mix, solo]);

  useEffect(() => {
    pitchSemitonesRef.current = pitchSemitones;
    applyGraphPitch();
  }, [applyGraphPitch, pitchSemitones]);

  useEffect(() => {
    const stored = loadStoredMix(tag.id);
    // Restoring state from the browser's local store is an intentional one-time sync.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMix(stored.mix);
    setSpeed(stored.speed);
    onPitchChange(initialPitch ?? stored.pitchSemitones);
    setStorageReady(true);
  }, [initialPitch, onPitchChange, tag.id]);

  useEffect(() => {
    if (!storageReady) return;
    window.localStorage.setItem(
      `tagmix:mix:${tag.id}`,
      JSON.stringify({ mix, pitchSemitones, speed }),
    );
  }, [mix, pitchSemitones, speed, storageReady, tag.id]);

  useEffect(() => {
    const audios: AudioMap = {};
    const cleanup: Array<() => void> = [];
    // Each tag owns four media elements and one shared audio graph.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatuses(loadingStates());
    setDuration(0);
    setCurrentTime(0);
    setIsPlaying(false);
    setClientPitchBackend(null);
    setPlaybackError("");

    const refreshDuration = () => {
      const values = VOICES.map((voice) => audios[voice]?.duration ?? Number.NaN);
      if (values.every((value) => Number.isFinite(value) && value > 0)) {
        setDuration(Math.min(...values));
      }
    };

    for (const voice of VOICES) {
      const audio = new Audio(`/api/tags/${tag.id}/audio/${voice}`);
      audio.preload = "auto";
      audio.playbackRate = speed;
      audio.preservesPitch = true;
      (audio as HTMLAudioElement & { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true;

      const ready = () => {
        setStatuses((current) => ({ ...current, [voice]: "ready" }));
        refreshDuration();
      };
      const failed = () => setStatuses((current) => ({ ...current, [voice]: "error" }));
      const ended = () => {
        pausePlayback();
        setCurrentTime(audio.currentTime);
      };
      audio.addEventListener("loadedmetadata", ready);
      audio.addEventListener("durationchange", refreshDuration);
      audio.addEventListener("error", failed);
      audio.addEventListener("ended", ended);
      cleanup.push(() => {
        audio.removeEventListener("loadedmetadata", ready);
        audio.removeEventListener("durationchange", refreshDuration);
        audio.removeEventListener("error", failed);
        audio.removeEventListener("ended", ended);
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      });
      audios[voice] = audio;
      audio.load();
    }

    audiosRef.current = audios;
    return () => {
      cleanup.forEach((dispose) => dispose());
      audiosRef.current = {};
      const graph = graphRef.current;
      graphRef.current = null;
      if (graph) {
        for (const processor of Object.values(graph.pitchProcessors ?? {})) processor.dispose?.();
        void graph.context.close();
      }
    };
    // Speed is applied by the dedicated effect without recreating media elements.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pausePlayback, tag.id]);

  useEffect(() => {
    for (const voice of VOICES) {
      const audio = audiosRef.current[voice];
      if (audio) {
        audio.playbackRate = speed;
        audio.preservesPitch = true;
      }
    }
  }, [speed]);

  useEffect(() => {
    if (!isPlaying) return;
    const interval = window.setInterval(() => {
      const reference = audiosRef.current.lead ?? audiosRef.current.bass;
      if (!reference) return;
      const nextTime = Math.min(reference.currentTime, duration || reference.currentTime);
      setCurrentTime(nextTime);

      // Media elements preserve pitch natively. A light correction keeps four
      // independently streamed elements together without audible churn.
      for (const voice of VOICES) {
        const audio = audiosRef.current[voice];
        if (audio && audio !== reference && Math.abs(audio.currentTime - reference.currentTime) > 0.075) {
          audio.currentTime = reference.currentTime;
        }
      }
    }, 60);
    return () => window.clearInterval(interval);
  }, [duration, isPlaying]);

  async function ensureGraph(): Promise<MixerGraph> {
    if (graphRef.current) return graphRef.current;
    const AudioContextConstructor = window.AudioContext;
    const context = new AudioContextConstructor();
    const worklet = (context as AudioContext & { audioWorklet?: AudioWorklet }).audioWorklet;
    let useAudioWorklet = typeof AudioWorkletNode !== "undefined"
      && typeof worklet?.addModule === "function";
    if (useAudioWorklet && worklet) {
      try {
        await worklet.addModule("/audio/pitch-shifter.worklet.js?v=2");
      } catch {
        useAudioWorklet = false;
      }
    }
    if (!useAudioWorklet
      && typeof context.createScriptProcessor !== "function") {
      await context.close();
      throw new Error("Pitch playback is not supported by this browser.");
    }
    const dryPitchGains = {} as Record<Voice, GainNode>;
    const gains = {} as Record<Voice, GainNode>;
    const panners = {} as Record<Voice, StereoPannerNode>;
    const pitchProcessors = {} as Record<Voice, ControllablePitchNode>;
    const wetPitchGains = {} as Record<Voice, GainNode>;
    const master = context.createGain();
    const limiter = context.createDynamicsCompressor();
    const output = context.createGain();
    configureMixBus(master, limiter, output);
    master.connect(limiter).connect(output).connect(context.destination);
    const useClientPitch = pitchSemitonesRef.current !== 0;
    const initialPitchRatio = useClientPitch ? semitonesToRatio(pitchSemitonesRef.current) : 1;

    for (const voice of VOICES) {
      const audio = audiosRef.current[voice];
      if (!audio) throw new Error(`${VOICE_LABELS[voice]} audio is not initialized.`);
      const source = context.createMediaElementSource(audio);
      const gain = context.createGain();
      const panner = context.createStereoPanner();
      configureVoiceGainForMonoInput(gain);
      source.connect(gain);
      const dryDelay = context.createDelay(1);
      const dryPitchGain = context.createGain();
      const pitchProcessor: ControllablePitchNode = useAudioWorklet
        ? (() => {
            const node = new AudioWorkletNode(context, "tagmix-pitch-shifter", {
              channelCount: 1,
              channelCountMode: "explicit",
              numberOfInputs: 1,
              numberOfOutputs: 1,
              outputChannelCount: [1],
              parameterData: { pitchRatio: initialPitchRatio },
              processorOptions: { latencySamples: CLIENT_PITCH_LATENCY_SAMPLES },
            });
            return {
              node,
              setPitchRatio: (ratio, atTime = context.currentTime) => {
                node.parameters.get("pitchRatio")?.setTargetAtTime(ratio, atTime, 0.02);
              },
            };
          })()
        : createScriptProcessorPitchNode(context, initialPitchRatio, CLIENT_PITCH_LATENCY_SAMPLES);
      const wetPitchGain = context.createGain();
      dryDelay.delayTime.value = CLIENT_PITCH_LATENCY_SAMPLES / context.sampleRate;
      dryPitchGain.gain.value = useClientPitch ? 0 : 1;
      wetPitchGain.gain.value = useClientPitch ? 1 : 0;
      gain.connect(dryDelay).connect(dryPitchGain).connect(panner);
      gain.connect(pitchProcessor.node).connect(wetPitchGain).connect(panner);
      dryPitchGains[voice] = dryPitchGain;
      pitchProcessors[voice] = pitchProcessor;
      wetPitchGains[voice] = wetPitchGain;
      panner.connect(master);
      gains[voice] = gain;
      panners[voice] = panner;
    }
    graphRef.current = {
      context,
      dryPitchGains,
      gains,
      limiter,
      master,
      output,
      panners,
      pitchProcessors,
      wetPitchGains,
    };
    setClientPitchBackend(useAudioWorklet ? "worklet" : "fallback");
    applyGraphMix();
    applyGraphPitch();
    return graphRef.current;
  }

  const seek = useCallback((time: number) => {
    const nextTime = Math.min(Math.max(0, time), duration || Number.POSITIVE_INFINITY);
    for (const voice of VOICES) {
      const audio = audiosRef.current[voice];
      if (!audio) continue;
      try {
        audio.currentTime = nextTime;
      } catch {
        // A browser may reject seeking until metadata is ready.
      }
    }
    setCurrentTime(nextTime);
  }, [duration]);

  async function togglePlayback() {
    setPlaybackError("");
    if (isPlaying) {
      pausePlayback();
      return;
    }

    setIsStarting(true);
    try {
      // Reuse an existing graph synchronously: even awaiting a resolved promise
      // here moves resume/play outside the tap handler on stricter browsers.
      const graph = graphRef.current ?? await ensureGraph();
      if (duration && currentTime >= duration - 0.05) seek(0);
      // Start all four elements in the same user gesture as context.resume().
      // Waiting for resume first can lose iOS's permission to restart the parts.
      // Settle the wake-up before handling failure; suspending a still-pending
      // resume can otherwise leave the context running after the failed start.
      const results = await Promise.allSettled([
        graph.context.resume(),
        ...VOICES.map(async (voice) => {
          const audio = audiosRef.current[voice];
          if (!audio) throw new Error(`${voice} is unavailable.`);
          return audio.play();
        }),
      ]);
      const rejection = results.find((result) => result.status === "rejected");
      if (rejection?.status === "rejected") throw rejection.reason;
      if (VOICES.some((voice) => audiosRef.current[voice]?.paused)) {
        throw new Error("Not all four parts could resume. Press Play to try again.");
      }
      setIsPlaying(true);
    } catch (error) {
      pausePlayback();
      setPlaybackError(error instanceof Error ? error.message : "Playback could not start.");
    } finally {
      setIsStarting(false);
    }
  }

  function updateVoice(voice: Voice, update: Partial<VoiceMix>) {
    setMix((current) => ({ ...current, [voice]: { ...current[voice], ...update } }));
  }

  function toggleSolo(voice: Voice) {
    setSolo((current) => {
      const next = new Set(current);
      if (next.has(voice)) next.delete(voice);
      else next.add(voice);
      return next;
    });
  }

  async function changeMarks(method: "POST" | "DELETE", mark?: CueMark, id?: string) {
    if (!user || marksBusy.current || !marksResource.data) return;
    marksBusy.current = true;
    setMarksSaving(true);
    setMarksError("");
    try {
      const result = await accountRequest<{ marks: CueMark[] }>(`marks/${tag.id}${id ? `/${encodeURIComponent(id)}` : ""}`, {
        userId: user.id, method, body: mark ? { marks: [mark] } : undefined,
      });
      marksResource.replace(result);
    } catch (error) { setMarksError(errorMessage(error)); }
    finally { marksBusy.current = false; setMarksSaving(false); }
  }

  function addMark() {
    const nextNumber = marks.length + 1;
    const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    void changeMarks("POST", { id, time: currentTime, label: `Mark ${nextNumber}` });
  }

  function removeMark(id: string) {
    void changeMarks("DELETE", undefined, id);
  }

  function resetMix() {
    setMix(defaultMix());
    setSolo(new Set());
    setSpeed(1);
    onPitchChange(0);
  }

  const progress = duration ? Math.min(100, (currentTime / duration) * 100) : 0;
  const status = useMemo(() => statusCopy(statuses), [statuses]);

  return (
    <section
      className="workspace-panel mixer-panel"
      aria-labelledby="mixer-heading"
      data-client-pitch-backend={clientPitchBackend ?? undefined}
    >
      <header className="panel-header mixer-header">
        <div>
          <h2 id="mixer-heading">Four-part mixer</h2>
        </div>
        <button className="icon-text-button" onClick={resetMix} type="button">
          <Icon name="reset" size={16} /> Reset
        </button>
      </header>

      <div className={`track-readiness ${hasError ? "has-error" : allReady ? "is-ready" : ""}`} role="status">
        <span className="readiness-dots" aria-hidden="true">
          {VOICES.map((voice) => (
            <i className={`track-dot track-${statuses[voice]}`} key={voice} style={{ "--voice-color": VOICE_COLORS[voice] } as React.CSSProperties} />
          ))}
        </span>
        <span>{status}</span>
      </div>

      <div className="transport">
        <button
          aria-label={isPlaying ? "Pause all parts" : "Play all parts"}
          className={`play-button ${isStarting ? "is-starting" : ""}`}
          disabled={hasError || isStarting}
          onClick={() => void togglePlayback()}
          title={!allReady ? "Start playback while the parts finish preparing" : undefined}
          type="button"
        >
          <Icon name={isPlaying ? "pause" : "play"} size={25} />
        </button>
        <div className="transport-main">
          <div className="time-row"><span>{formatTime(currentTime)}</span><span>{formatTime(duration)}</span></div>
          <div className="timeline-wrap">
            <div className="timeline-fill" style={{ width: `${progress}%` }} />
            {duration > 0 && marks.map((mark) => (
              <button
                aria-label={`Jump to ${mark.label} at ${formatTime(mark.time)}`}
                className="timeline-mark"
                key={mark.id}
                onClick={() => seek(mark.time)}
                style={{ left: `${Math.min(100, (mark.time / duration) * 100)}%` }}
                title={`${mark.label} · ${formatTime(mark.time)}`}
                type="button"
              />
            ))}
            <input
              aria-label="Playback position"
              disabled={!duration}
              max={duration || 1}
              min="0"
              onChange={(event) => seek(Number(event.target.value))}
              step="0.01"
              type="range"
              value={currentTime}
            />
          </div>
        </div>
        <button className="mark-button" disabled={!duration || !user || !marksResource.data || marksSaving} onClick={addMark} type="button">
          <Icon name="marker" size={17} /> Mark
        </button>
      </div>

      {playbackError && <p className="playback-error" role="alert">{playbackError}</p>}

      <div className="speed-row">
        <span>Speed</span>
        <div className="speed-control" aria-label="Playback speed">
          {SPEEDS.map((value) => (
            <button
              aria-pressed={speed === value}
              className={speed === value ? "is-active" : ""}
              key={value}
              onClick={() => setSpeed(value)}
              type="button"
            >
              {value}×
            </button>
          ))}
        </div>
      </div>

      <div className="pitch-row">
        <div className="pitch-setting">
          <span>Pitch</span>
          <PitchControl value={pitchSemitones} onChange={onPitchChange} />
        </div>
      </div>

      <div className="voice-list">
        {VOICES.map((voice) => {
          const settings = mix[voice];
          return (
            <div className={`voice-strip ${settings.muted ? "is-muted" : ""}`} key={voice}>
              <div className="voice-heading">
                <span className="voice-swatch" style={{ backgroundColor: VOICE_COLORS[voice] }} />
                <strong>{VOICE_LABELS[voice]}</strong>
                <span className={`mini-status status-${statuses[voice]}`}>{statuses[voice]}</span>
                <div className="voice-toggles">
                  <button
                    aria-label={`${settings.muted ? "Unmute" : "Mute"} ${VOICE_LABELS[voice]}`}
                    aria-pressed={settings.muted}
                    className={settings.muted ? "is-active" : ""}
                    onClick={() => updateVoice(voice, { muted: !settings.muted })}
                    type="button"
                  >M</button>
                  <button
                    aria-label={`${solo.has(voice) ? "Unsolo" : "Solo"} ${VOICE_LABELS[voice]}`}
                    aria-pressed={solo.has(voice)}
                    className={solo.has(voice) ? "is-solo" : ""}
                    onClick={() => toggleSolo(voice)}
                    type="button"
                  >S</button>
                </div>
              </div>
              <div className="voice-controls">
                <label>
                  <span><Icon name={settings.muted ? "volume-off" : "volume"} size={15} /> Volume</span>
                  <input
                    aria-label={`${VOICE_LABELS[voice]} volume`}
                    max="1"
                    min="0"
                    onChange={(event) => updateVoice(voice, { volume: Number(event.target.value) })}
                    step="0.01"
                    style={{ "--range-fill": `${settings.volume * 100}%`, "--voice-color": VOICE_COLORS[voice] } as React.CSSProperties}
                    type="range"
                    value={settings.volume}
                  />
                  <output>{Math.round(settings.volume * 100)}%</output>
                </label>
                <label>
                  <span><Icon name="headphones" size={15} /> Pan</span>
                  <input
                    aria-label={`${VOICE_LABELS[voice]} left-right pan`}
                    max="1"
                    min="-1"
                    onChange={(event) => updateVoice(voice, { pan: Number(event.target.value) })}
                    step="0.02"
                    style={{ "--range-fill": `${((settings.pan + 1) / 2) * 100}%`, "--voice-color": VOICE_COLORS[voice] } as React.CSSProperties}
                    type="range"
                    value={settings.pan}
                  />
                  <output>{panLabel(settings.pan)}</output>
                </label>
              </div>
            </div>
          );
        })}
      </div>

      <div className="marks-section">
        <div className="marks-heading">
          <div><Icon name="marker" size={17} /><strong>Saved marks</strong></div>
          <span aria-live="polite">{marksSaving ? "Saving…" : user && !accountLoading && !marksResource.loading && !marks.length ? "Choose Mark during playback" : ""}</span>
        </div>
        {!accountLoading && !user && <p className="marks-account-note"><Link className="text-link" href={`/account?next=/tags/${tag.id}`}>Sign in to save marks</Link>.</p>}
        {(accountLoading || marksResource.loading) && <p className="marks-account-note" role="status">Loading marks…</p>}
        {(marksError || marksResource.error) && <p className="form-error" role="alert">{marksError || marksResource.error} <button className="text-link" onClick={() => { setMarksError(""); marksResource.reload(); }} type="button">Reload marks</button></p>}
        {marks.length > 0 && (
          <div className="mark-list">
            {marks.map((mark) => (
              <div className="mark-chip" key={mark.id}>
                <button onClick={() => seek(mark.time)} type="button">
                  <span>{mark.label}</span><strong>{formatTime(mark.time)}</strong>
                </button>
                <button aria-label={`Delete ${mark.label}`} disabled={marksSaving} onClick={() => removeMark(mark.id)} type="button">
                  <Icon name="trash" size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
