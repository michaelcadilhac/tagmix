import { describe, expect, it } from "vitest";
import { parseByteRange } from "@/lib/http-range";
import { audioPaddingPlan, chooseAudioPreparation, isolationFilterForMode } from "@/lib/media";
import { DEFAULT_MIX, VOICES, type Voice } from "@/lib/types";
import {
  buildVoiceChannelProfile,
  selectVoiceChannels,
  type StereoSamples,
  type StereoSide,
} from "@/lib/voice-channel";
import tag37Fixture from "./fixtures/tag-37-channel-profile.json";

function syntheticSplitTracks(sides: Record<Voice, StereoSide>): Record<Voice, StereoSamples> {
  const sampleCount = 4_096;
  const stems = VOICES.map((_, voiceIndex) => Float64Array.from(
    { length: sampleCount },
    (_, sample) => Math.sin((sample + 1) * 0.017 * (voiceIndex + 1))
      + 0.31 * Math.cos((sample + 3) * 0.011 * (voiceIndex + 2)),
  ));

  const tracks = {} as Record<Voice, StereoSamples>;
  VOICES.forEach((voice, voiceIndex) => {
    const isolated = Float64Array.from(stems[voiceIndex], (sample) => sample * (0.7 + voiceIndex * 0.5));
    const backing = Float64Array.from({ length: sampleCount }, (_, sample) => stems.reduce(
      (sum, stem, stemIndex) => stemIndex === voiceIndex
        ? sum
        : sum + stem[sample] * (0.25 + ((voiceIndex + stemIndex) % 3) * 0.08),
      0,
    ));
    tracks[voice] = sides[voice] === "left"
      ? { left: isolated, right: backing }
      : { left: backing, right: isolated };
  });
  return tracks;
}

describe("audio preparation", () => {
  it("extracts the content-selected side of split-stereo learning tracks", () => {
    expect(chooseAudioPreparation(
      "stereo - one part on one side, the other parts on the other side",
      2,
      "right",
    )).toMatchObject({ mode: "right", quality: "extractable" });
  });

  it("selects the right channel for Bass on Tag 37, Back in My Home Town", () => {
    const selection = selectVoiceChannels(tag37Fixture.profile);
    const preparation = chooseAudioPreparation(
      "stereo - one part on one side, the other parts on the other side",
      2,
      selection.channels.bass,
    );

    expect(selection.channels.bass).toBe("right");
    expect(selection.channels).toEqual(tag37Fixture.expected);
    expect(selection.method).toBe("cross-track-reconstruction-v1");
    expect(selection.score).toBeLessThan(selection.runnerUpScore);
    expect(isolationFilterForMode(preparation.mode)).toBe("pan=mono|c0=c1");
  });

  it("detects independent left/right choices instead of assuming one fixed side", () => {
    const expected: Record<Voice, StereoSide> = {
      bass: "right",
      baritone: "left",
      lead: "right",
      tenor: "left",
    };
    const selection = selectVoiceChannels(buildVoiceChannelProfile(syntheticSplitTracks(expected)));

    expect(selection.channels).toEqual(expected);
    expect(selection.method).toBe("cross-track-reconstruction-v1");
  });

  it("downmixes single-part and part-predominant sources appropriately", () => {
    expect(chooseAudioPreparation("single part only", 2).quality).toBe("isolated");
    expect(chooseAudioPreparation("part predominant - one part louder", 2))
      .toMatchObject({ mode: "mono", quality: "best-effort" });
  });

  it("maps the requested default stereo positions", () => {
    expect(DEFAULT_MIX.bass.pan).toBe(-0.4);
    expect(DEFAULT_MIX.baritone.pan).toBe(-0.2);
    expect(DEFAULT_MIX.lead.pan).toBe(0.2);
    expect(DEFAULT_MIX.tenor.pan).toBe(0.6);
  });

  it("pads every shorter voice to the longest track for 'Less You Listen", () => {
    const plan = audioPaddingPlan({
      bass: 967_500,
      baritone: 970_200,
      lead: 970_200,
      tenor: 682_700,
    });

    expect(plan.targetSamples).toBe(970_200);
    expect(plan.paddingSamples).toEqual({
      bass: 2_700,
      baritone: 0,
      lead: 0,
      tenor: 287_500,
    });
  });
});

describe("HTTP byte ranges", () => {
  it("parses normal, open-ended, and suffix ranges", () => {
    expect(parseByteRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseByteRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange("bytes=-8", 100)).toEqual({ start: 92, end: 99 });
  });

  it("rejects invalid and out-of-bounds ranges", () => {
    expect(parseByteRange("items=0-10", 100)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=100-110", 100)).toBe("unsatisfiable");
  });
});
