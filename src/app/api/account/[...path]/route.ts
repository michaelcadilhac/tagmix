import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import { AccountError } from "@/lib/account-errors";
import { accountErrorResponse, accountOrigin, accountResponse, checkMutationOrigin, folderName, positiveId, readAccountBody } from "@/lib/account-http";
import { accountStore, SESSION_SECONDS } from "@/lib/account-store";
import type { CueMark, SavedTag } from "@/lib/account-types";
import { normalizeEmail, validatePassword } from "@/lib/account-validation";
import { getTag } from "@/lib/catalog";
import { hashPassword, verifyPassword } from "@/lib/password";
import { isPitchSemitones } from "@/lib/pitch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const COOKIE = "tagmix_session";
// An unknown account still performs the same password derivation as a known account.
const DUMMY_HASH = `scrypt-v1$${"0".repeat(32)}$${"0".repeat(64)}`;
type Context = { params: Promise<{ path: string[] }> };

async function savedTag(value: unknown): Promise<SavedTag> {
  const tag = await getTag(positiveId(value));
  if (!tag) throw new AccountError("Tag not found in the rehearsal catalog.", 404);
  return { id: tag.id, title: tag.title, version: tag.version, key: tag.key };
}

function parseMarks(value: unknown): CueMark[] {
  if (!Array.isArray(value) || value.length > 200) throw new AccountError("Invalid marks.");
  return value.map((mark: unknown) => {
    if (!mark || typeof mark !== "object") throw new AccountError("Invalid mark.");
    const { id, time, label } = mark as Record<string, unknown>;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)
      || typeof time !== "number" || !Number.isFinite(time) || time < 0 || time > 86400
      || typeof label !== "string" || !label.trim() || label.length > 100) throw new AccountError("Invalid mark.");
    return { id, time, label };
  });
}

async function handle(request: Request, context: Context): Promise<NextResponse> {
  try {
    const method = request.method;
    if (method !== "GET") checkMutationOrigin(request);
    const segments = (await context.params).path;
    const route = segments.join("/");
    const store = accountStore();
    const jar = await cookies();
    const token = jar.get(COOKIE)?.value;
    const user = store.sessionUser(token);
    if (method === "GET" && route === "session") return accountResponse({ user });
    if (method === "POST" && (route === "signup" || route === "login")) {
      const body = await readAccountBody(request);
      let email: string;
      let password: string;
      try {
        email = normalizeEmail(body.email);
        password = validatePassword(body.password);
      } catch (error) {
        throw new AccountError((error as Error).message);
      }
      store.consumeAuthAttempt("global-auth", 300);
      store.consumeAuthAttempt(`email:${email}`, 15);
      let signedInUser;
      if (route === "signup") {
        store.consumeAuthAttempt("global-signup", 50);
        signedInUser = store.createUser(email, await hashPassword(password));
      } else {
        const credentials = store.findCredentials(email);
        const matches = await verifyPassword(password, credentials?.passwordHash ?? DUMMY_HASH);
        if (!credentials || !matches) throw new AccountError("Incorrect email or password.", 401);
        signedInUser = { id: credentials.id, email: credentials.email };
      }
      store.deleteSession(token);
      const response = accountResponse({ user: signedInUser });
      const origin = accountOrigin(request);
      response.cookies.set(COOKIE, store.createSession(signedInUser.id), {
        httpOnly: true, sameSite: "lax", secure: new URL(origin).protocol === "https:", path: "/", maxAge: SESSION_SECONDS,
      });
      return response;
    }
    if (method === "POST" && route === "logout") {
      if (user && request.headers.get("x-tagmix-account") !== user.id) {
        throw new AccountError("Your signed-in account changed. Refresh this page.", 409);
      }
      store.deleteSession(token);
      const response = accountResponse({ user: null });
      response.cookies.set(COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
      return response;
    }
    if (!user) throw new AccountError("Sign in to use your saved tags and marks.", 401);
    // Reject stale tabs rather than writing one account's edits to another account.
    if (request.headers.get("x-tagmix-account") !== user.id) {
      throw new AccountError("Your signed-in account changed. Refresh this page.", 409);
    }

    if (route === "folders") {
      if (method === "GET") {
        const tagId = new URL(request.url).searchParams.get("tagId");
        return accountResponse({
          folders: store.listFolders(user.id),
          ...(tagId !== null ? { savedFolderIds: store.folderIdsForTag(user.id, positiveId(tagId)) } : {}),
        });
      }
      if (method === "POST") return accountResponse({ folder: store.createFolder(user.id, folderName((await readAccountBody(request)).name)) }, 201);
    }
    if ((route === "folders/import" || route === "folders/add-shared") && method === "POST") {
      const { token } = await readAccountBody(request);
      if (typeof token !== "string" || !/^[a-f0-9]{48}$/.test(token)) throw new AccountError("Invalid share link.");
      return accountResponse({ folder: route === "folders/import" ? store.importSharedFolder(user.id, token) : store.addSharedFolder(user.id, token) }, 201);
    }
    if (segments[0] === "folders" && segments[1]) {
      const id = segments[1];
      if (segments.length === 3 && segments[2] === "membership" && method === "DELETE") {
        store.leaveFolder(user.id, id);
        return accountResponse({ ok: true });
      }
      if (segments.length === 3 && segments[2] === "sharing") {
        if (method === "GET") return accountResponse({ sharing: store.folderSharing(user.id, id) });
        if (method === "PATCH") {
          const { access, action } = await readAccountBody(request);
          if ((access !== "view" && access !== "edit") || action !== undefined) throw new AccountError("Invalid sharing change.");
          return accountResponse({ sharing: store.setFolderSharing(user.id, id, access) });
        }
      }
      if (segments.length === 2) {
        if (method === "GET") return accountResponse({ folder: store.getFolder(user.id, id) });
        if (method === "PATCH") return accountResponse({ folder: store.renameFolder(user.id, id, folderName((await readAccountBody(request)).name)) });
        if (method === "DELETE") {
          store.deleteFolder(user.id, id);
          return accountResponse({ ok: true });
        }
      }
      if (segments.length === 3 && segments[2] === "tags" && method === "POST") {
        store.requireFolderEditor(user.id, id);
        const body = await readAccountBody(request);
        const pitch = body.pitchSemitones === undefined ? 0 : body.pitchSemitones;
        if (!isPitchSemitones(pitch)) throw new AccountError("Pitch must be a whole number from −6 to +6.");
        const tag = await savedTag(body.tagId);
        return accountResponse({ folder: store.addFolderTag(user.id, id, tag, pitch) });
      }
      if (segments.length === 4 && segments[2] === "tags" && method === "PATCH") {
        const body = await readAccountBody(request);
        if (!isPitchSemitones(body.pitchSemitones) || !Number.isSafeInteger(body.revision)) throw new AccountError("Invalid folder pitch setting.");
        return accountResponse({ folder: store.setFolderTagPitch(user.id, id, positiveId(segments[3]), body.pitchSemitones, Number(body.revision)) });
      }
      if (segments.length === 4 && segments[2] === "tags" && method === "DELETE") {
        return accountResponse({ folder: store.removeFolderTag(user.id, id, positiveId(segments[3])) });
      }
      if (segments.length === 3 && segments[2] === "order" && method === "PUT") {
        const body = await readAccountBody(request);
        if (!Array.isArray(body.tagIds) || body.tagIds.length > 500 || !Number.isSafeInteger(body.revision)) throw new AccountError("Invalid folder order.");
        return accountResponse({ folder: store.reorderFolder(user.id, id, body.tagIds.map(positiveId), Number(body.revision)) });
      }
    }
    if (segments[0] === "marks" && segments[1]) {
      const tagId = positiveId(segments[1]);
      if (segments.length === 2) {
        if (method === "GET") return accountResponse({ marks: store.getMarks(user.id, tagId) });
        if (method === "POST") return accountResponse({ marks: store.addMarks(user.id, tagId, parseMarks((await readAccountBody(request)).marks)) });
      }
      if (segments.length === 3 && method === "DELETE") return accountResponse({ marks: store.removeMark(user.id, tagId, segments[2]) });
    }
    if (route === "history") {
      if (method === "GET") {
        const raw = new URL(request.url).searchParams.get("offset") ?? "0";
        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new AccountError("Invalid history offset.");
        return accountResponse(store.listHistory(user.id, Number(raw)));
      }
      if (method === "POST") {
        store.recordVisit(user.id, await savedTag((await readAccountBody(request)).tagId));
        return accountResponse({ ok: true });
      }
      if (method === "DELETE") {
        store.clearHistory(user.id);
        return accountResponse({ ok: true });
      }
    }
    throw new AccountError("Account endpoint not found.", 404);
  } catch (error) {
    return accountErrorResponse(error);
  }
}

export { handle as GET, handle as POST, handle as PATCH, handle as PUT, handle as DELETE };
