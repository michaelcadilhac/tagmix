import { getCatalog } from "@/lib/catalog";
import { parsePositiveInteger } from "@/lib/api-response";
import { searchCatalog } from "@/lib/search";
import { readCatalogQuery } from "@/lib/catalog-query";
import { toTagSummary, type CatalogListResponse } from "@/lib/types";

/** Shared by the HTML page and JSON endpoint so they expose the same catalog. */
export async function getCatalogList(parameters: URLSearchParams, forceRefresh = false): Promise<CatalogListResponse> {
  const { query, style, sort, page } = readCatalogQuery(parameters);
  const pageSize = Math.min(parsePositiveInteger(parameters.get("limit"), 36), 100);
  const catalog = await getCatalog({ forceRefresh });
  const matches = searchCatalog(catalog.tags, { query, style, sort });
  const offset = (page - 1) * pageSize;
  return {
    items: matches.slice(offset, offset + pageSize).map(toTagSummary),
    page, pageSize, total: matches.length, catalogSize: catalog.tags.length,
    fetchedAt: catalog.fetchedAt, sourceStamp: catalog.sourceStamp,
    styles: [...new Set(catalog.tags.map((tag) => tag.style))].sort((a, b) => a.localeCompare(b)),
  };
}
