import { describe, expect, it } from "vitest";
import { importLegacyMarks } from "@/lib/legacy-marks";
import type { CueMark } from "@/lib/account-types";

function storageFor(values: Record<string, string>) {
  const data = new Map(Object.entries(values));
  return {
    data, get length() { return data.size; }, key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null, removeItem: (key: string) => { data.delete(key); },
  };
}
const mark = { id: "legacy", time: 3.2, label: "Mark 1" };
describe("silent browser mark migration", () => {
  it("imports all tags and removes local copies only after confirmation", async () => {
    const storage = storageFor({ "tagmix:marks:1": JSON.stringify([mark]), "tagmix:marks:2": JSON.stringify([mark]), "tagmix:mix:1": "keep" });
    const saved: Array<{ id: number; marks: CueMark[] }> = [];
    await importLegacyMarks(storage, async (id, marks) => {
      expect(storage.getItem(`tagmix:marks:${id}`)).not.toBeNull();
      saved.push({ id, marks });
    });
    expect(saved).toEqual([{ id: 1, marks: [mark] }, { id: 2, marks: [mark] }]);
    expect([...storage.data.keys()]).toEqual(["tagmix:mix:1"]);
    await importLegacyMarks(storage, async () => { throw new Error("Should not reimport"); });
  });
  it("preserves failures and concurrent local edits while continuing other imports", async () => {
    const raw = JSON.stringify([mark]);
    const storage = storageFor({ "tagmix:marks:1": raw, "tagmix:marks:2": raw, "tagmix:marks:3": raw, "tagmix:marks:4": "broken" });
    await expect(importLegacyMarks(storage, async (id) => {
      if (id === 1) throw new Error("Offline");
      if (id === 2) storage.data.set("tagmix:marks:2", "changed");
    })).rejects.toThrow("could not be imported");
    expect(storage.getItem("tagmix:marks:1")).toBe(raw);
    expect(storage.getItem("tagmix:marks:2")).toBe("changed");
    expect(storage.getItem("tagmix:marks:3")).toBeNull();
    expect(storage.getItem("tagmix:marks:4")).toBe("broken");
  });
});
