import type { Tag } from "@/lib/types";

export type CatalogSort = "relevance" | "title" | "rating" | "popular" | "recent";

type SearchOptions = {
  query?: string;
  style?: string;
  sort?: CatalogSort;
};

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function relevance(tag: Tag, query: string): number {
  if (!query) return 0;
  const title = normalizeSearchText(tag.title);
  const alternateTitle = normalizeSearchText(tag.alternateTitle);
  const version = normalizeSearchText(tag.version);
  const arranger = normalizeSearchText(tag.arranger);
  const haystack = `${title} ${alternateTitle} ${version} ${arranger}`;
  const terms = query.split(" ").filter(Boolean);

  if (!terms.every((term) => haystack.includes(term))) return -1;

  let score = 0;
  if (title === query) score += 500;
  if (title.startsWith(query)) score += 250;
  else if (title.includes(query)) score += 150;
  if (alternateTitle.includes(query)) score += 80;
  if (version.includes(query)) score += 40;
  if (arranger.includes(query)) score += 30;
  score += tag.rating ?? 0;
  return score;
}

export function searchCatalog(tags: Tag[], options: SearchOptions = {}): Tag[] {
  const query = normalizeSearchText(options.query ?? "");
  const requestedSort = options.sort ?? (query ? "relevance" : "title");
  const matches = tags
    .map((tag) => ({ tag, score: relevance(tag, query) }))
    .filter(({ tag, score }) => {
      const styleMatches = !options.style || tag.style === options.style;
      return styleMatches && score >= 0;
    });

  matches.sort((left, right) => {
    if (requestedSort === "relevance" && right.score !== left.score) return right.score - left.score;
    if (requestedSort === "rating") {
      const difference = (right.tag.rating ?? -1) - (left.tag.rating ?? -1);
      if (difference) return difference;
    }
    if (requestedSort === "popular") {
      const difference = (right.tag.downloads ?? -1) - (left.tag.downloads ?? -1);
      if (difference) return difference;
    }
    if (requestedSort === "recent") {
      const difference = Date.parse(right.tag.updatedAt) - Date.parse(left.tag.updatedAt);
      if (Number.isFinite(difference) && difference) return difference;
    }
    return collator.compare(left.tag.title, right.tag.title) || left.tag.id - right.tag.id;
  });

  return matches.map(({ tag }) => tag);
}

export function isCatalogSort(value: string): value is CatalogSort {
  return ["relevance", "title", "rating", "popular", "recent"].includes(value);
}
