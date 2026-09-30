import assert from "node:assert/strict";
import { test } from "node:test";

import { checkPrice, checkTrade, policyFromEnv, type TradeFacts } from "../src/checks.ts";

const policy = { ...policyFromEnv(), priceTolerance: 0.015, maxTradeDollars: 500 };

test("the Sep 26 drift is refused for buyers", () => {
  // Cantex cETH ask with the desk spread, against ETH at 06:38 UTC.
  const verdict = checkPrice("cETH", "Buy", 2757.95, 2684.03, 0.015);
  assert.equal("ok" in verdict && verdict.ok, false);
  assert.match("reason" in verdict ? verdict.reason : "", /2\.75% above the market price/);
});

test("a price in the user's favor passes, whichever side", () => {
  assert.equal("ok" in checkPrice("eXAG", "Buy", 60.3, 61.16, 0.015) && true, true);
  const sellHigh = checkPrice("cETH", "Sell", 2746.96, 2684.03, 0.015);
  assert.equal("ok" in sellHigh && sellHigh.ok, true);
  const sellLow = checkPrice("eXAG", "Sell", 59.0, 61.16, 0.015);
  assert.equal("ok" in sellLow && sellLow.ok, false);
});

const facts = (overrides: Partial<TradeFacts> = {}): TradeFacts => ({
  symbol: "SPYe",
  side: "Buy",
  price: 770.49,
  market: 765.61,
  dollars: 20,
  units: 20 / 770.49,
  quoteValidUntil: new Date("2026-09-29T12:01:00Z"),
  now: new Date("2026-09-29T12:00:00Z"),
  account: { balances: { USD: 100 }, dailyLimit: 200, spentToday: 0, spentOn: "2026-09-29" },
  ...overrides,
});

test("a normal trade passes", () => {
  const verdict = checkTrade(facts(), policy);
  assert.equal("ok" in verdict && verdict.ok, true);
});

test("limits: expired quote, per-trade cap, daily limit, balance", () => {
  const reason = (overrides: Partial<TradeFacts>) => {
    const verdict = checkTrade(facts(overrides), policy);
    return "reason" in verdict ? verdict.reason : "passed";
  };
  assert.match(reason({ now: new Date("2026-09-29T12:02:00Z") }), /expired/);
  assert.match(reason({ dollars: 600 }), /per-trade limit/);
  assert.match(reason({ account: { balances: { USD: 100 }, dailyLimit: 200, spentToday: 190, spentOn: "2026-09-29" } }), /daily limit/);
  assert.equal(reason({ account: { balances: { USD: 100 }, dailyLimit: 200, spentToday: 190, spentOn: "2026-09-28" } }), "passed");
  assert.match(reason({ dollars: 150 }), /enough dollars/);
  assert.match(reason({ side: "Sell", price: 764, units: 1, dollars: 764 }), /per-trade limit/);
});
