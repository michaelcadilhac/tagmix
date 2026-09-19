import { describe, expect, it } from "vitest";
import { normalizeSearchText, searchCatalog } from "@/lib/search";
import type { Tag } from "@/lib/types";

function makeTag(id: number, title: string, overrides: Partial<Tag> = {}): Tag {
  const media = { type: "mp3", url: "https://www.barbershoptags.com/file" };
  return {
    id,
    title,
    alternateTitle: "",
    version: "",
    key: "C",
    style: "Barbershop",
    recording: "single part only",
    arranger: "",
    quartet: "",
    provider: "",
    lyrics: "",
    notes: "",
    rating: null,
    downloads: null,
    updatedAt: "2025-01-01 00:00:00",
    sourcePageUrl: `https://www.barbershoptags.com/tag-${id}`,
    sheet: { type: "pdf", url: media.url },
    tracks: { bass: media, baritone: media, lead: media, tenor: media },
    audioQuality: "isolated",
    ...overrides,
  };
}

describe("catalog search", () => {
  it("normalizes punctuation and diacritics", () => {
    expect(normalizeSearchText("Év’ry Time!" )).toBe("ev ry time");
  });

  it("ranks an exact title above alternate and arranger matches", () => {
    const tags = [
      makeTag(1, "Something Else", { alternateTitle: "Blue Skies" }),
      makeTag(2, "Blue Skies"),
      makeTag(3, "A Tag", { arranger: "Blue Skies" }),
    ];
    expect(searchCatalog(tags, { query: "blue skies" }).map((tag) => tag.id)).toEqual([2, 1, 3]);
  });

  it("supports style filtering and numeric sorts", () => {
    const tags = [
      makeTag(1, "Alpha", { style: "SATB", downloads: 10 }),
      makeTag(2, "Beta", { style: "Barbershop", downloads: 500 }),
      makeTag(3, "Gamma", { style: "SATB", downloads: 100 }),
    ];
    expect(searchCatalog(tags, { style: "SATB", sort: "popular" }).map((tag) => tag.id)).toEqual([3, 1]);
  });
});
