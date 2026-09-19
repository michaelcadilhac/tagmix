import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-response";
import { getTag } from "@/lib/catalog";
import { fileResponse } from "@/lib/file-response";
import { ensureProcessedSheet } from "@/lib/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid tag id." }, { status: 400 });
  }

  try {
    const tag = await getTag(id);
    if (!tag) return NextResponse.json({ error: "Tag not found." }, { status: 404 });
    const filePath = await ensureProcessedSheet(tag);
    return fileResponse(request, filePath, "image/png");
  } catch (error) {
    return errorResponse(error, "The sheet music could not be prepared.", 502);
  }
}
