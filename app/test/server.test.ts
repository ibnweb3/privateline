import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { test } from "node:test";

process.env.APP_SECRET ??= randomBytes(32).toString("hex");
const { clientAddress } = await import("../src/server.ts");

const request = (headers: Record<string, string>) =>
  ({ headers, socket: { remoteAddress: "10.0.0.9" } }) as unknown as IncomingMessage;

test("the front door's visitor address counts only with the right key", () => {
  process.env.FRONT_DOOR_KEY = "front-door-test-key";
  process.env.TRUST_PROXY = "1";
  const visitor = { "x-front-door-client": "102.89.1.2", "x-forwarded-for": "172.64.0.1" };
  assert.equal(clientAddress(request({ ...visitor, "x-front-door-key": "front-door-test-key" })), "102.89.1.2");
  // Anyone can send the header straight to the server; without the key it's ignored.
  assert.equal(clientAddress(request({ ...visitor, "x-front-door-key": "guess" })), "172.64.0.1");
  assert.equal(clientAddress(request(visitor)), "172.64.0.1");
  delete process.env.FRONT_DOOR_KEY;
  assert.equal(clientAddress(request({ ...visitor, "x-front-door-key": "" })), "172.64.0.1");
});

test("without a proxy the socket address is used", () => {
  delete process.env.TRUST_PROXY;
  assert.equal(clientAddress(request({ "x-forwarded-for": "1.2.3.4" })), "10.0.0.9");
});
