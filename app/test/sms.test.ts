import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { BadSignatureError, isSimulatorPhone, parseSmsGateWebhook } from "../src/sms/gateway.ts";
import { maskPhone, normalizeE164 } from "../src/sms/phone.ts";
import { price, quantity, usd } from "../src/sms/format.ts";

const SECRET = "webhook-secret";
const body = (payload: Record<string, unknown>) => JSON.stringify({ event: "sms:received", payload });
const hmac = (message: string, key = SECRET) => createHmac("sha256", key).update(message).digest("hex");
/** What the gateway app really sends (read off real webhooks on 2026-10-06): the body, then the timestamp. */
const sign = (raw: string, timestamp: string) => hmac(`${raw}${timestamp}`);

test("a signed sms-gate webhook parses, with either sender field", () => {
  const modern = body({ messageId: "m1", message: " BAL ", sender: "+2348031234567", simNumber: 2 });
  assert.deepEqual(parseSmsGateWebhook(modern, { signature: sign(modern, "1790000000"), timestamp: "1790000000" }, SECRET),
    { from: "+2348031234567", body: "BAL", msgId: "m1" });
  const legacy = body({ messageId: "m2", message: "HELP", phoneNumber: "+2348031234567" });
  assert.equal(parseSmsGateWebhook(legacy, { signature: sign(legacy, "1"), timestamp: "1" }, SECRET)?.msgId, "m2");
});

test("a bad signature is rejected", () => {
  const raw = body({ messageId: "m1", message: "BAL", sender: "+2348031234567" });
  assert.throws(() => parseSmsGateWebhook(raw, { signature: "00".repeat(32), timestamp: "1" }, SECRET), BadSignatureError);
  assert.throws(() => parseSmsGateWebhook(raw, { timestamp: "1" }, SECRET), BadSignatureError);
});

test("the signature must come from the right key and cover the exact body and timestamp", () => {
  const raw = body({ messageId: "m1", message: "BAL", sender: "+2348031234567" });
  const other = hmac(`${raw}1790000000`, "another-key");
  assert.throws(() => parseSmsGateWebhook(raw, { signature: other, timestamp: "1790000000" }, SECRET), BadSignatureError);
  const good = sign(raw, "1790000000");
  assert.throws(() => parseSmsGateWebhook(raw, { signature: good, timestamp: "1790000001" }, SECRET), BadSignatureError);
  assert.throws(() => parseSmsGateWebhook(raw.replace("BAL", "BUY"), { signature: good, timestamp: "1790000000" }, SECRET), BadSignatureError);
  assert.equal(parseSmsGateWebhook(raw, { signature: ` SHA256=${good.toUpperCase()} `, timestamp: "1790000000" }, SECRET)?.msgId, "m1");
});

test("the older timestamp-first order is still accepted", () => {
  const raw = body({ messageId: "m3", message: "HELP", sender: "+2348031234567" });
  assert.equal(parseSmsGateWebhook(raw, { signature: hmac(`1790000000${raw}`), timestamp: "1790000000" }, SECRET)?.msgId, "m3");
});

test("texts to the other SIM and other events are ignored", () => {
  const otherSim = body({ messageId: "m1", message: "BAL", sender: "+2348031234567", simNumber: 1 });
  assert.equal(parseSmsGateWebhook(otherSim, {}, undefined, 2), null);
  assert.equal(parseSmsGateWebhook(JSON.stringify({ event: "sms:sent", payload: {} }), {}, undefined), null);
});

test("phone numbers", () => {
  assert.equal(normalizeE164("0803 123 4567"), "+2348031234567");
  assert.equal(normalizeE164("+234 803-123-4567"), "+2348031234567");
  assert.equal(normalizeE164("+999 000 0001"), "+9990000001");
  assert.throws(() => normalizeE164("12"));
  assert.equal(maskPhone("+2348031234567"), "+234****4567");
  assert.equal(isSimulatorPhone("+9990000001"), true);
  assert.equal(isSimulatorPhone("+2348031234567"), false);
});

test("SMS number formatting", () => {
  assert.equal(usd(1234.5), "$1,234.50");
  assert.equal(price(4149.334), "$4,149.33");
  assert.equal(price(83831.84), "$83,832");
  assert.equal(quantity(0.004823), "0.00482");
  assert.equal(quantity(0.1259574415), "0.126");
  assert.equal(quantity(12.5), "12.5");
});
