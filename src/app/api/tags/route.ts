import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-response";
import { getCatalogList } from "@/lib/catalog-list";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const forceRefresh = request.nextUrl.searchParams.get("refresh") === "1";
    const payload = await getCatalogList(request.nextUrl.searchParams, forceRefresh);

    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": forceRefresh
          ? "no-store"
          : "public, max-age=60, s-maxage=300, stale-while-revalidate=86400",
      },
    });
  } catch (error) {
    return errorResponse(error, "The tag catalog could not be loaded.", 503);
  }
}
