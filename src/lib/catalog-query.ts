import { isCatalogSort, type CatalogSort } from "@/lib/search";

export type CatalogQuery = { query: string; style: string; sort: CatalogSort; page: number };

export function readCatalogQuery(parameters: Pick<URLSearchParams, "get">): CatalogQuery {
  const requestedSort = parameters.get("sort") ?? "relevance";
  const requestedPage = Number(parameters.get("page") ?? 1);
  return {
    query: parameters.get("q")?.trim().slice(0, 160) ?? "",
    style: parameters.get("style")?.slice(0, 100) ?? "",
    sort: isCatalogSort(requestedSort) ? requestedSort : "relevance",
    page: Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1,
  };
}

export function catalogRequestUrl({ query, style, sort, page }: CatalogQuery, attempt = 0): string {
  const parameters = new URLSearchParams({ page: String(page), limit: "36", sort });
  if (query) parameters.set("q", query);
  if (style) parameters.set("style", style);
  parameters.set("attempt", String(attempt));
  return `/api/tags?${parameters}`;
}
