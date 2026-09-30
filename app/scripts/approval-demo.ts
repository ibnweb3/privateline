// Run one trade through the checker bots: node 1 (SMS operator) proposes and confirms; the price
// checker (node 2) and the risk checker (node 3) each check it on their own and confirm or refuse.
//   node scripts/approval-demo.ts [symbol] [dollars]         live prices
//   PRICE_MODE=replay node scripts/approval-demo.ts cETH 20   the Sep 26 06:38 UTC drift
// Stop one checker's DecMan node first (docker stop decman-2) to see the other complete it alone.

import { Checker } from "../src/checker.ts";
import { policyFromEnv } from "../src/checks.ts";
import { Desk } from "../src/desk.ts";
import { decman, ledgers, loadDeployment } from "../src/localnet.ts";
import { newTradeRef, Operator } from "../src/operator.ts";
import { feedFromEnv } from "../src/prices.ts";
import { balancesOf, decimal, templates, type Account } from "../src/privateline.ts";

const symbol = process.argv[2] ?? "SPYe";
const dollars = Number(process.argv[3] ?? "20");
const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

const d = await loadDeployment();
const policy = policyFromEnv();
const checkers = [
  new Checker({ name: "price checker", decman: decman.priceChecker, ledger: ledgers.priceChecker, member: d.members.priceChecker, vault: d.vault, feed: await feedFromEnv(), policy, log }),
  new Checker({ name: "risk checker", decman: decman.riskChecker, ledger: ledgers.riskChecker, member: d.members.riskChecker, vault: d.vault, feed: await feedFromEnv(), policy, log }),
];
for (const checker of checkers) checker.start();

const deskFeed = await feedFromEnv();
const desk = new Desk({ ledger: ledgers.priceChecker, desk: d.desk, vault: d.vault, feed: deskFeed });
const operator = new Operator({ deployment: d, decman: decman.operator, ledger: ledgers.operator, desk, log: (line) => log(`[operator] ${line}`) });

const user = await ledgers.operator.ensureParty(process.env.DEMO_USER ?? "demo-user-1");
const account = (await ledgers.operator.query<Account>(user, templates.account)).find((c) => c.payload.vault === d.vault);
if (!account) throw new Error("no demo account: run npm run demo:trade first");

const { ask } = await desk.indicative(symbol);
log(`prices: ${deskFeed.label}; user confirms "BUY ${symbol} ${dollars}" at about $${ask.toFixed(2)}`);
const result = await operator.trade({
  accountCid: account.contractId,
  accountId: account.payload.accountId,
  symbol,
  side: "Buy",
  amount: { tag: "Dollars", value: decimal(dollars) },
  limitPrice: ask * 1.01,
  tradeRef: newTradeRef(),
});
if (result.ok) {
  log(`DONE in ${(result.elapsedMs / 1000).toFixed(1)}s: bought ${result.fill?.units} ${symbol} for $${dollars}`);
} else {
  log(`NOT DONE in ${(result.elapsedMs / 1000).toFixed(1)}s: ${result.reason}`);
  for (const refusal of result.refusals) log(`  refusal on the ledger: ${refusal}`);
}
const after = (await ledgers.operator.query<Account>(user, templates.account)).find((c) => c.payload.vault === d.vault);
log(`account ${after?.payload.accountId}: ${JSON.stringify(after ? balancesOf(after.payload) : {})}`);
for (const checker of checkers) checker.stop();
process.exit(0);
