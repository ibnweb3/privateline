import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

process.env.APP_SECRET ??= randomBytes(32).toString("hex");
const { PrivateLine } = await import("../src/app.ts");
const { Db } = await import("../src/db.ts");
const { realNumberPolicy, RoutingGateway, SimulatorGateway } = await import("../src/sms/gateway.ts");
const { normalizeE164 } = await import("../src/sms/phone.ts");

const OWNER = "+2348031234567";
const STRANGER = "+2348099999999";

/** A real gateway that only records what it was asked to send. */
function recorder() {
  const sent: { to: string; body: string }[] = [];
  return { sent, gateway: { name: "recorder", send: async (to: string, body: string) => void sent.push({ to, body }) } };
}

test("real numbers are closed by default, even with a real gateway", () => {
  const { gateway } = recorder();
  const routing = new RoutingGateway(new SimulatorGateway(), gateway);
  assert.equal(routing.canText("+9990000001"), true);
  assert.equal(routing.canText(OWNER), false);
});

test("only listed real numbers can be texted; open lifts the limit; no gateway means none", () => {
  const { gateway } = recorder();
  const listed = new RoutingGateway(new SimulatorGateway(), gateway, [OWNER]);
  assert.equal(listed.canText(OWNER), true);
  assert.equal(listed.canText(STRANGER), false);
  assert.equal(new RoutingGateway(new SimulatorGateway(), gateway, "open").canText(STRANGER), true);
  assert.equal(new RoutingGateway(new SimulatorGateway(), undefined, "open").canText(OWNER), false);
});

test("sending to an unlisted real number fails and reaches nobody", async () => {
  const { gateway, sent } = recorder();
  const routing = new RoutingGateway(new SimulatorGateway(), gateway, [OWNER]);
  await assert.rejects(routing.send(STRANGER, "code 123456"), /not approved/);
  await routing.send(OWNER, "hello");
  assert.deepEqual(sent, [{ to: OWNER, body: "hello" }]);
});

test("REAL_SMS_ALLOW is read as none, open, or a normalized list", () => {
  assert.deepEqual(realNumberPolicy(undefined, normalizeE164), []);
  assert.deepEqual(realNumberPolicy("  ", normalizeE164), []);
  assert.equal(realNumberPolicy("OPEN", normalizeE164), "open");
  assert.deepEqual(realNumberPolicy("0803 123 4567, +234 809 999 9999", normalizeE164), [OWNER, STRANGER]);
  assert.throws(() => realNumberPolicy("12", normalizeE164));
});

test("a text from an unapproved real number is ignored: no reply, so no SMS cost", async () => {
  const { gateway, sent } = recorder();
  const routing = new RoutingGateway(new SimulatorGateway(), gateway, [OWNER]);
  const app = new PrivateLine({ db: new Db(":memory:"), gateway: routing, publicUrl: "https://example.test", log: () => {} } as never);
  await app.receive({ from: STRANGER, body: "HELP", msgId: "m1" });
  assert.equal(sent.length, 0);
  // An approved number that has no account is told how to sign up.
  await app.receive({ from: OWNER, body: "HELP", msgId: "m2" });
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.body, /Sign up at https:\/\/example\.test\/signup/);
});

test("sign-up refuses a real number that is not approved, before any code is sent", async () => {
  const { gateway, sent } = recorder();
  const routing = new RoutingGateway(new SimulatorGateway(), gateway, [OWNER]);
  const db = new Db(":memory:");
  const app = new PrivateLine({ db, gateway: routing, publicUrl: "https://example.test", log: () => {} } as never);
  // A signup in progress, as /api/signup/email would leave it.
  db.putSignup((await import("../src/secrets.ts")).hashToken("tok"), "a@example.com", Date.now() + 60_000);
  await assert.rejects(app.signupPhone("tok", STRANGER), /approved numbers/);
  assert.equal(sent.length, 0);
  await app.signupPhone("tok", OWNER);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.body, /^PrivateLine code: \d{6}/);
});
