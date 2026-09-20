import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/tags/[id]/audio/[voice]/route";
import { getTag } from "@/lib/catalog";
import { ensureProcessedAudio } from "@/lib/media";
import { fileResponse } from "@/lib/file-response";

vi.mock("@/lib/catalog", () => ({ getTag: vi.fn(async () => ({ id: 37, audioQuality: "extractable" })) }));
vi.mock("@/lib/media", () => ({ ensureProcessedAudio: vi.fn(async () => "/tmp/bass.mp3") }));
vi.mock("@/lib/file-response", () => ({ fileResponse: vi.fn(async () => new Response("audio", { status: 206 })) }));
beforeEach(() => vi.clearAllMocks());
const context = { params: Promise.resolve({ id: "37", voice: "bass" }) };

describe("audio delivery", () => {
  it("rejects removed pitch variants before fetching or processing media", async () => {
    for (const pitch of ["2", "0", "invalid"]) {
      expect((await GET(new Request(`http://localhost/api/tags/37/audio/bass?pitch=${pitch}`), context)).status).toBe(400);
    }
    expect(getTag).not.toHaveBeenCalled();
    expect(ensureProcessedAudio).not.toHaveBeenCalled();
  });

  it("delivers the original-key audio through the existing range handler", async () => {
    const request = new Request("http://localhost/api/tags/37/audio/bass", { headers: { Range: "bytes=0-3" } });
    const response = await GET(request, context);
    expect(response.status).toBe(206);
    expect(fileResponse).toHaveBeenCalledWith(request, "/tmp/bass.mp3", "audio/mpeg");
    expect(ensureProcessedAudio).toHaveBeenCalledWith({ id: 37, audioQuality: "extractable" }, "bass");
    expect(response.headers.get("X-TagMix-Audio-Quality")).toBe("extractable");
  });
});
