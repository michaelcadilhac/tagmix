import "server-only";

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import {
  audioQualityForRecording,
  type CatalogSnapshot,
  type SourceMedia,
  type Tag,
} from "@/lib/types";

const DEFAULT_API_URL = "https://www.barbershoptags.com/api.php";
const DEFAULT_ORIGIN = "https://www.barbershoptags.com";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;
const CATALOG_VERSION = 1 as const;

const XML_FIELDS = [
  "id",
  "Title",
  "AltTitle",
  "Version",
  "WritKey",
  "Parts",
  "Type",
  "Recording",
  "Notes",
  "Arranger",
  "Quartet",
  "Provider",
  "Lyrics",
  "Rating",
  "Downloaded",
  "stamp",
  "SheetMusic",
  "Bass",
  "Bari",
  "Lead",
  "Tenor",
].join(",");

type XmlValue = string | number | { "#text"?: string | number; "@_type"?: string } | null;
type XmlTag = Record<string, XmlValue>;

let memorySnapshot: CatalogSnapshot | null = null;
let refreshPromise: Promise<CatalogSnapshot> | null = null;
let refreshRetryAfter = 0;

function dataRoot(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.env.TAGMIX_DATA_DIR ?? path.join(process.cwd(), ".data"));
}

function cachePath(): string {
  return path.join(dataRoot(), "catalog", "catalog-v1.json");
}

function catalogTtlMs(): number {
  const configured = Number(process.env.TAGMIX_CATALOG_TTL_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_TTL_MS;
}

function sourceOrigin(): string {
  return (process.env.BARBERSHOP_TAGS_ORIGIN ?? DEFAULT_ORIGIN).replace(/\/$/, "");
}

export function buildSourcePageUrl(
  id: number,
  title: string,
  version: string,
  origin = sourceOrigin(),
): string {
  const label = `${title.trim() || `Tag ${id}`}${version.trim() ? ` (${version.trim()})` : ""}`;
  const slug = encodeURIComponent(label.replace(/\s+/g, "-"));
  return `${origin.replace(/\/$/, "")}/tag-${id}-${slug}`;
}

function decodeLegacyEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (entity, hex: string) => {
      const point = Number.parseInt(hex, 16);
      return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    })
    .replace(/&#0*(\d+);/g, (entity, decimal: string) => {
      const point = Number.parseInt(decimal, 10);
      return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    })
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"');
}

function text(value: XmlValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return decodeLegacyEntities(String(value["#text"] ?? "").trim());
  return decodeLegacyEntities(String(value).trim());
}

function numberOrNull(value: XmlValue | undefined): number | null {
  const normalized = text(value);
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedKey(value: XmlValue | undefined): string {
  const source = text(value);
  if (!source) return "";
  const [mode, pitch] = source.includes(":") ? source.split(":", 2) : ["", source];
  const prettyPitch = pitch.replaceAll("b", "♭").replaceAll("#", "♯");
  return mode ? `${prettyPitch} ${mode}` : prettyPitch;
}

function sourceMedia(value: XmlValue | undefined): SourceMedia | null {
  const url = text(value);
  if (!url) return null;

  let type = typeof value === "object" && value ? text(value["@_type"]) : "";
  if (!type) {
    try {
      type = path.extname(new URL(url).pathname).slice(1);
    } catch {
      type = "";
    }
  }

  return { url, type: type.toLocaleLowerCase() || "bin" };
}

function normalizeTag(raw: XmlTag): Tag | null {
  const id = Number(text(raw.id));
  const parts = Number(text(raw.Parts));
  const sheet = sourceMedia(raw.SheetMusic);
  const bass = sourceMedia(raw.Bass);
  const baritone = sourceMedia(raw.Bari);
  const lead = sourceMedia(raw.Lead);
  const tenor = sourceMedia(raw.Tenor);

  // The source API's Learning=Yes filter only guarantees one learning track.
  // TagMix intentionally requires the named four tracks and a score.
  if (!Number.isInteger(id) || parts !== 4 || !sheet || !bass || !baritone || !lead || !tenor) {
    return null;
  }

  const recording = text(raw.Recording);

  return {
    id,
    title: text(raw.Title) || `Tag ${id}`,
    alternateTitle: text(raw.AltTitle),
    version: text(raw.Version),
    key: normalizedKey(raw.WritKey),
    style: text(raw.Type) || "Unspecified",
    recording,
    arranger: text(raw.Arranger),
    quartet: text(raw.Quartet),
    provider: text(raw.Provider),
    lyrics: text(raw.Lyrics),
    notes: text(raw.Notes),
    rating: numberOrNull(raw.Rating),
    downloads: numberOrNull(raw.Downloaded),
    updatedAt: text(raw.stamp),
    sourcePageUrl: buildSourcePageUrl(id, text(raw.Title), text(raw.Version)),
    sheet,
    tracks: { bass, baritone, lead, tenor },
    audioQuality: audioQualityForRecording(recording),
  };
}

export function parseCatalogXml(xml: string, fetchedAt = new Date().toISOString()): CatalogSnapshot {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: false,
    trimValues: false,
  });
  const parsed = parser.parse(xml) as {
    tags?: {
      "@_available"?: string | number;
      "@_stamp"?: string;
      tag?: XmlTag | XmlTag[];
    };
  };
  const root = parsed.tags;

  if (!root) {
    throw new Error("The BarbershopTags response did not contain a tags collection.");
  }

  const rawTags = Array.isArray(root.tag) ? root.tag : root.tag ? [root.tag] : [];
  const tags = rawTags
    .map(normalizeTag)
    .filter((tag): tag is Tag => tag !== null)
    .sort((left, right) => left.title.localeCompare(right.title, undefined, { sensitivity: "base" }));

  return {
    version: CATALOG_VERSION,
    fetchedAt,
    sourceStamp: String(root["@_stamp"] ?? ""),
    sourceAvailable: Number(root["@_available"] ?? rawTags.length),
    tags,
  };
}

export function decodeCatalogBytes(bytes: Uint8Array): string {
  // Some legacy records contain isolated Windows-1252 bytes despite the XML
  // declaring UTF-8. TextDecoder's replacement mode keeps the feed parseable.
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

async function readCachedCatalog(): Promise<CatalogSnapshot | null> {
  try {
    const raw = await readFile(cachePath(), "utf8");
    const parsed = JSON.parse(raw) as CatalogSnapshot;
    if (parsed.version !== CATALOG_VERSION || !Array.isArray(parsed.tags)) return null;
    return {
      ...parsed,
      // sourcePageUrl is derived data. Rebuild it so caches written before the
      // upstream site required a nonempty slug do not retain broken links.
      tags: parsed.tags.map((tag) => ({
        ...tag,
        sourcePageUrl: buildSourcePageUrl(tag.id, tag.title, tag.version),
      })),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeCachedCatalog(snapshot: CatalogSnapshot): Promise<void> {
  const destination = cachePath();
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(snapshot), "utf8");
  await rename(temporary, destination);
}

function isFresh(snapshot: CatalogSnapshot): boolean {
  const fetchedAt = Date.parse(snapshot.fetchedAt);
  return Number.isFinite(fetchedAt) && Date.now() - fetchedAt < catalogTtlMs();
}

function catalogRequestUrl(): string {
  const url = new URL(process.env.BARBERSHOP_TAGS_API_URL ?? DEFAULT_API_URL);
  url.searchParams.set("Parts", "4");
  url.searchParams.set("Learning", "Yes");
  url.searchParams.set("SheetMusic", "Yes");
  url.searchParams.set("n", "10000");
  url.searchParams.set("Sortby", "Title");
  url.searchParams.set("fldlist", XML_FIELDS);
  url.searchParams.set("client", "TagMix");
  return url.toString();
}

async function fetchFreshCatalog(): Promise<CatalogSnapshot> {
  const response = await fetch(catalogRequestUrl(), {
    cache: "no-store",
    headers: {
      Accept: "application/xml,text/xml;q=0.9,*/*;q=0.1",
      "User-Agent": "TagMix/0.1 (+https://www.barbershoptags.com)",
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`BarbershopTags returned ${response.status} while refreshing the catalog.`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const snapshot = parseCatalogXml(decodeCatalogBytes(bytes));
  await writeCachedCatalog(snapshot);
  return snapshot;
}

async function refreshCatalog(stale: CatalogSnapshot | null): Promise<CatalogSnapshot> {
  try {
    const fresh = await fetchFreshCatalog();
    refreshRetryAfter = 0;
    memorySnapshot = fresh;
    return fresh;
  } catch (error) {
    if (stale) {
      console.warn("Catalog refresh failed; serving the last cached catalog.", error);
      refreshRetryAfter = Date.now() + 5 * 60 * 1_000;
      memorySnapshot = stale;
      return stale;
    }
    throw error;
  }
}

export async function getCatalog(options: { forceRefresh?: boolean } = {}): Promise<CatalogSnapshot> {
  if (!options.forceRefresh && memorySnapshot && isFresh(memorySnapshot)) {
    return memorySnapshot;
  }

  const diskSnapshot = memorySnapshot ?? (await readCachedCatalog());
  if (!options.forceRefresh && diskSnapshot && isFresh(diskSnapshot)) {
    memorySnapshot = diskSnapshot;
    return diskSnapshot;
  }
  if (!options.forceRefresh && diskSnapshot && Date.now() < refreshRetryAfter) {
    return diskSnapshot;
  }

  if (!refreshPromise) {
    refreshPromise = refreshCatalog(diskSnapshot).finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export async function getTag(id: number): Promise<Tag | null> {
  const snapshot = await getCatalog();
  return snapshot.tags.find((tag) => tag.id === id) ?? null;
}

export async function catalogCacheInfo(): Promise<{ exists: boolean; bytes: number }> {
  try {
    const info = await stat(cachePath());
    return { exists: true, bytes: info.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, bytes: 0 };
    throw error;
  }
}
