import type { CueMark } from "@/lib/account-types";

type MarkStorage = Pick<Storage, "length" | "key" | "getItem" | "removeItem">;

export async function importLegacyMarks(storage: MarkStorage, save: (tagId: number, marks: CueMark[]) => Promise<unknown>): Promise<void> {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key && /^tagmix:marks:[1-9]\d*$/.test(key)) keys.push(key);
  }
  let failed = false;
  for (const key of keys) {
    try {
      const raw = storage.getItem(key);
      if (!raw) continue;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("Invalid browser marks.");
      const marks = parsed.map((mark: CueMark, index) => ({ ...mark, label: typeof mark.label === "string" ? mark.label : `Mark ${index + 1}` }));
      if (marks.length) await save(Number(key.split(":")[2]), marks);
      // Do not erase concurrent changes or remove the only copy after a failed request.
      if (storage.getItem(key) === raw) storage.removeItem(key);
    } catch { failed = true; }
  }
  if (failed) throw new Error("Some browser marks could not be imported.");
}
