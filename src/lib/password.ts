import "server-only";

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const FORMAT = "scrypt-v1";
const KEY_BYTES = 32;

function deriveKey(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = await deriveKey(password, salt);
  return `${FORMAT}$${salt}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [format, salt, expected, extra] = storedHash.split("$");
  if (format !== FORMAT || extra !== undefined || !/^[a-f0-9]{32}$/.test(salt ?? "")
    || !/^[a-f0-9]{64}$/.test(expected ?? "")) return false;
  const actual = await deriveKey(password, salt);
  return timingSafeEqual(actual, Buffer.from(expected, "hex"));
}
