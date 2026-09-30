// Settle every open fill with the desk in one net batch, approved 2 of 3 (the operator proposes,
// the price checker confirms), then check that the vault's tokens equal the sum of all accounts.

import { approve, waitForPending } from "../src/governance.ts";
import { decman, ledgers, loadDeployment } from "../src/localnet.ts";
import { balancesOf, templates, type Account, type Fill } from "../src/privateline.ts";

const log = (line: string) => console.log(line);

function add(totals: Record<string, number>, symbol: string, amount: number): void {
  totals[symbol] = Math.round(((totals[symbol] ?? 0) + amount) * 1e10) / 1e10;
}

async function main(): Promise<void> {
  const d = await loadDeployment();
  const ledger = ledgers.operator;
  const fills = await ledger.query<Fill>(d.vault, templates.fill);
  if (fills.length === 0) {
    log("no open fills to settle");
  } else {
    const holdings = await ledger.query<{ symbol: string; amount: string }>(d.vault, templates.demoHolding);
    const batchRef = `S${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
    log(`settling ${fills.length} fills with the desk (batch ${batchRef})`);
    const proposalCid = await ledger.create(d.members.operator, templates.settleProposal, {
      vault: d.vault,
      proposer: d.members.operator,
      deskAgreementCid: d.deskAgreementCid,
      fills: fills.map((fill) => fill.contractId),
      vaultHoldings: holdings.map((holding) => holding.contractId),
      batchRef,
    });
    const pending = await waitForPending(decman.operator, d.vault, proposalCid);
    log(`DecMan shows: [${pending.action_label}] ${pending.description}`);
    await approve(d.vault, proposalCid, [decman.operator, decman.priceChecker], decman.operator, (line) => log(`  ${line}`));
  }

  const tokens: Record<string, number> = {};
  for (const holding of await ledger.query<{ symbol: string; amount: string }>(d.vault, templates.demoHolding)) {
    add(tokens, holding.payload.symbol, Number(holding.payload.amount));
  }
  const books: Record<string, number> = {};
  for (const account of await ledger.query<Account>(d.vault, templates.account)) {
    for (const [symbol, amount] of Object.entries(balancesOf(account.payload))) add(books, symbol, amount);
  }
  log(`vault tokens:  ${JSON.stringify(tokens)}`);
  log(`accounts sum:  ${JSON.stringify(books)}`);
  const symbols = new Set([...Object.keys(tokens), ...Object.keys(books)]);
  const balanced = [...symbols].every((symbol) => tokens[symbol] === books[symbol]);
  log(balanced ? "the books balance" : "MISMATCH between the vault's tokens and the accounts");
  if (!balanced) process.exit(2);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
