import { describe, expect, it } from "vitest";
import { normalizeEmail, validatePassword } from "@/lib/account-validation";
import { hashPassword, verifyPassword } from "@/lib/password";

describe("account credentials", () => {
  it("normalizes email consistently and rejects malformed input", () => {
    expect(normalizeEmail(" Singer+tags@Example.COM ")).toBe("singer+tags@example.com");
    for (const value of [null, {}, "", "singer", "singer@", "a@@example.com", "a b@example.com", `${"a".repeat(250)}@example.com`]) {
      expect(() => normalizeEmail(value)).toThrow("valid email");
    }
  });

  it("bounds passwords while preserving spaces and case", () => {
    expect(validatePassword(" A long Passphrase ")).toBe(" A long Passphrase ");
    for (const value of [null, {}, "short", "x".repeat(129)]) {
      expect(() => validatePassword(value)).toThrow("between 12 and 128");
    }
  });

  it("uses independent salts and verifies only the exact password", async () => {
    const password = "A long Passphrase ";
    const first = await hashPassword(password);
    const second = await hashPassword(password);
    expect(first).not.toBe(second);
    expect(first).not.toContain(password);
    expect(await verifyPassword(password, first)).toBe(true);
    expect(await verifyPassword(password.trim(), first)).toBe(false);
    expect(await verifyPassword(password.toLowerCase(), first)).toBe(false);
  });

  it("rejects malformed hashes without throwing", async () => {
    for (const hash of ["", "plaintext", "scrypt-v1$salt$key", `scrypt-v1$${"a".repeat(32)}$${"b".repeat(64)}$extra`]) {
      expect(await verifyPassword("A long Passphrase", hash)).toBe(false);
    }
  });
});
