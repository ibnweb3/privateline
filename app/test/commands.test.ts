import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCommand } from "../src/sms/commands.ts";

const kind = (text: string) => parseCommand(text).kind;

test("word order, case, $ and commas don't matter", () => {
  for (const text of ["BUY GOLD 20", "buy gold 20", "Buy $20 Gold", "BUY 20 GOLD", "buy gold $20.00", "BUY GOLD 20."]) {
    const command = parseCommand(text);
    assert.equal(command.kind, "buy", text);
    if (command.kind === "buy") {
      assert.equal(command.asset.symbol, "eXAU", text);
      assert.equal(Number(command.dollars), 20, text);
    }
  }
  const big = parseCommand("BUY SPY 1,250");
  assert.equal(big.kind === "buy" && big.dollars, "1250");
});

test("assets by alias", () => {
  const cases: [string, string][] = [["SPY", "SPYe"], ["S&P", "SPYe"], ["NASDAQ", "QQQe"], ["SILVER", "eXAG"], ["BITCOIN", "cBTC"], ["ETH", "cETH"]];
  for (const [alias, symbol] of cases) {
    const command = parseCommand(`BUY ${alias} 10`);
    assert.equal(command.kind === "buy" && command.asset.symbol, symbol, alias);
  }
});

test("sell by dollars or everything", () => {
  const all = parseCommand("SELL GOLD ALL");
  assert.equal(all.kind === "sell" && all.all, true);
  const allFirst = parseCommand("sell all gold");
  assert.equal(allFirst.kind === "sell" && allFirst.all, true);
  const some = parseCommand("SELL BTC 15");
  assert.equal(some.kind === "sell" && !some.all && some.dollars, "15");
});

test("confirmation needs a 4-6 digit PIN", () => {
  assert.deepEqual(parseCommand("YES 4821"), { kind: "yes", pin: "4821" });
  assert.deepEqual(parseCommand("yes 482195"), { kind: "yes", pin: "482195" });
  assert.equal(kind("YES"), "unknown");
  assert.equal(kind("YES 12"), "unknown");
  assert.equal(kind("NO"), "no");
});

test("missing or unknown pieces come back with a hint", () => {
  const noAmount = parseCommand("BUY GOLD");
  assert.equal(noAmount.kind, "unknown");
  assert.match(noAmount.kind === "unknown" ? noAmount.hint ?? "" : "", /US dollars/);
  const noAsset = parseCommand("BUY 20");
  assert.match(noAsset.kind === "unknown" ? noAsset.hint ?? "" : "", /Which asset/);
  assert.equal(kind("PRICE DOGE"), "unknown");
  assert.equal(kind("gibberish"), "unknown");
});

test("deposits and withdrawals", () => {
  assert.equal(kind("DEPOSIT"), "deposit");
  assert.equal(kind("add money"), "deposit");
  assert.equal(kind("fund"), "deposit");
  assert.deepEqual(parseCommand("WITHDRAW 20"), { kind: "withdraw", dollars: "20", all: false });
  assert.deepEqual(parseCommand("withdraw $12.50"), { kind: "withdraw", dollars: "12.50", all: false });
  assert.deepEqual(parseCommand("WITHDRAW ALL"), { kind: "withdraw", all: true });
  assert.equal(kind("WITHDRAW"), "unknown");
});

test("alerts, lock and help", () => {
  const alert = parseCommand("ALERT GOLD 2");
  assert.equal(alert.kind === "alert" && alert.pct, 2);
  assert.equal(parseCommand("alert silver 1.5%").kind, "alert");
  assert.equal(kind("ALERT GOLD 0.1"), "unknown");
  assert.equal(kind("ALERTS"), "alerts");
  assert.equal(kind("ALERTS OFF"), "alertsOff");
  assert.equal(kind("STOP"), "alertsOff");
  assert.equal(kind("LOCK"), "lock");
  assert.equal(kind("help"), "help");
  assert.equal(kind("BAL"), "balance");
  assert.equal(kind("PRICE"), "price");
});
