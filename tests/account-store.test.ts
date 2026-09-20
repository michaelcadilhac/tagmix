import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountStore, SESSION_SECONDS } from "@/lib/account-store";
import type { AccountUser, SavedTag } from "@/lib/account-types";

const tag = (id: number): SavedTag => ({ id, title: `Tag ${id}`, version: "", key: "C" });
const folderTag = (id: number, pitchSemitones = 0) => ({ ...tag(id), pitchSemitones });
let store: AccountStore;
let alice: AccountUser;
let bob: AccountUser;
beforeEach(() => {
  store = new AccountStore(":memory:");
  alice = store.createUser("alice@example.com", "hashed-password");
  bob = store.createUser("bob@example.com", "different-hash");
});
afterEach(() => store.db.close());

describe("account sessions", () => {
  it("rejects duplicate accounts and stores only hashed session tokens", () => {
    expect(() => store.createUser(alice.email, "another-hash")).toThrow("already exists");
    const token = store.createSession(alice.id, 1000);
    expect(store.sessionUser(token, 1001)).toEqual(alice);
    expect(store.db.prepare("SELECT token_hash FROM sessions").get()?.token_hash).not.toBe(token);
    expect(store.sessionUser(token, 1000 + SESSION_SECONDS * 1000)).toBeNull();
    expect(store.sessionUser("invalid")).toBeNull();
    store.deleteSession(token);
    expect(store.sessionUser(token, 1001)).toBeNull();
  });

  it("persists throttling and permits attempts after expiry", () => {
    store.consumeAuthAttempt("test", 2, 1000);
    store.consumeAuthAttempt("test", 2, 1001);
    expect(() => store.consumeAuthAttempt("test", 2, 1002)).toThrow("Too many attempts");
    expect(() => store.consumeAuthAttempt("test", 2, 1_000_000)).not.toThrow();
  });
});

describe("saved folders", () => {
  it("keeps pitch per folder entry, including old entries, sharing, and independent imports", () => {
    const first = store.createFolder(alice.id, "First");
    const second = store.createFolder(alice.id, "Second");
    const saved = store.addFolderTag(alice.id, first.id, tag(1), 2);
    store.addFolderTag(alice.id, second.id, tag(1), -3);
    expect(store.addFolderTag(alice.id, first.id, tag(1), 0).tags).toEqual([folderTag(1, 2)]);
    const updated = store.setFolderTagPitch(alice.id, first.id, 1, 4, saved.revision);
    expect(updated.tags).toEqual([folderTag(1, 4)]);
    expect(store.getFolder(alice.id, second.id).tags).toEqual([folderTag(1, -3)]);
    expect(() => store.setFolderTagPitch(alice.id, first.id, 1, 0, saved.revision)).toThrow("another window");
    expect(() => store.setFolderTagPitch(bob.id, first.id, 1, 0, updated.revision)).toThrow("not found");
    expect(() => store.setFolderTagPitch(alice.id, first.id, 99, 0, updated.revision)).toThrow("not found");
    for (const invalid of [-7, 7, 1.5, NaN]) {
      expect(() => store.setFolderTagPitch(alice.id, first.id, 1, invalid, updated.revision)).toThrow("Pitch");
    }
    expect(store.sharedFolder(first.shareToken).tags).toEqual([folderTag(1, 4)]);
    const copy = store.importSharedFolder(bob.id, first.shareToken);
    expect(copy.tags).toEqual([folderTag(1, 4)]);
    store.setFolderTagPitch(bob.id, copy.id, 1, -6, copy.revision);
    expect(store.sharedFolder(first.shareToken).tags).toEqual([folderTag(1, 4)]);
    store.db.prepare("UPDATE folder_tags SET tag_json = ? WHERE folder_id = ?").run(JSON.stringify(tag(1)), second.id);
    expect(store.getFolder(alice.id, second.id).tags).toEqual([folderTag(1)]);
  });
  it("imports an independent ordered copy without marks or history", () => {
    const source = store.createFolder(alice.id, "Concert");
    store.addFolderTag(alice.id, source.id, tag(1));
    const added = store.addFolderTag(alice.id, source.id, tag(2));
    store.reorderFolder(alice.id, source.id, [2, 1], added.revision);
    store.addMarks(alice.id, 1, [{ id: "personal", time: 1, label: "Private" }]);
    store.recordVisit(alice.id, tag(1));
    const copy = store.importSharedFolder(bob.id, source.shareToken);
    expect(copy.name).toBe(source.name);
    expect(copy.tags).toEqual([folderTag(2), folderTag(1)]);
    expect(copy.id).not.toBe(source.id);
    expect(copy.shareToken).not.toBe(source.shareToken);
    expect(store.getMarks(bob.id, 1)).toEqual([]);
    expect(store.listHistory(bob.id).items).toEqual([]);
    store.removeFolderTag(bob.id, copy.id, 2);
    expect(store.sharedFolder(source.shareToken).tags).toEqual([folderTag(2), folderTag(1)]);
    store.deleteFolder(alice.id, source.id);
    expect(store.sharedFolder(copy.shareToken).tags).toEqual([folderTag(1)]);
    expect(() => store.getFolder(alice.id, copy.id)).toThrow("not found");
  });

  it("imports empty folders and leaves no partial folder when an import fails", () => {
    const source = store.createFolder(alice.id, "Empty");
    expect(store.importSharedFolder(bob.id, source.shareToken).tags).toEqual([]);
    expect(() => store.importSharedFolder(bob.id, "missing")).toThrow("not found");
    expect(store.listFolders(bob.id)).toHaveLength(1);
    store.addFolderTag(alice.id, source.id, tag(1));
    store.db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON folder_tags BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    expect(() => store.importSharedFolder(bob.id, source.shareToken)).toThrow("test failure");
    expect(store.listFolders(bob.id)).toHaveLength(1);
    store.db.exec("DROP TRIGGER fail_import");
    for (let index = 1; index < 200; index++) store.createFolder(bob.id, `Folder ${index}`);
    expect(() => store.importSharedFolder(bob.id, source.shareToken)).toThrow("up to 200");
    expect(store.listFolders(bob.id)).toHaveLength(200);
  });
  it("preserves an exact custom order and prevents stale or malformed reorders", () => {
    const { id } = store.createFolder(alice.id, "Quartet night");
    store.addFolderTag(alice.id, id, tag(1));
    store.addFolderTag(alice.id, id, tag(2));
    const folder = store.addFolderTag(alice.id, id, tag(3));
    expect(store.addFolderTag(alice.id, id, tag(1)).tags).toHaveLength(3);
    expect(store.reorderFolder(alice.id, id, [3, 1, 2], folder.revision).tags.map((item) => item.id)).toEqual([3, 1, 2]);
    expect(() => store.reorderFolder(alice.id, id, [1, 2, 3], folder.revision)).toThrow("another window");
    const revision = store.getFolder(alice.id, id).revision;
    for (const ids of [[1, 2], [1, 2, 4], [1, 1, 2]]) {
      expect(() => store.reorderFolder(alice.id, id, ids, revision)).toThrow("exactly once");
    }
    expect(store.getFolder(alice.id, id).tags.map((item) => item.id)).toEqual([3, 1, 2]);
    store.removeFolderTag(alice.id, id, 1);
    expect(store.addFolderTag(alice.id, id, tag(4)).tags.map((item) => item.id)).toEqual([3, 2, 4]);
  });

  it("enforces ownership on every operation and exposes only shared folder data", () => {
    const folder = store.createFolder(alice.id, "Concert");
    store.addFolderTag(alice.id, folder.id, tag(1));
    store.addMarks(alice.id, 1, [{ id: "private", time: 3, label: "Personal" }]);
    store.recordVisit(alice.id, tag(1));
    expect(store.listFolders(bob.id)).toEqual([]);
    for (const action of [
      () => store.getFolder(bob.id, folder.id),
      () => store.renameFolder(bob.id, folder.id, "Stolen"),
      () => store.deleteFolder(bob.id, folder.id),
      () => store.addFolderTag(bob.id, folder.id, tag(2)),
      () => store.removeFolderTag(bob.id, folder.id, 1),
      () => store.reorderFolder(bob.id, folder.id, [1], 1),
    ]) expect(action).toThrow("not found");
    expect(store.sharedFolder(folder.shareToken)).toEqual({ name: "Concert", ownerEmail: alice.email, tags: [folderTag(1)], access: "view" });
    expect(() => store.sharedFolder(folder.id)).toThrow("not found");
    store.renameFolder(alice.id, folder.id, "Encore");
    expect(store.sharedFolder(folder.shareToken).name).toBe("Encore");
    store.deleteFolder(alice.id, folder.id);
    expect(() => store.sharedFolder(folder.shareToken)).toThrow("not found");
    expect(store.db.prepare("SELECT count(*) AS count FROM folder_tags").get()?.count).toBe(0);
    expect(store.getMarks(alice.id, 1)).toHaveLength(1);
  });
});

describe("personal marks and history", () => {
  it("merges mark imports idempotently without losing account marks or crossing accounts", () => {
    const first = { id: "one", time: 5, label: "First" };
    const second = { id: "two", time: 2, label: "Second" };
    store.addMarks(alice.id, 1, [first]);
    store.addMarks(alice.id, 1, [second, first]);
    expect(store.addMarks(alice.id, 1, [second])).toEqual([second, first]);
    expect(store.getMarks(bob.id, 1)).toEqual([]);
    expect(store.getMarks(alice.id, 2)).toEqual([]);
    store.removeMark(bob.id, 1, "one");
    expect(store.getMarks(alice.id, 1)).toHaveLength(2);
    expect(store.removeMark(alice.id, 1, "one")).toEqual([second]);
  });

  it("stores the latest visit per tag and clears only the requesting user's history", () => {
    store.recordVisit(alice.id, tag(1), "2026-09-01T00:00:00Z");
    store.recordVisit(alice.id, tag(2), "2026-09-02T00:00:00Z");
    store.recordVisit(alice.id, tag(1), "2026-09-03T00:00:00Z");
    store.recordVisit(bob.id, tag(3));
    expect(store.listHistory(alice.id).items.map((item) => item.id)).toEqual([1, 2]);
    expect(store.listHistory(alice.id).items[0].viewedAt).toBe("2026-09-03T00:00:00Z");
    store.clearHistory(alice.id);
    expect(store.listHistory(alice.id).items).toEqual([]);
    expect(store.listHistory(bob.id).items).toHaveLength(1);
  });

  it("paginates history", () => {
    for (let id = 1; id <= 55; id++) store.recordVisit(alice.id, tag(id));
    expect(store.listHistory(alice.id)).toMatchObject({ hasMore: true });
    expect(store.listHistory(alice.id).items).toHaveLength(50);
    expect(store.listHistory(alice.id, 50)).toMatchObject({ hasMore: false });
    expect(store.listHistory(alice.id, 50).items).toHaveLength(5);
  });

  it("retains account data when the database is reopened", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "tagmix-account-test-"));
    const filename = path.join(directory, "accounts.sqlite");
    try {
      let disk = new AccountStore(filename);
      const user = disk.createUser("persistent@example.com", "hash");
      const folder = disk.createFolder(user.id, "Saved forever");
      disk.addFolderTag(user.id, folder.id, tag(1), 3);
      disk.addMarks(user.id, 1, [{ id: "mark", time: 1, label: "Start" }]);
      disk.recordVisit(user.id, tag(1));
      const token = disk.createSession(user.id);
      disk.db.close();
      disk = new AccountStore(filename);
      expect(disk.sessionUser(token)).toEqual(user);
      expect(disk.sharedFolder(folder.shareToken).tags).toEqual([folderTag(1, 3)]);
      expect(disk.getMarks(user.id, 1)).toHaveLength(1);
      expect(disk.listHistory(user.id).items).toHaveLength(1);
      disk.db.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe("linked shared folders", () => {
  it("attaches a read-only original idempotently and forbids every mutation", () => {
    const folder = store.createFolder(alice.id, "Shared");
    store.addFolderTag(alice.id, folder.id, tag(1), 2);
    expect(store.addSharedFolder(bob.id, folder.shareToken)).toMatchObject({ id: folder.id, access: "view", shareToken: "", tags: [folderTag(1, 2)] });
    store.addSharedFolder(bob.id, folder.shareToken);
    expect(store.listFolders(bob.id)).toHaveLength(1);
    expect(store.folderIdsForTag(bob.id, 1)).toEqual([folder.id]);
    for (const action of [
      () => store.addFolderTag(bob.id, folder.id, tag(2)),
      () => store.removeFolderTag(bob.id, folder.id, 1),
      () => store.setFolderTagPitch(bob.id, folder.id, 1, 3, 1),
      () => store.reorderFolder(bob.id, folder.id, [1], 1),
    ]) expect(action).toThrow("read-only");
    expect(() => store.renameFolder(bob.id, folder.id, "Changed")).toThrow("Only the owner");
    expect(() => store.deleteFolder(bob.id, folder.id)).toThrow("Only the owner");
    store.renameFolder(alice.id, folder.id, "New title");
    expect(store.getFolder(bob.id, folder.id).name).toBe("New title");
    store.leaveFolder(bob.id, folder.id);
    expect(store.listFolders(bob.id)).toEqual([]);
    expect(store.getFolder(alice.id, folder.id).tags).toHaveLength(1);
    expect(() => store.leaveFolder(alice.id, folder.id)).toThrow("Owners");
  });

  it("upgrades viewers to editors without transferring ownership or exposing sharing secrets", () => {
    const folder = store.createFolder(alice.id, "Shared");
    store.addSharedFolder(bob.id, folder.shareToken);
    store.setFolderSharing(alice.id, folder.id, "edit");
    const editToken = folder.shareToken;
    expect(store.sharedFolder(editToken!)).toEqual({ name: "Shared", ownerEmail: alice.email, tags: [], access: "edit" });
    expect(store.addSharedFolder(bob.id, editToken!).access).toBe("edit");
    expect(store.addSharedFolder(bob.id, folder.shareToken).access).toBe("edit");
    expect(store.addSharedFolder(alice.id, editToken!).access).toBe("owner");
    expect(() => store.renameFolder(bob.id, folder.id, "By editor")).toThrow("Only the owner");
    store.addFolderTag(bob.id, folder.id, tag(1), -2);
    let edited = store.addFolderTag(bob.id, folder.id, tag(2));
    edited = store.reorderFolder(bob.id, folder.id, [2, 1], edited.revision);
    edited = store.setFolderTagPitch(bob.id, folder.id, 1, 4, edited.revision);
    expect(store.getFolder(alice.id, folder.id).tags).toEqual([folderTag(2), folderTag(1, 4)]);
    expect(edited.shareToken).toBe("");
    expect(() => store.setFolderTagPitch(alice.id, folder.id, 1, 0, edited.revision - 1)).toThrow("another window");
    store.removeFolderTag(bob.id, folder.id, 2);
    expect(store.getFolder(alice.id, folder.id).tags).toEqual([folderTag(1, 4)]);
    for (const action of [
      () => store.folderSharing(bob.id, folder.id),
      () => store.setFolderSharing(bob.id, folder.id, "view"),
      () => store.deleteFolder(bob.id, folder.id),
    ]) expect(action).toThrow("Only the owner");
    const copy = store.importSharedFolder(bob.id, editToken!);
    expect(copy.access).toBe("owner");
    store.renameFolder(bob.id, copy.id, "Copy");
    expect(store.getFolder(alice.id, folder.id).name).toBe("Shared");
    store.deleteFolder(alice.id, folder.id);
    expect(() => store.getFolder(bob.id, folder.id)).toThrow("not found");
    expect(store.db.prepare("SELECT count(*) AS count FROM folder_saves").get()?.count).toBe(0);
    expect(store.getFolder(bob.id, copy.id).name).toBe("Copy");
  });

  it("keeps one URL and saved memberships while changing everyone's access", () => {
    const folder = store.createFolder(alice.id, "Shared");
    store.addFolderTag(alice.id, folder.id, tag(1), 2);
    store.addMarks(bob.id, 1, [{ id: "personal", time: 1, label: "Mine" }]);
    store.addSharedFolder(bob.id, folder.shareToken);
    const copy = store.importSharedFolder(bob.id, folder.shareToken);
    for (const access of ["edit", "view", "edit", "view"] as const) {
      expect(store.setFolderSharing(alice.id, folder.id, access)).toEqual({ access });
      expect(store.getFolder(alice.id, folder.id)).toMatchObject({ shareToken: folder.shareToken, access: "owner", shareAccess: access });
      expect(store.getFolder(bob.id, folder.id)).toMatchObject({ access, ownerEmail: alice.email });
      expect(store.sharedFolder(folder.shareToken)).toMatchObject({ access, ownerEmail: alice.email });
      expect(store.canonicalShareToken(folder.shareToken)).toBe(folder.shareToken);
      expect(store.listFolders(bob.id)).toHaveLength(2);
      expect(store.folderIdsForTag(bob.id, 1)).toEqual([copy.id, folder.id]);
      if (access === "view") expect(() => store.addFolderTag(bob.id, folder.id, tag(2))).toThrow("read-only");
      else expect(store.addFolderTag(bob.id, folder.id, tag(2)).tags).toHaveLength(2);
      expect(store.getFolder(bob.id, copy.id)).toMatchObject({ access: "owner", shareAccess: "view", ownerEmail: bob.email, tags: [folderTag(1, 2)] });
    }
    expect(store.getMarks(bob.id, 1)).toHaveLength(1);
    store.leaveFolder(bob.id, folder.id);
    store.setFolderSharing(alice.id, folder.id, "edit");
    expect(() => store.getFolder(bob.id, folder.id)).toThrow("not found");
    expect(store.addSharedFolder(bob.id, folder.shareToken).access).toBe("edit");
  });

  it("exposes only the owner email in shared data and restricts settings to the owner", () => {
    const folder = store.createFolder(alice.id, "Shared");
    store.addSharedFolder(bob.id, folder.shareToken);
    expect(store.folderSharing(alice.id, folder.id)).toEqual({ access: "view" });
    expect(() => store.folderSharing(bob.id, folder.id)).toThrow("Only the owner");
    expect(store.sharedFolder(folder.shareToken)).toEqual({ name: "Shared", ownerEmail: alice.email, access: "view", tags: [] });
    expect(JSON.stringify(store.sharedFolder(folder.shareToken))).not.toContain(bob.email);
  });

  it.each([1, 2, 3])("migrates version %i while retaining main URLs, saved folders, and pitches", (version) => {
    const directory = mkdtempSync(path.join(tmpdir(), "tagmix-sharing-migration-"));
    try {
      const filename = path.join(directory, "accounts.sqlite");
      let disk = new AccountStore(filename);
      const owner = disk.createUser("owner@example.com", "hash");
      const viewer = disk.createUser("viewer@example.com", "hash");
      const editor = disk.createUser("editor@example.com", "hash");
      const folder = disk.createFolder(owner.id, "Legacy");
      disk.addFolderTag(owner.id, folder.id, tag(1), -3);
      const oldEdit = "e".repeat(48);
      disk.db.exec(`DROP TABLE folder_settings; DROP TABLE folder_saves; DROP TABLE folder_share_aliases; PRAGMA user_version = ${version};`);
      if (version > 1) {
        disk.db.exec(`CREATE TABLE folder_sharing (
          folder_id TEXT PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE,
          view_enabled INTEGER NOT NULL DEFAULT 1, edit_token TEXT UNIQUE
        ) STRICT;`);
        disk.db.prepare("INSERT INTO folder_sharing VALUES (?, 1, ?)").run(folder.id, oldEdit);
        const table = version === 2 ? "folder_members" : "folder_grants";
        disk.db.exec(`CREATE TABLE ${table} (
          folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          access TEXT NOT NULL,
          PRIMARY KEY(folder_id, user_id${version === 3 ? ", access" : ""})
        ) STRICT;`);
        const insert = disk.db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?)`);
        insert.run(folder.id, viewer.id, "view");
        insert.run(folder.id, editor.id, "edit");
        if (version === 3) insert.run(folder.id, editor.id, "view");
      }
      disk.db.close();
      disk = new AccountStore(filename);
      expect(disk.getFolder(owner.id, folder.id)).toMatchObject({ shareToken: folder.shareToken, shareAccess: "view", tags: [folderTag(1, -3)] });
      if (version > 1) {
        expect(disk.listFolders(viewer.id)).toHaveLength(1);
        expect(disk.listFolders(editor.id)).toHaveLength(1);
        expect(disk.getFolder(editor.id, folder.id).access).toBe("view");
        expect(disk.canonicalShareToken(oldEdit)).toBe(folder.shareToken);
        expect(disk.sharedFolder(oldEdit)).toEqual(disk.sharedFolder(folder.shareToken));
      }
      disk.setFolderSharing(owner.id, folder.id, "edit");
      disk.db.close();
      disk = new AccountStore(filename);
      expect(disk.folderSharing(owner.id, folder.id)).toEqual({ access: "edit" });
      expect(disk.canonicalShareToken(folder.shareToken)).toBe(folder.shareToken);
      if (version > 1) {
        expect(disk.getFolder(viewer.id, folder.id).access).toBe("edit");
        disk.leaveFolder(viewer.id, folder.id);
        disk.db.close();
        disk = new AccountStore(filename);
        expect(() => disk.getFolder(viewer.id, folder.id)).toThrow("not found");
        expect(disk.canonicalShareToken(oldEdit)).toBe(folder.shareToken);
        disk.deleteFolder(owner.id, folder.id);
        expect(() => disk.sharedFolder(oldEdit)).toThrow("not found");
      }
      disk.db.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
