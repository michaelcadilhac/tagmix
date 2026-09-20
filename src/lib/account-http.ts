import "server-only";

import { NextResponse } from "next/server";
import { AccountError, isAccountError } from "@/lib/account-errors";

export function accountResponse(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
}

export function accountErrorResponse(error: unknown): NextResponse {
  if (isAccountError(error)) return accountResponse({ error: error.message }, error.status);
  console.error("Account request failed", error);
  return accountResponse({ error: "Could not complete that request. Please try again." }, 500);
}

export function accountOrigin(request: Request): string {
  const configured = process.env.TAGMIX_APP_ORIGIN?.trim();
  if (configured) return new URL(configured).origin;

  const url = new URL(request.url);
  const host = request.headers.get("host");
  if (host === null) return url.origin;
  // Next's standalone request URL can contain the listen address (0.0.0.0),
  // while Host identifies the address used by the browser. Do not trust a
  // forwarded host: deployments that rewrite Host must configure the origin.
  if (!host || /[\\/\s@?#,]/.test(host)) throw new AccountError("Invalid request host.", 400);
  try {
    return new URL(`${url.protocol}//${host}`).origin;
  } catch {
    throw new AccountError("Invalid request host.", 400);
  }
}

export function checkMutationOrigin(request: Request): void {
  const expectedOrigin = accountOrigin(request);
  if (request.headers.get("origin") !== expectedOrigin || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new AccountError("Please make this request from TagMix.", 403);
  }
}

export async function readAccountBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    throw new AccountError("Expected a JSON request.", 415);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new AccountError("A request body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) {
        await reader.cancel();
        throw new AccountError("The request is too large.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch {
    throw new AccountError("Invalid JSON request.");
  }
}

export function positiveId(value: unknown): number {
  if ((typeof value !== "string" && typeof value !== "number") || !/^\d+$/.test(String(value))
    || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) throw new AccountError("Invalid tag ID.");
  return Number(value);
}

export function folderName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 100) {
    throw new AccountError("Use a folder name between 1 and 100 characters.");
  }
  return value.trim();
}
