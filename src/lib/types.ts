export const VOICES = ["bass", "baritone", "lead", "tenor"] as const;

export type Voice = (typeof VOICES)[number];

export type SourceMedia = {
  type: string;
  url: string;
};

export type AudioQuality = "isolated" | "extractable" | "best-effort";

export type Tag = {
  id: number;
  title: string;
  alternateTitle: string;
  version: string;
  key: string;
  style: string;
  recording: string;
  arranger: string;
  quartet: string;
  provider: string;
  lyrics: string;
  notes: string;
  rating: number | null;
  downloads: number | null;
  updatedAt: string;
  sourcePageUrl: string;
  sheet: SourceMedia;
  tracks: Record<Voice, SourceMedia>;
  audioQuality: AudioQuality;
};

export type TagSummary = Pick<
  Tag,
  | "id"
  | "title"
  | "alternateTitle"
  | "version"
  | "key"
  | "style"
  | "arranger"
  | "rating"
  | "downloads"
  | "updatedAt"
  | "audioQuality"
>;

export type CatalogSnapshot = {
  version: 1;
  fetchedAt: string;
  sourceStamp: string;
  sourceAvailable: number;
  tags: Tag[];
};

export type CatalogListResponse = {
  items: TagSummary[];
  page: number;
  pageSize: number;
  total: number;
  catalogSize: number;
  fetchedAt: string;
  sourceStamp: string;
  styles: string[];
};

export const VOICE_LABELS: Record<Voice, string> = {
  bass: "Bass",
  baritone: "Baritone",
  lead: "Lead",
  tenor: "Tenor",
};

export const VOICE_SOURCE_FIELDS: Record<Voice, string> = {
  bass: "Bass",
  baritone: "Bari",
  lead: "Lead",
  tenor: "Tenor",
};

export const VOICE_COLORS: Record<Voice, string> = {
  bass: "#cb5b43",
  baritone: "#d99632",
  lead: "#338f83",
  tenor: "#5c72ad",
};

export const DEFAULT_MIX: Record<Voice, { pan: number; volume: number }> = {
  bass: { pan: -0.4, volume: 1 },
  baritone: { pan: -0.2, volume: 1 },
  lead: { pan: 0.2, volume: 1 },
  tenor: { pan: 0.6, volume: 1 },
};

export function audioQualityForRecording(recording: string): AudioQuality {
  const normalized = recording.toLocaleLowerCase();

  if (normalized.includes("single part only")) {
    return "isolated";
  }

  if (normalized.includes("one part on one side")) {
    return "extractable";
  }

  return "best-effort";
}

export function toTagSummary(tag: Tag): TagSummary {
  return {
    id: tag.id,
    title: tag.title,
    alternateTitle: tag.alternateTitle,
    version: tag.version,
    key: tag.key,
    style: tag.style,
    arranger: tag.arranger,
    rating: tag.rating,
    downloads: tag.downloads,
    updatedAt: tag.updatedAt,
    audioQuality: tag.audioQuality,
  };
}
