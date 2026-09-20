import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-response";
import { getTag } from "@/lib/catalog";
import { fileResponse } from "@/lib/file-response";
import { ensureProcessedAudio } from "@/lib/media";
import { VOICES, type Voice } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type RouteContext = { params: Promise<{ id: string; voice: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { id: rawId, voice: rawVoice } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid tag id." }, { status: 400 });
  }
  if (!VOICES.includes(rawVoice as Voice)) {
    return NextResponse.json({ error: "Unknown voice part." }, { status: 400 });
  }
  if (new URL(request.url).searchParams.has("pitch")) {
    return NextResponse.json({ error: "Pitch is adjusted in the browser. Reload TagMix to continue." }, { status: 400 });
  }

  try {
    const tag = await getTag(id);
    if (!tag) return NextResponse.json({ error: "Tag not found." }, { status: 404 });
    const filePath = await ensureProcessedAudio(tag, rawVoice as Voice);
    const response = await fileResponse(request, filePath, "audio/mpeg");
    response.headers.set("X-TagMix-Audio-Quality", tag.audioQuality);
    return response;
  } catch (error) {
    return errorResponse(error, "The learning track could not be prepared.", 502);
  }
}
