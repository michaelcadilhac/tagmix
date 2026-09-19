import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-response";
import { getTag } from "@/lib/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid tag id." }, { status: 400 });
  }

  try {
    const tag = await getTag(id);
    if (!tag) return NextResponse.json({ error: "Tag not found." }, { status: 404 });
    return NextResponse.json(tag, {
      headers: { "Cache-Control": "public, max-age=60, s-maxage=600, stale-while-revalidate=86400" },
    });
  } catch (error) {
    return errorResponse(error, "The tag could not be loaded.", 503);
  }
}
