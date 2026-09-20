import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountStore } from "@/lib/account-store";
import { GET, POST, PUT, PATCH, DELETE } from "@/app/api/account/[...path]/route";
import { GET as sharedGET } from "@/app/api/shared/[token]/route";

let store: AccountStore;
let token: string | undefined;
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => token ? { value: token } : undefined }) }));
vi.mock("@/lib/account-store", async (original) => ({ ...await original<typeof import("@/lib/account-store")>(), accountStore: () => store }));
vi.mock("@/lib/catalog", () => ({ getTag: async (id: number) => id === 999 ? null : ({ id, title: `Tag ${id}`, version: "", key: "C" }) }));

beforeEach(() => { store = new AccountStore(":memory:"); token = undefined; });
afterEach(() => store.db.close());

function call(path: string, method = "GET", body?: unknown, userId?: string, origin = "http://localhost:3000") {
  const request = new Request(`http://localhost:3000/api/account/${path}`, {
    method, headers: { Origin: origin, "Content-Type": "application/json", ...(userId ? { "X-Tagmix-Account": userId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const handler = { GET, POST, PUT, PATCH, DELETE }[method as "GET"];
  return handler(request, { params: Promise.resolve({ path: path.split("?")[0].split("/") }) });
}

describe("account API access", () => {
  it("saves and edits a folder entry's pitch with validation and ownership checks", async () => {
    const owner = store.createUser("owner@example.com", "hash");
    const other = store.createUser("other@example.com", "hash");
    const folder = store.createFolder(owner.id, "Rehearsal");
    token = store.createSession(owner.id);
    const path = `folders/${folder.id}/tags`;
    let result = await call(path, "POST", { tagId: 37, pitchSemitones: 3 }, owner.id);
    expect(result.status).toBe(200);
    const saved = (await result.json()).folder;
    expect(saved.tags[0].pitchSemitones).toBe(3);
    for (const pitchSemitones of [-7, 7, 1.5, "2", null]) {
      expect((await call(path, "POST", { tagId: 1482, pitchSemitones }, owner.id)).status).toBe(400);
      expect((await call(`${path}/37`, "PATCH", { pitchSemitones, revision: saved.revision }, owner.id)).status).toBe(400);
    }
    result = await call(`${path}/37`, "PATCH", { pitchSemitones: -2, revision: saved.revision }, owner.id);
    expect(result.status).toBe(200);
    expect((await result.json()).folder.tags[0].pitchSemitones).toBe(-2);
    expect((await call(`${path}/37`, "PATCH", { pitchSemitones: 0, revision: saved.revision }, owner.id)).status).toBe(409);
    token = store.createSession(other.id);
    expect((await call(`${path}/37`, "PATCH", { pitchSemitones: 0, revision: saved.revision }, other.id)).status).toBe(404);
    token = undefined;
    expect((await call(`${path}/37`, "PATCH", { pitchSemitones: 0, revision: saved.revision })).status).toBe(401);
  });
  it("requires sign-in, matching account, and same origin to import a shared folder", async () => {
    const owner = store.createUser("owner@example.com", "hash");
    const other = store.createUser("other@example.com", "hash");
    const source = store.createFolder(owner.id, "Shared");
    store.addFolderTag(owner.id, source.id, { id: 37, title: "Tag", version: "", key: "C" });
    const body = { token: source.shareToken };
    expect((await call("folders/import", "POST", body)).status).toBe(401);
    token = store.createSession(other.id);
    expect((await call("folders/import", "POST", body, owner.id)).status).toBe(409);
    expect((await call("folders/import", "POST", body, other.id, "https://evil.example")).status).toBe(403);
    expect((await call("folders/import", "POST", { token: source.id }, other.id)).status).toBe(400);
    expect((await call("folders/import", "POST", { token: "0".repeat(48) }, other.id)).status).toBe(404);
    expect(store.listFolders(other.id)).toHaveLength(0);
    const response = await call("folders/import", "POST", body, other.id);
    expect(response.status).toBe(201);
    const { folder } = await response.json();
    expect(folder.tags.map((tag: { id: number }) => tag.id)).toEqual([37]);
    expect(store.getFolder(other.id, folder.id).name).toBe("Shared");
    expect(folder.shareToken).not.toBe(source.shareToken);
  });
  it("returns only the current account's folder memberships and updates after removal", async () => {
    const owner = store.createUser("owner@example.com", "hash");
    const other = store.createUser("other@example.com", "hash");
    const first = store.createFolder(owner.id, "First");
    const second = store.createFolder(owner.id, "Second");
    const privateFolder = store.createFolder(other.id, "Someone else's folder");
    const tag = { id: 37, title: "Tag", key: "C", version: "" };
    for (const [user, folder] of [[owner, first], [owner, second], [other, privateFolder]] as const) store.addFolderTag(user.id, folder.id, tag);
    token = store.createSession(owner.id);
    let response = await call("folders?tagId=37", "GET", undefined, owner.id);
    expect(response.status).toBe(200);
    expect((await response.json()).savedFolderIds).toEqual([second.id, first.id]);
    await call(`folders/${first.id}/tags/37`, "DELETE", undefined, owner.id);
    response = await call("folders?tagId=37", "GET", undefined, owner.id);
    expect((await response.json()).savedFolderIds).toEqual([second.id]);
    expect((await call("folders?tagId=invalid", "GET", undefined, owner.id)).status).toBe(400);
    token = undefined;
    expect((await call("folders?tagId=37")).status).toBe(401);
  });
  it("signs up, signs out, and signs in with normalized email and a private session", async () => {
    expect((await call("folders")).status).toBe(401);
    expect((await call("signup", "POST", { email: "Singer@Example.com", password: "a long test password" }, undefined, "https://evil.example")).status).toBe(403);
    const signup = await call("signup", "POST", { email: " Singer@Example.com ", password: "a long test password" });
    expect(signup.status).toBe(200);
    expect(signup.headers.get("cache-control")).toContain("no-store");
    expect(signup.headers.get("set-cookie")).toContain("HttpOnly");
    expect(signup.headers.get("set-cookie")).toContain("SameSite=lax");
    token = signup.cookies.get("tagmix_session")?.value;
    const { user } = await signup.json();
    expect(user.email).toBe("singer@example.com");
    expect(await (await call("session")).json()).toEqual({ user });
    expect((await call("logout", "POST", undefined, user.id)).status).toBe(200);
    expect((await call("folders", "GET", undefined, user.id)).status).toBe(401);
    expect((await call("login", "POST", { email: user.email, password: "wrong long password" })).status).toBe(401);
    expect((await call("login", "POST", { email: "missing@example.com", password: "wrong long password" })).status).toBe(401);
    expect((await call("login", "POST", { email: "SINGER@example.com", password: "a long test password" })).status).toBe(200);
  });

  it("checks ownership and stale-account headers, while anonymous sharing stays read-only", async () => {
    const owner = store.createUser("owner@example.com", "hash");
    const other = store.createUser("other@example.com", "hash");
    token = store.createSession(owner.id);
    expect((await call("folders", "POST", { name: "Folder" }, other.id)).status).toBe(409);
    const { folder } = await (await call("folders", "POST", { name: "Folder" }, owner.id)).json();
    const folderPath = `folders/${folder.id}`;
    expect((await call(`${folderPath}/tags`, "POST", { tagId: 999 }, owner.id)).status).toBe(404);
    expect((await call(`${folderPath}/tags`, "POST", { tagId: 37 }, owner.id)).status).toBe(200);
    const { folder: latest } = await (await call(`${folderPath}/tags`, "POST", { tagId: 1482 }, owner.id)).json();
    expect((await call(`${folderPath}/order`, "PUT", { tagIds: [1482, 37], revision: latest.revision }, owner.id)).status).toBe(200);
    expect((await call("marks/37", "POST", { marks: [{ id: "mine", time: 1, label: "Private cue" }] }, owner.id)).status).toBe(200);
    expect((await call("history", "POST", { tagId: 37 }, owner.id)).status).toBe(200);

    token = store.createSession(other.id);
    expect((await call(folderPath, "GET", undefined, other.id)).status).toBe(404);
    expect((await call(folderPath, "DELETE", undefined, other.id)).status).toBe(404);
    expect(await (await call("marks/37", "GET", undefined, other.id)).json()).toEqual({ marks: [] });
    expect(await (await call("history", "GET", undefined, other.id)).json()).toEqual({ items: [], hasMore: false });
    token = undefined;
    const response = await sharedGET(new Request("http://localhost:3000"), { params: Promise.resolve({ token: folder.shareToken }) });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({ folder: { access: "view", ownerEmail: owner.email, name: "Folder", tags: [{ id: 1482, title: "Tag 1482", version: "", key: "C", pitchSemitones: 0 }, { id: 37, title: "Tag 37", version: "", key: "C", pitchSemitones: 0 }] } });
    expect(payload.folder.ownerEmail).toBe(owner.email);
    expect((await call(folderPath, "DELETE")).status).toBe(401);
  });

  it("validates mark payloads before any account write", async () => {
    const user = store.createUser("marks@example.com", "hash");
    token = store.createSession(user.id);
    for (const mark of [{ id: "id", time: -1, label: "Bad" }, { id: "../path", time: 0, label: "Bad" }, { id: "id", time: "3", label: "Bad" }, { id: "id", time: 3, label: "" }]) {
      expect((await call("marks/37", "POST", { marks: [mark] }, user.id)).status).toBe(400);
    }
    expect(store.getMarks(user.id, 37)).toEqual([]);
  });
});

it("enforces viewer/editor/owner roles at the HTTP boundary", async () => {
  const owner = store.createUser("owner@example.com", "hash");
  const member = store.createUser("member@example.com", "hash");
  const folder = store.createFolder(owner.id, "Shared");
  const root = `folders/${folder.id}`;
  expect((await call("folders/add-shared", "POST", { token: folder.shareToken })).status).toBe(401);
  token = store.createSession(member.id);
  expect((await call("folders/add-shared", "POST", { token: folder.shareToken }, owner.id)).status).toBe(409);
  expect((await call("folders/add-shared", "POST", { token: folder.shareToken }, member.id, "https://evil.example")).status).toBe(403);
  expect((await call("folders/add-shared", "POST", { token: folder.shareToken }, member.id)).status).toBe(201);
  for (const [suffix, method, body] of [
    ["", "PATCH", { name: "Changed" }], ["", "DELETE", undefined],
    ["/tags", "POST", { tagId: 37 }], ["/tags/37", "DELETE", undefined],
    ["/tags/37", "PATCH", { pitchSemitones: 2, revision: 0 }],
    ["/order", "PUT", { tagIds: [], revision: 0 }],
    ["/sharing", "GET", undefined], ["/sharing", "PATCH", { access: "edit" }],
  ] as const) expect((await call(root + suffix, method, body, member.id)).status).toBe(403);
  token = store.createSession(owner.id);
  const response = await call(`${root}/sharing`, "PATCH", { access: "edit" }, owner.id);
  expect(response.status).toBe(200);
  expect((await response.json()).sharing).toEqual({ access: "edit" });
  const editToken = folder.shareToken;
  expect((await call(`${root}/members/${member.id}`, "PATCH", { access: "revoked" }, owner.id)).status).toBe(404);
  expect(store.getFolder(member.id, folder.id).access).toBe("edit");
  token = store.createSession(member.id);
  expect((await call("folders/add-shared", "POST", { token: editToken }, member.id)).status).toBe(201);
  expect((await call(`${root}/tags`, "POST", { tagId: 37, pitchSemitones: 3 }, member.id)).status).toBe(200);
  expect((await call(root, "PATCH", { name: "Edited" }, member.id)).status).toBe(403);
  expect((await call(root, "DELETE", undefined, member.id)).status).toBe(403);
  expect((await call(`${root}/sharing`, "GET", undefined, member.id)).status).toBe(403);
  const payload = await (await call(root, "GET", undefined, member.id)).json();
  expect(payload.folder).toMatchObject({ access: "edit", shareToken: "", name: "Shared" });
  expect(JSON.stringify(payload)).not.toContain(editToken);
  expect(payload.folder.ownerEmail).toBe(owner.email);
  expect((await call(`${root}/membership`, "DELETE", undefined, member.id)).status).toBe(200);
  expect((await call(root, "GET", undefined, member.id)).status).toBe(404);
  expect(store.getFolder(owner.id, folder.id).tags[0].pitchSemitones).toBe(3);
});

it("changes all saved users' access without changing the URL or removing saved folders", async () => {
  const owner = store.createUser("owner@example.com", "hash");
  const member = store.createUser("member@example.com", "hash");
  const folder = store.createFolder(owner.id, "Shared");
  const root = `folders/${folder.id}`;
  store.addFolderTag(owner.id, folder.id, { id: 37, title: "Tag", version: "", key: "C" });
  store.addSharedFolder(member.id, folder.shareToken);
  for (const access of ["edit", "view", "edit"] as const) {
    token = store.createSession(owner.id);
    expect((await call(`${root}/sharing`, "PATCH", { access }, owner.id)).status).toBe(200);
    expect(store.getFolder(owner.id, folder.id).shareToken).toBe(folder.shareToken);
    token = store.createSession(member.id);
    expect((await (await call(root, "GET", undefined, member.id)).json()).folder.access).toBe(access);
    expect((await call(`${root}/tags`, "POST", { tagId: 1482 }, member.id)).status).toBe(access === "edit" ? 200 : 403);
    expect((await (await call("folders?tagId=37", "GET", undefined, member.id)).json()).savedFolderIds).toEqual([folder.id]);
    token = undefined;
    const shared = await sharedGET(new Request("http://localhost:3000"), { params: Promise.resolve({ token: folder.shareToken }) });
    expect((await shared.json()).folder).toMatchObject({ access, ownerEmail: owner.email });
  }
  token = store.createSession(owner.id);
  for (const body of [{ access: "invalid" }, { access: "view", action: "replace" }, { access: "edit", action: "disable" }]) {
    expect((await call(`${root}/sharing`, "PATCH", body, owner.id)).status).toBe(400);
  }
  expect(store.getFolder(owner.id, folder.id).shareToken).toBe(folder.shareToken);
  expect(store.getFolder(member.id, folder.id).access).toBe("edit");
});
