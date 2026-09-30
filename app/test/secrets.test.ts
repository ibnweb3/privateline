import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

process.env.APP_SECRET = randomBytes(32).toString("hex");
const secrets = await import("../src/secrets.ts");

test("phone numbers are encrypted, not just encoded", () => {
  const sealed = secrets.encryptPhone("+2348031234567");
  assert.doesNotMatch(sealed, /2348031234567/);
  assert.notEqual(sealed, secrets.encryptPhone("+2348031234567"), "a fresh IV each time");
  assert.equal(secrets.decryptPhone(sealed), "+2348031234567");
});

test("the ledger tag and the lookup key are stable, distinct, and not a plain hash", () => {
  const tag = secrets.phoneTag("+2348031234567");
  assert.equal(tag, secrets.phoneTag("+2348031234567"));
  assert.notEqual(tag, secrets.phoneTag("+2348031234568"));
  assert.notEqual(tag.slice(3), secrets.phoneLookup("+2348031234567").slice(0, 32));
});

test("PINs", () => {
  const stored = secrets.hashPin("4821");
  assert.doesNotMatch(stored, /4821/);
  assert.equal(secrets.verifyPin("4821", stored), true);
  assert.equal(secrets.verifyPin("4822", stored), false);
});
