// One user's first trade on LocalNet, end to end, through BitSafe's 2-of-3 approval:
//   1. The SMS operator opens a funded account for the user; nodes 1 and 2 approve.
//   2. The desk quotes SPYe.
//   3. The user texts "BUY SPY 30"; the operator proposes the trade; nodes 1 and 3 approve.
//   4. Each party's view of the result.
// The price is a fixed demo price until live Cantex prices are wired in.

import { randomBytes } from "node:crypto";

import { approve, waitForPending } from "../src/governance.ts";
import { decman, ledgers, loadDeployment } from "../src/localnet.ts";
import { balancesOf, decimal, templates, type Account, type ExecutionResult, type Fill } from "../src/privateline.ts";

const USER_HINT = process.env.DEMO_USER ?? "demo-user-1";
const SYMBOL = "SPYe";
const ASK = Number(process.env.DEMO_ASK ?? "600");
const SPEND = 30;

const log = (line: string) => console.log(line);
const step = (title: string) => console.log(`\n== ${title}`);
const short = (id: string) => `${id.slice(0, 12)}…`;

async function main(): Promise<void> {
  const d = await loadDeployment();
  const operatorLedger = ledgers.operator;
  const deskLedger = ledgers.priceChecker;
  const user = await operatorLedger.ensureParty(USER_HINT);
  log(`user party (hosted by the SMS operator's node): ${user}`);

  let account = (await operatorLedger.query<Account>(user, templates.account)).find((c) => c.payload.vault === d.vault);
  if (!account) {
    step("1. The SMS operator opens a funded account; the operator and the price checker approve");
    const accountId = `pl-${randomBytes(2).toString("hex")}`;
    const proposalCid = await operatorLedger.create(d.members.operator, templates.openAccountProposal, {
      vault: d.vault,
      proposer: d.members.operator,
      faucetCid: d.faucetCid,
      user,
      accountId,
      phoneTag: `demo-tag-${accountId}`,
      dailyLimit: "200.0",
      startingDollars: "100.0",
    });
    const pending = await waitForPending(decman.operator, d.vault, proposalCid);
    log(`DecMan shows: [${pending.action_label}] ${pending.description}`);
    await approve(d.vault, proposalCid, [decman.operator, decman.priceChecker], decman.priceChecker, (line) => log(`  ${line}`));
    account = (await operatorLedger.query<Account>(user, templates.account)).find((c) => c.payload.vault === d.vault);
    if (!account) throw new Error("the account was not created");
  } else {
    step("1. The user already has an account");
  }
  log(`account ${account.payload.accountId}: ${JSON.stringify(balancesOf(account.payload))}`);

  step(`2. The desk quotes ${SYMBOL} (fixed demo price)`);
  const now = Date.now();
  const quoteCid = await deskLedger.create(d.desk, templates.quote, {
    desk: d.desk,
    vault: d.vault,
    symbol: SYMBOL,
    bid: decimal(ASK * 0.998),
    ask: decimal(ASK),
    source: "fixed demo price",
    quotedAt: new Date(now).toISOString(),
    validUntil: new Date(now + 120_000).toISOString(),
  });
  log(`quote ${short(quoteCid)}: ask $${ASK}, valid for 2 minutes`);

  step(`3. The user texts "BUY SPY ${SPEND}"; the operator proposes; the operator and the risk checker approve`);
  const tradeRef = `T${randomBytes(2).toString("hex").toUpperCase()}`;
  const tradeCid = await operatorLedger.create(d.members.operator, templates.tradeProposal, {
    vault: d.vault,
    proposer: d.members.operator,
    accountCid: account.contractId,
    accountId: account.payload.accountId,
    quoteCid,
    symbol: SYMBOL,
    side: "Buy",
    amount: { tag: "Dollars", value: decimal(SPEND) },
    limitPrice: decimal(ASK * 1.005),
    tradeRef,
  });
  const pendingTrade = await waitForPending(decman.operator, d.vault, tradeCid);
  log(`DecMan shows: [${pendingTrade.action_label}] ${pendingTrade.description}`);
  await approve(d.vault, tradeCid, [decman.operator, decman.riskChecker], decman.riskChecker, (line) => log(`  ${line}`));

  step("4. What each party sees");
  const updated = (await operatorLedger.query<Account>(user, templates.account)).find((c) => c.payload.vault === d.vault);
  log(`user sees their account: ${JSON.stringify(updated ? balancesOf(updated.payload) : {})}`);
  const fills = await deskLedger.query<Fill>(d.desk, templates.fill);
  const fill = fills.find((c) => c.payload.tradeRef === tradeRef)?.payload;
  log(`desk sees the fill: ${fill ? `${fill.side} ${fill.units} ${fill.symbol} at $${fill.price} for $${fill.dollars}, ref ${fill.tradeRef} (no user named)` : "none"}`);
  const deskAccounts = await deskLedger.query<Account>(d.desk, templates.account);
  log(`desk sees accounts: ${deskAccounts.length}`);
  const records = (await operatorLedger.query<ExecutionResult>(d.vault, templates.executionResult))
    .filter((c) => c.payload.actionLabel.startsWith("PrivateLine"));
  log(`vault audit trail (PrivateLine actions): ${records.length}`);
  for (const record of records.slice(-2)) {
    log(`  [${record.payload.actionLabel}] ${record.payload.description} (confirmed by ${record.payload.confirmers.length})`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
