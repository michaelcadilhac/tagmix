import "server-only";

import { spawn } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MAX_PITCH_SEMITONES,
  MIN_PITCH_SEMITONES,
  pitchCacheSegment,
  semitonesToRatio,
} from "@/lib/pitch";
import { VOICES, type AudioQuality, type SourceMedia, type Tag, type Voice } from "@/lib/types";
import {
  buildVoiceChannelProfile,
  selectVoiceChannels,
  type StereoSamples,
  type StereoSide,
  type VoiceChannelSelection,
} from "@/lib/voice-channel";

const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const MAX_ANALYSIS_BYTES = 16 * 1024 * 1024;
const ANALYSIS_SAMPLE_RATE = 2_000;
const ANALYSIS_SECONDS = 120;
const AUDIO_SAMPLE_RATE = 44_100;
const AUDIO_CACHE_VERSION = "audio-v3";
const SERVER_PITCH_CACHE_VERSION = "server-pitch-v1";
const SHEET_CACHE_VERSION = "sheet-v1";
const locks = new Map<string, Promise<unknown>>();
let imageCommandPromise: Promise<string> | null = null;
let rubberbandSupportPromise: Promise<boolean> | null = null;

type AudioProbe = { channels: number };
type AudioSetManifest = {
  contentSamples: Record<Voice, number>;
  pitchSemitones: number;
  sampleRate: typeof AUDIO_SAMPLE_RATE;
  targetSamples: number;
  version: 1;
};
export type AudioPreparation = {
  mode: StereoSide | "mono";
  quality: AudioQuality;
  explanation: string;
};

type CachedVoiceChannelSelection = VoiceChannelSelection & {
  analysisSampleRate: number;
  version: 1;
};

class CommandError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

function dataRoot(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.env.TAGMIX_DATA_DIR ?? path.join(process.cwd(), ".data"));
}

function safeExtension(type: string): string {
  const normalized = type.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized === "jpeg") return "jpg";
  if (normalized === "midi") return "mid";
  return normalized || "bin";
}

async function usableFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).size > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const existing = locks.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const current = work().finally(() => {
    if (locks.get(key) === current) locks.delete(key);
  });
  locks.set(key, current);
  return current;
}

function allowedSourceOrigins(): Set<string> {
  const configuredOrigin = process.env.BARBERSHOP_TAGS_ORIGIN ?? "https://www.barbershoptags.com";
  const apiUrl = process.env.BARBERSHOP_TAGS_API_URL ?? "https://www.barbershoptags.com/api.php";
  return new Set([new URL(configuredOrigin).origin, new URL(apiUrl).origin, "https://barbershoptags.com"]);
}

function validateSourceUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.hostname === "barbershoptags.com" && url.protocol === "http:") {
    url.protocol = "https:";
  }
  if (url.hostname === "www.barbershoptags.com" && url.protocol === "http:") {
    url.protocol = "https:";
  }
  if (!allowedSourceOrigins().has(url.origin)) {
    throw new Error(`Refusing media URL from untrusted origin: ${url.origin}`);
  }
  return url;
}

async function fetchSource(media: SourceMedia, destination: string): Promise<string> {
  if (await usableFile(destination)) return destination;
  await mkdir(path.dirname(destination), { recursive: true });
  const url = validateSourceUrl(media.url);
  const response = await fetch(url, {
    cache: "no-store",
    headers: { "User-Agent": "TagMix/0.1 (+https://www.barbershoptags.com)" },
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) throw new Error(`Media source returned ${response.status}.`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SOURCE_BYTES) {
    throw new Error("Source media exceeds TagMix's 100 MB safety limit.");
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) throw new Error("Media source returned an empty file.");
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error("Source media exceeds TagMix's 100 MB safety limit.");

  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, destination);
  return destination;
}

function originalPath(tagId: number, name: string, media: SourceMedia): string {
  return path.join(dataRoot(), "media", String(tagId), "original", `${name}.${safeExtension(media.type)}`);
}

async function ensureOriginal(tagId: number, name: string, media: SourceMedia): Promise<string> {
  const destination = originalPath(tagId, name, media);
  return withLock(`source:${destination}`, () => fetchSource(media, destination));
}

async function runCommand(command: string, args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new CommandError(`${command} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 100_000) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 100_000) stderr += chunk.toString();
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new CommandError(`${command} could not be started: ${error.message}`, error.code));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new CommandError(`${command} exited with ${code}: ${stderr.slice(-4_000)}`));
    });
  });
}

async function supportsRubberband(): Promise<boolean> {
  if (!rubberbandSupportPromise) {
    rubberbandSupportPromise = runCommand("ffmpeg", ["-hide_banner", "-filters"], 10_000)
      .then((output) => /\brubberband\b/.test(output))
      .catch(() => false);
  }
  return rubberbandSupportPromise;
}

async function serverPitchFilter(semitones: number): Promise<string | null> {
  if (semitones === 0) return null;
  const ratio = semitonesToRatio(semitones);
  if (await supportsRubberband()) {
    return [
      `rubberband=pitch=${ratio.toFixed(10)}`,
      "tempo=1",
      "transients=smooth",
      "detector=soft",
      "phase=laminar",
      "window=long",
      "formant=preserved",
      "pitchq=quality",
    ].join(":");
  }

  const shiftedRate = 44_100 * ratio;
  return `aresample=44100,asetrate=${shiftedRate.toFixed(6)},aresample=44100,atempo=${(1 / ratio).toFixed(10)}`;
}

async function decodeStereoForAnalysis(input: string): Promise<StereoSamples> {
  const output = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        input,
        "-vn",
        "-t",
        String(ANALYSIS_SECONDS),
        "-ac",
        "2",
        "-ar",
        String(ANALYSIS_SAMPLE_RATE),
        "-f",
        "f32le",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let stderr = "";
    let settled = false;

    const finish = (error?: Error, bytes?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(bytes ?? Buffer.alloc(0));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new CommandError(`ffmpeg channel analysis timed out after 120000ms.`));
    }, 120_000);

    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_ANALYSIS_BYTES) {
        child.kill("SIGKILL");
        finish(new Error("Decoded channel-analysis audio exceeded the safety limit."));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 100_000) stderr += chunk.toString();
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(new CommandError(`ffmpeg could not be started: ${error.message}`, error.code));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new CommandError(`ffmpeg channel analysis exited with ${code}: ${stderr.slice(-4_000)}`));
        return;
      }
      finish(undefined, Buffer.concat(chunks, outputBytes));
    });
  });

  const frameCount = Math.floor(output.length / 8);
  if (frameCount < 16) throw new Error("The source contains too little audio for channel analysis.");
  const left = new Float32Array(frameCount);
  const right = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    left[frame] = output.readFloatLE(frame * 8);
    right[frame] = output.readFloatLE(frame * 8 + 4);
  }
  return { left, right };
}

async function resolveImageCommand(): Promise<string> {
  if (!imageCommandPromise) {
    imageCommandPromise = (async () => {
      for (const command of [process.env.MAGICK_BIN, "magick", "convert"].filter(Boolean) as string[]) {
        try {
          await runCommand(command, ["-version"], 10_000);
          return command;
        } catch (error) {
          if (error instanceof CommandError && error.code === "ENOENT") continue;
        }
      }
      throw new Error("ImageMagick is required to prepare sheet music.");
    })();
  }
  return imageCommandPromise;
}

async function probeAudio(input: string): Promise<AudioProbe> {
  const output = await runCommand("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=channels",
    "-of",
    "json",
    input,
  ]);
  const parsed = JSON.parse(output) as { streams?: Array<{ channels?: number }> };
  const channels = parsed.streams?.[0]?.channels ?? 1;
  return { channels: Math.max(1, channels) };
}

function isSplitStereoRecording(recording: string): boolean {
  return recording.toLocaleLowerCase().includes("one part on one side");
}

function channelSelectionPath(tagId: number): string {
  return path.join(dataRoot(), "media", String(tagId), AUDIO_CACHE_VERSION, "channel-selection.json");
}

function isCachedVoiceChannelSelection(value: unknown): value is CachedVoiceChannelSelection {
  if (!value || typeof value !== "object") return false;
  const selection = value as Partial<CachedVoiceChannelSelection>;
  return selection.version === 1
    && selection.analysisSampleRate === ANALYSIS_SAMPLE_RATE
    && (selection.method === "cross-track-reconstruction-v1"
      || selection.method === "lower-energy-fallback-v1")
    && typeof selection.score === "number"
    && Number.isFinite(selection.score)
    && typeof selection.runnerUpScore === "number"
    && Number.isFinite(selection.runnerUpScore)
    && typeof selection.confidence === "number"
    && Number.isFinite(selection.confidence)
    && !!selection.channels
    && VOICES.every((voice) => selection.channels?.[voice] === "left" || selection.channels?.[voice] === "right");
}

async function readCachedVoiceChannelSelection(filePath: string): Promise<CachedVoiceChannelSelection | null> {
  try {
    const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
    return isCachedVoiceChannelSelection(value) ? value : null;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function analyzeVoiceChannels(tag: Tag, destination: string): Promise<CachedVoiceChannelSelection> {
  const entries = await Promise.all(
    VOICES.map(async (voice) => {
      const source = await ensureOriginal(tag.id, voice, tag.tracks[voice]);
      return [voice, await decodeStereoForAnalysis(source)] as const;
    }),
  );
  const tracks = Object.fromEntries(entries) as Record<Voice, StereoSamples>;
  const selection: CachedVoiceChannelSelection = {
    ...selectVoiceChannels(buildVoiceChannelProfile(tracks)),
    analysisSampleRate: ANALYSIS_SAMPLE_RATE,
    version: 1,
  };

  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(selection, null, 2)}\n`);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return selection;
}

async function ensureVoiceChannelSelection(tag: Tag): Promise<CachedVoiceChannelSelection> {
  const destination = channelSelectionPath(tag.id);
  const cached = await readCachedVoiceChannelSelection(destination);
  if (cached) return cached;

  return withLock(`channel-selection:${destination}`, async () => {
    const current = await readCachedVoiceChannelSelection(destination);
    return current ?? analyzeVoiceChannels(tag, destination);
  });
}

export function chooseAudioPreparation(
  recording: string,
  channels: number,
  selectedSide?: StereoSide,
): AudioPreparation {
  const normalized = recording.toLocaleLowerCase();
  if (channels > 1 && isSplitStereoRecording(recording)) {
    if (!selectedSide) throw new Error("A selected side is required for split-stereo learning tracks.");
    return {
      mode: selectedSide,
      quality: "extractable",
      explanation: `The named part was detected on the ${selectedSide} learning-track channel.`,
    };
  }
  if (normalized.includes("single part only")) {
    return {
      mode: "mono",
      quality: "isolated",
      explanation: "The source is already an isolated learning part.",
    };
  }
  return {
    mode: "mono",
    quality: "best-effort",
    explanation: "This source is part-predominant or undocumented, so quiet backing voices may remain.",
  };
}

export function isolationFilterForMode(mode: AudioPreparation["mode"]): string {
  if (mode === "left") return "pan=mono|c0=c0";
  if (mode === "right") return "pan=mono|c0=c1";
  return "aformat=channel_layouts=mono";
}

export function audioPaddingPlan(contentSamples: Record<Voice, number>): {
  paddingSamples: Record<Voice, number>;
  targetSamples: number;
} {
  for (const voice of VOICES) {
    if (!Number.isSafeInteger(contentSamples[voice]) || contentSamples[voice] <= 0) {
      throw new Error(`Invalid processed sample count for ${voice}.`);
    }
  }
  const targetSamples = Math.max(...VOICES.map((voice) => contentSamples[voice]));
  const paddingSamples = Object.fromEntries(
    VOICES.map((voice) => [voice, targetSamples - contentSamples[voice]]),
  ) as Record<Voice, number>;
  return { paddingSamples, targetSamples };
}

async function findSoundfont(): Promise<string> {
  const candidates = [
    process.env.TAGMIX_SOUNDFONT,
    "/usr/share/sounds/sf2/FluidR3_GM.sf2",
    "/usr/share/sounds/sf2/TimGM6mb.sf2",
    "/usr/share/sounds/sf2/TimGM6mb.sf2.original",
    "/usr/share/sounds/sf2/default-GM.sf2",
    "/usr/share/sounds/sf3/default-GM.sf3",
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next conventional location.
    }
  }
  throw new Error("A General MIDI soundfont is required to render this learning track.");
}

async function renderMidi(input: string, workDirectory: string, voice: Voice): Promise<string> {
  const soundfont = await findSoundfont();
  const output = path.join(workDirectory, `rendered-${voice}.wav`);
  await runCommand(
    "fluidsynth",
    ["-ni", soundfont, input, "-F", output, "-r", String(AUDIO_SAMPLE_RATE)],
    120_000,
  );
  return output;
}

async function probePcmSampleCount(input: string): Promise<number> {
  const output = await runCommand("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=sample_rate,duration_ts,time_base",
    "-of",
    "json",
    input,
  ]);
  const parsed = JSON.parse(output) as {
    streams?: Array<{ duration_ts?: number | string; sample_rate?: string; time_base?: string }>;
  };
  const stream = parsed.streams?.[0];
  const sampleRate = Number(stream?.sample_rate);
  const durationTicks = Number(stream?.duration_ts);
  const [numerator, denominator] = (stream?.time_base ?? "").split("/").map(Number);
  if (sampleRate !== AUDIO_SAMPLE_RATE
    || !Number.isFinite(durationTicks)
    || durationTicks <= 0
    || !Number.isFinite(numerator)
    || !Number.isFinite(denominator)
    || denominator <= 0) {
    throw new Error("Could not determine the processed audio sample count.");
  }
  return Math.round(durationTicks * numerator / denominator * sampleRate);
}

function audioOutputDirectory(tagId: number, pitchSemitones: number): string {
  const base = path.join(dataRoot(), "media", String(tagId), AUDIO_CACHE_VERSION);
  return pitchSemitones === 0
    ? base
    : path.join(base, SERVER_PITCH_CACHE_VERSION, pitchCacheSegment(pitchSemitones));
}

function audioSetManifestPath(directory: string): string {
  return path.join(directory, "audio-set.json");
}

function isAudioSetManifest(value: unknown, pitchSemitones: number): value is AudioSetManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<AudioSetManifest>;
  return manifest.version === 1
    && manifest.pitchSemitones === pitchSemitones
    && manifest.sampleRate === AUDIO_SAMPLE_RATE
    && Number.isSafeInteger(manifest.targetSamples)
    && (manifest.targetSamples ?? 0) > 0
    && !!manifest.contentSamples
    && VOICES.every((voice) => Number.isSafeInteger(manifest.contentSamples?.[voice])
      && (manifest.contentSamples?.[voice] ?? 0) > 0);
}

async function usableAudioSet(directory: string, pitchSemitones: number): Promise<boolean> {
  try {
    const manifest: unknown = JSON.parse(await readFile(audioSetManifestPath(directory), "utf8"));
    if (!isAudioSetManifest(manifest, pitchSemitones)) return false;
    return (await Promise.all(
      VOICES.map((voice) => usableFile(path.join(directory, `${voice}.mp3`))),
    )).every(Boolean);
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function processAudioSet(
  tag: Tag,
  directory: string,
  pitchSemitones: number,
): Promise<void> {
  const workDirectory = await mkdtemp(path.join(os.tmpdir(), `tagmix-audio-${tag.id}-`));

  try {
    const channelSelection = isSplitStereoRecording(tag.recording)
      ? await ensureVoiceChannelSelection(tag)
      : null;
    const pitch = await serverPitchFilter(pitchSemitones);
    const processedEntries = await Promise.all(VOICES.map(async (voice) => {
      const media = tag.tracks[voice];
      const source = await ensureOriginal(tag.id, voice, media);
      const input = safeExtension(media.type) === "mid"
        ? await renderMidi(source, workDirectory, voice)
        : source;
      const probe = await probeAudio(input);
      const selectedSide = probe.channels > 1 ? channelSelection?.channels[voice] : undefined;
      const preparation = chooseAudioPreparation(tag.recording, probe.channels, selectedSide);
      const intermediate = path.join(workDirectory, `${voice}.wav`);
      const filter = [
        isolationFilterForMode(preparation.mode),
        "highpass=f=35",
        pitch,
        "loudnorm=I=-18:TP=-1.5:LRA=11",
      ].filter(Boolean).join(",");

      await runCommand(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          input,
          "-vn",
          "-af",
          filter,
          "-ac",
          "1",
          "-ar",
          String(AUDIO_SAMPLE_RATE),
          "-codec:a",
          "pcm_f32le",
          "-map_metadata",
          "-1",
          intermediate,
        ],
        180_000,
      );
      return [voice, {
        filePath: intermediate,
        samples: await probePcmSampleCount(intermediate),
      }] as const;
    }));
    const processed = Object.fromEntries(processedEntries) as Record<Voice, {
      filePath: string;
      samples: number;
    }>;
    const contentSamples = Object.fromEntries(
      VOICES.map((voice) => [voice, processed[voice].samples]),
    ) as Record<Voice, number>;
    const { targetSamples } = audioPaddingPlan(contentSamples);

    await Promise.all(VOICES.map(async (voice) => {
      const output = path.join(workDirectory, `${voice}.mp3`);
      await runCommand(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          processed[voice].filePath,
          "-vn",
          "-af",
          `apad=whole_len=${targetSamples},atrim=end_sample=${targetSamples},pan=stereo|c0=c0|c1=c0`,
          "-ar",
          String(AUDIO_SAMPLE_RATE),
          "-codec:a",
          "libmp3lame",
          "-b:a",
          "160k",
          "-map_metadata",
          "-1",
          output,
        ],
        180_000,
      );
    }));

    await mkdir(directory, { recursive: true });
    const stagedEntries = VOICES.map((voice) => ({
      destination: path.join(directory, `${voice}.mp3`),
      source: path.join(workDirectory, `${voice}.mp3`),
      staged: path.join(directory, `.${voice}.${process.pid}.${Date.now()}.mp3`),
    }));
    try {
      await Promise.all(stagedEntries.map(({ source, staged }) => copyFile(source, staged)));
      await Promise.all(stagedEntries.map(({ destination, staged }) => rename(staged, destination)));
    } finally {
      await Promise.all(stagedEntries.map(({ staged }) => rm(staged, { force: true })));
    }
    const manifest: AudioSetManifest = {
      contentSamples,
      pitchSemitones,
      sampleRate: AUDIO_SAMPLE_RATE,
      targetSamples,
      version: 1,
    };
    const manifestPath = audioSetManifestPath(directory);
    const temporaryManifest = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(temporaryManifest, manifestPath);
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

export async function ensureProcessedAudio(tag: Tag, voice: Voice, pitchSemitones = 0): Promise<string> {
  if (!Number.isInteger(pitchSemitones)
    || pitchSemitones < MIN_PITCH_SEMITONES
    || pitchSemitones > MAX_PITCH_SEMITONES) {
    throw new Error(`Pitch must be between ${MIN_PITCH_SEMITONES} and +${MAX_PITCH_SEMITONES} semitones.`);
  }
  const directory = audioOutputDirectory(tag.id, pitchSemitones);
  const destination = path.join(directory, `${voice}.mp3`);
  if (await usableAudioSet(directory, pitchSemitones)) return destination;
  await withLock(`audio-set:${directory}`, async () => {
    if (await usableAudioSet(directory, pitchSemitones)) return;
    await processAudioSet(tag, directory, pitchSemitones);
  });
  return destination;
}

async function cropImage(command: string, input: string, output: string): Promise<void> {
  await runCommand(
    command,
    [
      input,
      "-auto-orient",
      "-background",
      "white",
      "-alpha",
      "remove",
      "-alpha",
      "off",
      "-fuzz",
      "3%",
      "-trim",
      "+repage",
      "-bordercolor",
      "white",
      "-border",
      "28x28",
      "-resize",
      "2400x>",
      "-strip",
      output,
    ],
    120_000,
  );
}

async function processSheet(tag: Tag, destination: string): Promise<string> {
  const source = await ensureOriginal(tag.id, "sheet", tag.sheet);
  const extension = safeExtension(tag.sheet.type);
  const workDirectory = await mkdtemp(path.join(os.tmpdir(), `tagmix-sheet-${tag.id}-`));
  const temporary = `${destination}.${process.pid}.${Date.now()}.png`;
  await mkdir(path.dirname(destination), { recursive: true });

  try {
    const imageCommand = await resolveImageCommand();
    const croppedPages: string[] = [];

    if (extension === "pdf") {
      const pagePrefix = path.join(workDirectory, "page");
      await runCommand(
        "pdftoppm",
        ["-f", "1", "-l", "20", "-r", "180", "-png", "-cropbox", source, pagePrefix],
        180_000,
      );
      const pages = (await readdir(workDirectory))
        .filter((name) => /^page-\d+\.png$/.test(name))
        .sort((left, right) => {
          const leftPage = Number(left.match(/\d+/)?.[0] ?? 0);
          const rightPage = Number(right.match(/\d+/)?.[0] ?? 0);
          return leftPage - rightPage;
        });
      if (!pages.length) throw new Error("The PDF did not render any pages.");

      for (const [index, page] of pages.entries()) {
        const cropped = path.join(workDirectory, `cropped-${index + 1}.png`);
        await cropImage(imageCommand, path.join(workDirectory, page), cropped);
        croppedPages.push(cropped);
      }
    } else {
      const cropped = path.join(workDirectory, "cropped-1.png");
      await cropImage(imageCommand, `${source}[0]`, cropped);
      croppedPages.push(cropped);
    }

    if (croppedPages.length === 1) {
      await writeFile(temporary, await readFile(croppedPages[0]));
    } else {
      await runCommand(
        imageCommand,
        [...croppedPages, "-background", "#f4efe5", "-gravity", "center", "-append", temporary],
        180_000,
      );
    }

    await rename(temporary, destination);
    return destination;
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
    await rm(temporary, { force: true });
  }
}

export async function ensureProcessedSheet(tag: Tag): Promise<string> {
  const destination = path.join(dataRoot(), "media", String(tag.id), SHEET_CACHE_VERSION, "score.png");
  if (await usableFile(destination)) return destination;
  return withLock(`sheet:${destination}`, async () => {
    if (await usableFile(destination)) return destination;
    return processSheet(tag, destination);
  });
}
