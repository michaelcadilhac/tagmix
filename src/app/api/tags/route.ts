import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parsePositiveInteger } from "@/lib/api-response";
import { getCatalog } from "@/lib/catalog";
import { isCatalogSort, searchCatalog } from "@/lib/search";
import { toTagSummary, type CatalogListResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const query = request.nextUrl.searchParams.get("q")?.slice(0, 160) ?? "";
    const style = request.nextUrl.searchParams.get("style")?.slice(0, 100) ?? "";
    const requestedSort = request.nextUrl.searchParams.get("sort") ?? "";
    const sort = isCatalogSort(requestedSort) ? requestedSort : query ? "relevance" : "title";
    const page = parsePositiveInteger(request.nextUrl.searchParams.get("page"), 1);
    const pageSize = Math.min(parsePositiveInteger(request.nextUrl.searchParams.get("limit"), 36), 100);
    const forceRefresh = request.nextUrl.searchParams.get("refresh") === "1";
    const catalog = await getCatalog({ forceRefresh });
    const matches = searchCatalog(catalog.tags, { query, style, sort });
    const offset = (page - 1) * pageSize;
    const styles = [...new Set(catalog.tags.map((tag) => tag.style))].sort((a, b) => a.localeCompare(b));

    const payload: CatalogListResponse = {
      items: matches.slice(offset, offset + pageSize).map(toTagSummary),
      page,
      pageSize,
      total: matches.length,
      catalogSize: catalog.tags.length,
      fetchedAt: catalog.fetchedAt,
      sourceStamp: catalog.sourceStamp,
      styles,
    };

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
