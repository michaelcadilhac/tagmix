import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AccountError } from "@/lib/account-errors";
import type { AccountUser, CueMark, FolderAccess, FolderSharing, FolderSummary, FolderTag, HistoryItem, SavedFolder, SavedTag, SharedFolder } from "@/lib/account-types";
import { isPitchSemitones } from "@/lib/pitch";

export const SESSION_SECONDS = 60 * 60 * 24 * 30;
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export class AccountStore {
  readonly db: DatabaseSync;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS folders (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL, share_token TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE INDEX IF NOT EXISTS folders_owner ON folders(user_id);
      CREATE TABLE IF NOT EXISTS folder_tags (
        folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL, tag_json TEXT NOT NULL, position INTEGER NOT NULL,
        PRIMARY KEY(folder_id, tag_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS marks (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, tag_id INTEGER NOT NULL,
        id TEXT NOT NULL, time REAL NOT NULL, label TEXT NOT NULL,
        PRIMARY KEY(user_id, tag_id, id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS auth_limits (
        key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, reset_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS history (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL, tag_json TEXT NOT NULL, viewed_at TEXT NOT NULL,
        PRIMARY KEY(user_id, tag_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS history_recent ON history(user_id, viewed_at DESC);
      CREATE TABLE IF NOT EXISTS folder_settings (
        folder_id TEXT PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE,
        access TEXT NOT NULL DEFAULT 'view' CHECK(access IN ('view', 'edit'))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS folder_saves (
        folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY(folder_id, user_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS folder_saves_user ON folder_saves(user_id);
      CREATE TABLE IF NOT EXISTS folder_share_aliases (
        token TEXT PRIMARY KEY,
        folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE
      ) STRICT;
    `);
    this.transaction(() => {
      const exists = (table: string) => this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      this.db.exec("INSERT OR IGNORE INTO folder_settings (folder_id) SELECT id FROM folders;");
      // Existing main URLs remain canonical. Old edit URLs are redirect-only aliases.
      if (exists("folder_sharing")) {
        this.db.exec(`INSERT OR IGNORE INTO folder_share_aliases (token, folder_id)
          SELECT edit_token, folder_id FROM folder_sharing WHERE edit_token IS NOT NULL;
          DROP TABLE folder_sharing;`);
      }
      for (const table of ["folder_members", "folder_grants"]) {
        if (exists(table)) {
          this.db.exec(`INSERT OR IGNORE INTO folder_saves (folder_id, user_id)
            SELECT folder_id, user_id FROM ${table} WHERE access IN ('view', 'edit');
            DROP TABLE ${table};`);
        }
      }
      this.db.exec("PRAGMA user_version = 4;");
    });
  }

  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createUser(email: string, passwordHash: string): AccountUser {
    return this.transaction(() => {
      if (this.findCredentials(email)) throw new AccountError("An account with that email already exists. Sign in instead.", 409);
      const user = { id: randomUUID(), email };
      this.db.prepare("INSERT INTO users VALUES (?, ?, ?)").run(user.id, email, passwordHash);
      return user;
    });
  }

  findCredentials(email: string): (AccountUser & { passwordHash: string }) | undefined {
    return this.db.prepare("SELECT id, email, password_hash AS passwordHash FROM users WHERE email = ?").get(email) as (AccountUser & { passwordHash: string }) | undefined;
  }

  createSession(userId: string, now = Date.now()): string {
    const token = randomBytes(32).toString("hex");
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    this.db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(tokenHash(token), userId, now + SESSION_SECONDS * 1000);
    return token;
  }

  sessionUser(token: string | undefined, now = Date.now()): AccountUser | null {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    return this.db.prepare(`SELECT users.id, users.email FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE token_hash = ? AND expires_at > ?`).get(tokenHash(token), now) as AccountUser | undefined ?? null;
  }

  deleteSession(token: string | undefined) {
    if (token) this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
  }

  consumeAuthAttempt(key: string, limit: number, now = Date.now()) {
    this.transaction(() => {
      this.db.prepare("DELETE FROM auth_limits WHERE reset_at <= ?").run(now);
      const row = this.db.prepare("SELECT attempts FROM auth_limits WHERE key = ?").get(key);
      if (row && Number(row.attempts) >= limit) throw new AccountError("Too many attempts. Try again in 15 minutes.", 429);
      this.db.prepare(`INSERT INTO auth_limits VALUES (?, 1, ?)
        ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1`).run(key, now + 15 * 60 * 1000);
    });
  }

  listFolders(userId: string): FolderSummary[] {
    return this.db.prepare(`SELECT f.id, f.name, f.revision, u.email AS ownerEmail, s.access AS shareAccess,
      CASE WHEN f.user_id = ? THEN f.share_token ELSE '' END AS shareToken,
      CASE WHEN f.user_id = ? THEN 'owner' ELSE s.access END AS access,
      (SELECT count(*) FROM folder_tags WHERE folder_id = f.id) AS count
      FROM folders f JOIN folder_settings s ON s.folder_id = f.id JOIN users u ON u.id = f.user_id
      LEFT JOIN folder_saves m ON m.folder_id = f.id AND m.user_id = ?
      WHERE f.user_id = ? OR m.user_id IS NOT NULL ORDER BY f.rowid DESC`)
      .all(userId, userId, userId, userId) as FolderSummary[];
  }

  folderIdsForTag(userId: string, tagId: number): string[] {
    return this.db.prepare(`SELECT f.id FROM folders f
      JOIN folder_tags t ON t.folder_id = f.id
      WHERE (f.user_id = ? OR EXISTS (
        SELECT 1 FROM folder_saves m WHERE m.folder_id = f.id AND m.user_id = ?
      )) AND t.tag_id = ? ORDER BY f.rowid DESC`)
      .all(userId, userId, tagId).map((row) => String(row.id));
  }

  createFolder(userId: string, name: string): SavedFolder {
    return this.transaction(() => this.insertFolder(userId, name));
  }

  private insertFolder(userId: string, name: string): SavedFolder {
    if (this.listFolders(userId).length >= 200) throw new AccountError("You can have up to 200 folders.");
    const id = randomUUID();
    this.db.prepare("INSERT INTO folders (id, user_id, name, share_token) VALUES (?, ?, ?, ?)")
      .run(id, userId, name, randomBytes(24).toString("hex"));
    this.db.prepare("INSERT INTO folder_settings (folder_id) VALUES (?)").run(id);
    return this.getFolder(userId, id);
  }

  importSharedFolder(userId: string, token: string): SavedFolder {
    return this.transaction(() => {
      const shared = this.sharedFolder(token);
      const folder = this.insertFolder(userId, shared.name);
      const insert = this.db.prepare("INSERT INTO folder_tags (folder_id, tag_id, tag_json, position) VALUES (?, ?, ?, ?)");
      shared.tags.forEach((tag, position) => insert.run(folder.id, tag.id, JSON.stringify(tag), position));
      return this.getFolder(userId, folder.id);
    });
  }

  getFolder(userId: string, id: string): SavedFolder {
    const folder = this.listFolders(userId).find((folder) => folder.id === id);
    if (!folder) throw new AccountError("Folder not found.", 404);
    const tags = this.folderTags(id);
    return { ...folder, count: tags.length, tags };
  }

  private folderTags(id: string): FolderTag[] {
    return this.db.prepare("SELECT tag_json FROM folder_tags WHERE folder_id = ? ORDER BY position, tag_id")
      .all(id).map((row) => {
        const tag = JSON.parse(String(row.tag_json)) as SavedTag & { pitchSemitones?: number };
        // Entries created before folder pitch support use the original key.
        return { ...tag, pitchSemitones: isPitchSemitones(tag.pitchSemitones) ? tag.pitchSemitones : 0 };
      });
  }

  sharedFolder(token: string): SharedFolder {
    const folder = this.folderFromLink(token);
    return { name: folder.name, ownerEmail: folder.ownerEmail, tags: this.folderTags(folder.id), access: folder.access };
  }

  canonicalShareToken(token: string): string {
    return this.folderFromLink(token).shareToken;
  }

  private folderFromLink(token: string): { id: string; name: string; ownerId: string; ownerEmail: string; access: FolderAccess; shareToken: string } {
    const folder = this.db.prepare(`SELECT f.id, f.name, f.user_id AS ownerId, u.email AS ownerEmail,
      s.access, f.share_token AS shareToken
      FROM folders f JOIN folder_settings s ON s.folder_id = f.id JOIN users u ON u.id = f.user_id
      WHERE f.share_token = ? OR f.id = (SELECT folder_id FROM folder_share_aliases WHERE token = ?)`).get(token, token);
    if (!folder) throw new AccountError("Shared folder not found.", 404);
    return folder as { id: string; name: string; ownerId: string; ownerEmail: string; access: FolderAccess; shareToken: string };
  }

  addSharedFolder(userId: string, token: string): SavedFolder {
    return this.transaction(() => {
      const folder = this.folderFromLink(token);
      if (folder.ownerId === userId) return this.getFolder(userId, folder.id);
      const member = this.db.prepare("SELECT 1 FROM folder_saves WHERE folder_id = ? AND user_id = ?").get(folder.id, userId);
      if (!member && this.listFolders(userId).length >= 200) throw new AccountError("You can have up to 200 folders.");
      this.db.prepare("INSERT OR IGNORE INTO folder_saves (folder_id, user_id) VALUES (?, ?)").run(folder.id, userId);
      return this.getFolder(userId, folder.id);
    });
  }

  leaveFolder(userId: string, id: string) {
    if (this.getFolder(userId, id).access === "owner") throw new AccountError("Owners must delete the folder instead.");
    this.db.prepare("DELETE FROM folder_saves WHERE folder_id = ? AND user_id = ?").run(id, userId);
  }

  requireFolderEditor(userId: string, id: string): SavedFolder {
    const folder = this.getFolder(userId, id);
    if (folder.access === "view") throw new AccountError("This folder is read-only.", 403);
    return folder;
  }

  private requireFolderOwner(userId: string, id: string) {
    const folder = this.getFolder(userId, id);
    if (folder.access !== "owner") throw new AccountError("Only the owner can rename, manage sharing, or delete this folder.", 403);
    return folder;
  }

  folderSharing(userId: string, id: string): FolderSharing {
    return { access: this.requireFolderOwner(userId, id).shareAccess };
  }

  setFolderSharing(userId: string, id: string, access: FolderAccess): FolderSharing {
    return this.transaction(() => {
      this.requireFolderOwner(userId, id);
      this.db.prepare("UPDATE folder_settings SET access = ? WHERE folder_id = ?").run(access, id);
      return { access };
    });
  }

  renameFolder(userId: string, id: string, name: string): SavedFolder {
    return this.transaction(() => {
      this.requireFolderOwner(userId, id);
      this.db.prepare("UPDATE folders SET name = ?, revision = revision + 1 WHERE id = ?").run(name, id);
      return this.getFolder(userId, id);
    });
  }

  deleteFolder(userId: string, id: string) {
    this.requireFolderOwner(userId, id);
    const result = this.db.prepare("DELETE FROM folders WHERE id = ? AND user_id = ?").run(id, userId);
    if (!result.changes) throw new AccountError("Folder not found.", 404);
  }

  addFolderTag(userId: string, id: string, tag: SavedTag, pitchSemitones = 0): SavedFolder {
    if (!isPitchSemitones(pitchSemitones)) throw new AccountError("Pitch must be a whole number from −6 to +6.");
    return this.transaction(() => {
      const folder = this.requireFolderEditor(userId, id);
      if (folder.tags.some((item) => item.id === tag.id)) return folder;
      if (folder.count >= 500) throw new AccountError("A folder can contain up to 500 tags.");
      this.db.prepare(`INSERT INTO folder_tags VALUES (?, ?, ?,
        (SELECT coalesce(max(position), -1) + 1 FROM folder_tags WHERE folder_id = ?))`)
        .run(id, tag.id, JSON.stringify({ ...tag, pitchSemitones }), id);
      this.db.prepare("UPDATE folders SET revision = revision + 1 WHERE id = ?").run(id);
      return this.getFolder(userId, id);
    });
  }

  setFolderTagPitch(userId: string, id: string, tagId: number, pitchSemitones: number, revision: number): SavedFolder {
    if (!isPitchSemitones(pitchSemitones)) throw new AccountError("Pitch must be a whole number from −6 to +6.");
    return this.transaction(() => {
      const folder = this.requireFolderEditor(userId, id);
      if (folder.revision !== revision) throw new AccountError("This folder changed in another window. Reload it before editing.", 409);
      const tag = folder.tags.find((item) => item.id === tagId);
      if (!tag) throw new AccountError("Tag not found in this folder.", 404);
      this.db.prepare("UPDATE folder_tags SET tag_json = ? WHERE folder_id = ? AND tag_id = ?")
        .run(JSON.stringify({ ...tag, pitchSemitones }), id, tagId);
      this.db.prepare("UPDATE folders SET revision = revision + 1 WHERE id = ?").run(id);
      return this.getFolder(userId, id);
    });
  }

  removeFolderTag(userId: string, id: string, tagId: number): SavedFolder {
    return this.transaction(() => {
      this.requireFolderEditor(userId, id);
      this.db.prepare("DELETE FROM folder_tags WHERE folder_id = ? AND tag_id = ?").run(id, tagId);
      this.db.prepare("UPDATE folders SET revision = revision + 1 WHERE id = ?").run(id);
      return this.getFolder(userId, id);
    });
  }

  reorderFolder(userId: string, id: string, tagIds: number[], revision: number): SavedFolder {
    return this.transaction(() => {
      const folder = this.requireFolderEditor(userId, id);
      if (folder.revision !== revision) throw new AccountError("This folder changed in another window. Reload it before reordering.", 409);
      const expected = new Set(folder.tags.map((tag) => tag.id));
      if (tagIds.length !== expected.size || new Set(tagIds).size !== expected.size || tagIds.some((tagId) => !expected.has(tagId))) {
        throw new AccountError("The order must include every tag exactly once.");
      }
      const update = this.db.prepare("UPDATE folder_tags SET position = ? WHERE folder_id = ? AND tag_id = ?");
      tagIds.forEach((tagId, index) => update.run(index, id, tagId));
      this.db.prepare("UPDATE folders SET revision = revision + 1 WHERE id = ?").run(id);
      return this.getFolder(userId, id);
    });
  }

  getMarks(userId: string, tagId: number): CueMark[] {
    return this.db.prepare("SELECT id, time, label FROM marks WHERE user_id = ? AND tag_id = ? ORDER BY time, id")
      .all(userId, tagId) as CueMark[];
  }

  addMarks(userId: string, tagId: number, marks: CueMark[]): CueMark[] {
    return this.transaction(() => {
      const existing = this.getMarks(userId, tagId);
      if (new Set([...existing, ...marks].map((mark) => mark.id)).size > 200) throw new AccountError("You can save up to 200 marks per tag.");
      const insert = this.db.prepare("INSERT OR IGNORE INTO marks VALUES (?, ?, ?, ?, ?)");
      for (const mark of marks) insert.run(userId, tagId, mark.id, mark.time, mark.label);
      return this.getMarks(userId, tagId);
    });
  }

  removeMark(userId: string, tagId: number, id: string): CueMark[] {
    this.db.prepare("DELETE FROM marks WHERE user_id = ? AND tag_id = ? AND id = ?").run(userId, tagId, id);
    return this.getMarks(userId, tagId);
  }

  recordVisit(userId: string, tag: SavedTag, now = new Date().toISOString()) {
    this.db.prepare(`INSERT INTO history VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, tag_id) DO UPDATE SET tag_json = excluded.tag_json, viewed_at = excluded.viewed_at`)
      .run(userId, tag.id, JSON.stringify(tag), now);
  }

  listHistory(userId: string, offset = 0): { items: HistoryItem[]; hasMore: boolean } {
    const rows = this.db.prepare("SELECT tag_json, viewed_at FROM history WHERE user_id = ? ORDER BY viewed_at DESC, tag_id LIMIT 51 OFFSET ?")
      .all(userId, offset);
    return {
      items: rows.slice(0, 50).map((row) => ({ ...JSON.parse(String(row.tag_json)) as SavedTag, viewedAt: String(row.viewed_at) })),
      hasMore: rows.length > 50,
    };
  }

  clearHistory(userId: string) {
    this.db.prepare("DELETE FROM history WHERE user_id = ?").run(userId);
  }
}

const globalStore = globalThis as typeof globalThis & { tagmixAccountStore?: AccountStore };

export function accountStore(): AccountStore {
  if (!globalStore.tagmixAccountStore) {
    const directory = path.resolve(/*turbopackIgnore: true*/ process.env.TAGMIX_ACCOUNT_DIR ?? path.join(process.cwd(), ".accounts"));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    globalStore.tagmixAccountStore = new AccountStore(path.join(directory, "accounts.sqlite"));
  }
  return globalStore.tagmixAccountStore;
}
