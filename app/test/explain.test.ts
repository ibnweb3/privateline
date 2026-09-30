import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

process.env.APP_SECRET ??= randomBytes(32).toString("hex");
const { explainForUser } = await import("../src/app.ts");
const { assetBySymbol } = await import("../src/prices.ts");

const gold = assetBySymbol("eXAU");

test("each refusal reason becomes the right SMS explanation", () => {
  assert.match(explainForUser("not enough operators approved it in time", gold), /operators approved it in time/);
  assert.match(explainForUser("eXAU ask $4,200.00 is 2.10% above the market price $4,113.00 (limit 1.50%)", gold), /Gold costs 2\.10% more on Canton/);
  assert.match(explainForUser("eXAU bid $4,100.00 is 1.69% below the market price $4,170.00 (limit 1.50%)", gold), /1\.69% less on Canton/);
  assert.match(explainForUser("it would take today's trading to $210.00, over the $200.00 daily limit", gold), /daily limit/);
  assert.match(explainForUser("the account doesn't hold enough dollars", gold), /don't have enough/);
  assert.match(explainForUser("quote expired at 2026-09-29T11:00:00Z", gold), /quote expired/);
  assert.match(explainForUser("the account changed after this trade was proposed", gold), /account changed/);
});
