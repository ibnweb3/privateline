// Keys for personal data that never goes on the ledger. From one app secret we derive:
//   - an encryption key: phone numbers are stored AES-256-GCM encrypted;
//   - a lookup key: an HMAC of the number finds the user when a text arrives;
//   - a tag key: a different HMAC of the number is the account's `phoneTag` on the ledger, so the
//     operators can tell that a phone changed but cannot learn or guess the number (unlike a plain
//     hash, which anyone could brute-force over all Nigerian numbers);
//   - a code key: verification codes are stored as HMACs.
// PINs are hashed with scrypt and a per-user salt.

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

function loadSecret(): Buffer {
  if (process.env.APP_SECRET) return Buffer.from(process.env.APP_SECRET, "hex");
  // Local development: generate one secret and keep it next to the database (gitignored).
  const file = fileURLToPath(new URL("../data/app-secret", import.meta.url));
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  return Buffer.from(readFileSync(file, "utf8").trim(), "hex");
}

const secret = loadSecret();
if (secret.length < 32) throw new Error("APP_SECRET must be at least 32 bytes of hex");
const derive = (info: string) => Buffer.from(hkdfSync("sha256", secret, "privateline", info, 32));
const encryptionKey = derive("phone-encryption");
const lookupKey = derive("phone-lookup");
const tagKey = derive("phone-tag");
const codeKey = derive("verification-codes");

export function encryptPhone(e164: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const data = Buffer.concat([cipher.update(e164, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url")).join(".");
}

export function decryptPhone(sealed: string): string {
  const [iv, tag, data] = sealed.split(".").map((part) => Buffer.from(part, "base64url"));
  if (!iv || !tag || !data) throw new Error("malformed encrypted phone");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function phoneLookup(e164: string): string {
  return createHmac("sha256", lookupKey).update(e164).digest("hex");
}

/** The account's phone tag on the ledger. */
export function phoneTag(e164: string): string {
  return `pt-${createHmac("sha256", tagKey).update(e164).digest("hex").slice(0, 32)}`;
}

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, 32);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = scryptSync(pin, Buffer.from(salt, "base64url"), expected.length);
  return timingSafeEqual(actual, expected);
}

/** A 6-digit verification code. */
export function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function hashCode(purpose: string, code: string): string {
  return createHmac("sha256", codeKey).update(`${purpose}:${code}`).digest("hex");
}

export function hashToken(token: string): string {
  return createHmac("sha256", codeKey).update(`token:${token}`).digest("hex");
}

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}
