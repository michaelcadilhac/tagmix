import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountError } from "@/lib/account-errors";
import { accountErrorResponse, accountOrigin, checkMutationOrigin, folderName, positiveId, readAccountBody } from "@/lib/account-http";

beforeEach(() => vi.stubEnv("TAGMIX_APP_ORIGIN", ""));
afterEach(() => vi.unstubAllEnvs());

describe("account request validation", () => {
  it("rejects cross-origin or missing-origin mutations", () => {
    const invalidHeaders: Record<string, string>[] = [{}, { origin: "https://other.example" }, { origin: "https://tags.example", "sec-fetch-site": "cross-site" }];
    for (const headers of invalidHeaders) {
      expect(() => checkMutationOrigin(new Request("https://tags.example/api/account/folders", { headers }))).toThrow("from TagMix");
    }
    expect(() => checkMutationOrigin(new Request("https://tags.example/api/account/folders", { headers: { origin: "https://tags.example" } }))).not.toThrow();
  });

  it("checks the browser-facing Host instead of the standalone listen address", () => {
    for (const host of ["localhost:3000", "127.0.0.1:3000", "192.168.1.10:3000", "[::1]:3000"]) {
      const request = new Request("http://0.0.0.0:3000/api/account/signup", {
        headers: { host, origin: `http://${host}`, "sec-fetch-site": "same-origin" },
      });
      expect(accountOrigin(request)).toBe(`http://${host}`);
      expect(() => checkMutationOrigin(request)).not.toThrow();
    }
  });

  it("still rejects different hosts, ports, schemes, and forged forwarded hosts", () => {
    for (const origin of ["http://0.0.0.0:3000", "http://localhost:3001", "https://localhost:3000", "http://evil.example"]) {
      const request = new Request("http://0.0.0.0:3000/api/account/signup", {
        headers: { host: "localhost:3000", origin, "x-forwarded-host": new URL(origin).host },
      });
      expect(() => checkMutationOrigin(request)).toThrow("from TagMix");
    }
    for (const host of ["", "localhost:3000@evil.example", "localhost:3000/path", "localhost:3000,evil.example", "localhost:bad", "localhost:3000#fragment"]) {
      expect(() => accountOrigin(new Request("http://0.0.0.0:3000", { headers: { host } }))).toThrow("Invalid request host");
    }
  });

  it("keeps an explicitly configured public origin authoritative behind a proxy", () => {
    vi.stubEnv("TAGMIX_APP_ORIGIN", "https://tags.example/");
    const request = (origin: string) => new Request("http://0.0.0.0:3000/api/account/signup", {
      headers: { host: "internal:3000", origin, "x-forwarded-host": "untrusted.example" },
    });
    expect(accountOrigin(request("https://tags.example"))).toBe("https://tags.example");
    expect(() => checkMutationOrigin(request("https://tags.example"))).not.toThrow();
    expect(() => checkMutationOrigin(request("http://internal:3000"))).toThrow("from TagMix");
    expect(() => checkMutationOrigin(request("https://untrusted.example"))).toThrow("from TagMix");
  });

  it("requires bounded JSON objects", async () => {
    const request = (body: string, contentType = "application/json") => new Request("https://tags.example", { method: "POST", headers: { "Content-Type": contentType }, body });
    await expect(readAccountBody(request('{"name":"Quartet"}'))).resolves.toEqual({ name: "Quartet" });
    await expect(readAccountBody(request("[]"))).rejects.toThrow("Invalid JSON");
    await expect(readAccountBody(request("null"))).rejects.toThrow("Invalid JSON");
    await expect(readAccountBody(request("{}", "text/plain"))).rejects.toThrow("Expected a JSON");
    await expect(readAccountBody(request(JSON.stringify({ name: "a".repeat(65536) })))).rejects.toThrow("too large");
  });

  it("validates folder names and tag identifiers", () => {
    expect(folderName(" Quartet ")).toBe("Quartet");
    expect(positiveId("37")).toBe(37);
    for (const value of [0, -1, "1e3", "1.2", null, {}, "9007199254740992"]) expect(() => positiveId(value)).toThrow("Invalid tag");
    for (const value of [null, " ", "a".repeat(101)]) expect(() => folderName(value)).toThrow("folder name");
  });
});


it("recognizes account errors across separately loaded server bundles", async () => {
  vi.resetModules();
  const { AccountError: SeparateAccountError } = await import("@/lib/account-errors");
  const error = new SeparateAccountError("Folder not found.", 404);
  expect(error).not.toBeInstanceOf(AccountError);
  const response = accountErrorResponse(error);
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "Folder not found." });
});

it("does not expose unbranded errors with a matching name", async () => {
  const logging = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = accountErrorResponse({ name: "AccountError", message: "internal details", status: 404 });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Could not complete that request. Please try again." });
  } finally { logging.mockRestore(); }
});
