import { describe, expect, it } from "vitest";
import { buildSourcePageUrl, decodeCatalogBytes, parseCatalogXml } from "@/lib/catalog";

const completeFields = `
  <Parts>4</Parts>
  <Type>Barbershop</Type>
  <WritKey>Major:Bb</WritKey>
  <Recording>stereo - one part on one side, the other parts on the other side</Recording>
  <SheetMusic type="pdf">https://www.barbershoptags.com/file/score</SheetMusic>
  <Bass type="mp3">https://www.barbershoptags.com/file/bass</Bass>
  <Bari type="mp3">https://www.barbershoptags.com/file/bari</Bari>
  <Lead type="mp3">https://www.barbershoptags.com/file/lead</Lead>
  <Tenor type="mp3">https://www.barbershoptags.com/file/tenor</Tenor>`;

describe("parseCatalogXml", () => {
  it("keeps only four-part records with all named tracks and a score", () => {
    const xml = `<?xml version="1.0"?><tags available="4" stamp="2026-09-03 10:00:00">
      <tag><id>10</id><Title>&#039;Blue Skies</Title><Rating>3.8</Rating>${completeFields}</tag>
      <tag><id>11</id><Title>Missing tenor</Title>${completeFields.replace(/<Tenor[\s\S]*?<\/Tenor>/, "<Tenor />")}</tag>
      <tag><id>12</id><Title>Missing sheet</Title>${completeFields.replace(/<SheetMusic[\s\S]*?<\/SheetMusic>/, "<SheetMusic />")}</tag>
      <tag><id>13</id><Title>Five parts</Title>${completeFields.replace("<Parts>4</Parts>", "<Parts>5</Parts>")}</tag>
    </tags>`;

    const result = parseCatalogXml(xml, "2026-09-03T10:00:00.000Z");
    expect(result.sourceAvailable).toBe(4);
    expect(result.tags).toHaveLength(1);
    expect(result.tags[0]).toMatchObject({
      id: 10,
      title: "'Blue Skies",
      key: "B♭ Major",
      rating: 3.8,
      audioQuality: "extractable",
      sheet: { type: "pdf" },
    });
  });

  it("builds the slugged detail URL required by BarbershopTags", () => {
    expect(buildSourcePageUrl(
      1482,
      "'Less You Listen",
      "C to F Version",
      "https://www.barbershoptags.com/",
    )).toBe("https://www.barbershoptags.com/tag-1482-'Less-You-Listen-(C-to-F-Version)");

    expect(buildSourcePageUrl(
      99,
      "Harmony / Love?",
      "",
      "https://www.barbershoptags.com",
    )).toBe("https://www.barbershoptags.com/tag-99-Harmony-%2F-Love%3F");
  });

  it("accepts the source's occasional invalid UTF-8 without failing the XML parse", () => {
    const prefix = Buffer.from(`<?xml version="1.0"?><tags available="1"><tag><id>9</id><Title>Day `);
    const invalidLegacyDash = Buffer.from([0x96]);
    const suffix = Buffer.from(` tag</Title>${completeFields}</tag></tags>`);
    const decoded = decodeCatalogBytes(Buffer.concat([prefix, invalidLegacyDash, suffix]));

    expect(() => parseCatalogXml(decoded)).not.toThrow();
    expect(parseCatalogXml(decoded).tags[0].title).toContain("tag");
  });
});
