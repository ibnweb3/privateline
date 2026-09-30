// An independent checker: watches its own DecMan node for PrivateLine proposals, checks each one
// against its own ledger node and its own price fetch, then confirms it or records a refusal with
// the reason. It never executes: execution happens once 2 of 3 operators have confirmed.

import { checkTrade, type Policy, type Verdict } from "./checks.ts";
import type { DecMan, PendingAction } from "./decman.ts";
import type { Ledger } from "./ledger.ts";
import type { PriceFeed } from "./prices.ts";
import {
  balancesOf, templates,
  type Account, type ChangePhoneProposal, type DepositProposal, type Fill, type OpenAccountProposal, type Quote,
  type SettleProposal, type TradeProposal,
} from "./privateline.ts";

export interface CheckerOptions {
  /** "price checker" or "risk checker", for logs. */
  name: string;
  decman: DecMan;
  ledger: Ledger;
  /** The member party this checker confirms as. */
  member: string;
  vault: string;
  feed: PriceFeed;
  policy: Policy;
  log?: (line: string) => void;
}

export class Checker {
  readonly name: string;
  private readonly options: CheckerOptions;
  private readonly decided = new Map<string, "confirmed" | "refused">();
  private readonly waiting = new Set<string>();
  private running = false;
  private stopped = false;
  lastTickAt = 0;
  lastError = "";

  constructor(options: CheckerOptions) {
    this.options = options;
    this.name = options.name;
  }

  private log(line: string): void {
    this.options.log?.(`[${this.name}] ${line}`);
  }

  private async find<T>(templateId: string, contractId: string): Promise<T | undefined> {
    const contracts = await this.options.ledger.query<T>(this.options.vault, templateId);
    return contracts.find((contract) => contract.contractId === contractId)?.payload;
  }

  async evaluate(action: PendingAction): Promise<Verdict> {
    const { policy, feed } = this.options;
    const cid = action.proposal_cid;
    switch (action.action_label) {
      case "PrivateLineTrade": {
        const proposal = await this.find<TradeProposal>(templates.tradeProposal, cid);
        if (!proposal) return { wait: "proposal not visible yet" };
        const quote = await this.find<Quote>(templates.quote, proposal.quoteCid);
        if (!quote) return { ok: false, reason: `the ${proposal.symbol} quote no longer exists` };
        const account = await this.find<Account>(templates.account, proposal.accountCid);
        if (!account) return { ok: false, reason: "the account changed after this trade was proposed" };
        const price = Number(proposal.side === "Buy" ? quote.ask : quote.bid);
        const amount = Number(proposal.amount.value);
        const [units, dollars] = proposal.amount.tag === "Dollars" ? [amount / price, amount] : [amount, amount * price];
        return checkTrade({
          symbol: proposal.symbol,
          side: proposal.side,
          price,
          market: await feed.market(proposal.symbol),
          dollars,
          units,
          quoteValidUntil: new Date(quote.validUntil),
          now: new Date(),
          account: {
            balances: balancesOf(account),
            dailyLimit: Number(account.dailyLimit),
            spentToday: Number(account.spentToday),
            spentOn: account.spentOn,
          },
        }, policy);
      }
      case "PrivateLineOpenAccount": {
        const proposal = await this.find<OpenAccountProposal>(templates.openAccountProposal, cid);
        if (!proposal) return { wait: "proposal not visible yet" };
        if (Number(proposal.startingDollars) > policy.maxStartingDollars) {
          return { ok: false, reason: `starting balance over the $${policy.maxStartingDollars} demo cap` };
        }
        if (Number(proposal.dailyLimit) > policy.maxDailyLimit) {
          return { ok: false, reason: `daily limit over the $${policy.maxDailyLimit} cap` };
        }
        return { ok: true, note: `account ${proposal.accountId} within caps` };
      }
      case "PrivateLineDeposit": {
        const proposal = await this.find<DepositProposal>(templates.depositProposal, cid);
        if (!proposal) return { wait: "proposal not visible yet" };
        return Number(proposal.amount) > policy.maxDeposit
          ? { ok: false, reason: `deposit over the $${policy.maxDeposit} cap` }
          : { ok: true, note: `deposit of $${proposal.amount}` };
      }
      case "PrivateLineSettle": {
        const proposal = await this.find<SettleProposal>(templates.settleProposal, cid);
        if (!proposal) return { wait: "proposal not visible yet" };
        const open = new Set((await this.options.ledger.query<Fill>(this.options.vault, templates.fill)).map((fill) => fill.contractId));
        const missing = proposal.fills.filter((fill) => !open.has(fill));
        return missing.length > 0
          ? { ok: false, reason: `${missing.length} of the fills are not open` }
          : { ok: true, note: `settle ${proposal.fills.length} open fills` };
      }
      case "PrivateLineChangePhone": {
        const proposal = await this.find<ChangePhoneProposal>(templates.changePhoneProposal, cid);
        if (!proposal) return { wait: "proposal not visible yet" };
        const cooldownSeconds = Number(proposal.cooldown.microseconds) / 1e6;
        if (cooldownSeconds < policy.minPhoneChangeCooldownSeconds) {
          return { ok: false, reason: `a ${cooldownSeconds}s cooldown is shorter than the required ${policy.minPhoneChangeCooldownSeconds}s` };
        }
        const requestedAt = new Date(proposal.requestedAt).getTime() / 1000;
        if (Math.abs(requestedAt - action.created_at) > 120) {
          return { ok: false, reason: "the request time doesn't match when the change was proposed" };
        }
        const readyAt = requestedAt + cooldownSeconds;
        return Date.now() / 1000 < readyAt
          ? { wait: `cooldown until ${new Date(readyAt * 1000).toISOString()}` }
          : { ok: true, note: `phone change for ${proposal.accountId} after its cooldown` };
      }
      default:
        return { wait: `no rule for ${action.action_label}` };
    }
  }

  /** One pass over the pending PrivateLine proposals. */
  async tick(): Promise<void> {
    const { decman, ledger, member, vault } = this.options;
    const pending = (await decman.pendingActions(vault)).filter((action) => action.action_label.startsWith("PrivateLine"));
    let rulesCid: string | undefined;
    for (const action of pending) {
      const cid = action.proposal_cid;
      if (this.decided.has(cid)) continue;
      if (action.confirmations.some((confirmation) => confirmation.confirming_party === member)) {
        this.decided.set(cid, "confirmed");
        continue;
      }
      const verdict = await this.evaluate(action);
      if ("wait" in verdict) {
        if (!this.waiting.has(cid)) this.log(`waiting on ${action.action_label}: ${verdict.wait}`);
        this.waiting.add(cid);
        continue;
      }
      if (verdict.ok) {
        rulesCid ??= await decman.rulesCid(vault);
        await decman.confirm(vault, rulesCid, cid);
        this.decided.set(cid, "confirmed");
        this.log(`confirmed ${action.action_label}: ${verdict.note}`);
      } else {
        await ledger.create(member, templates.checkRefusal, {
          vault,
          checker: member,
          proposalCid: cid,
          actionLabel: action.action_label,
          reason: verdict.reason,
          refusedAt: new Date().toISOString(),
        });
        this.decided.set(cid, "refused");
        this.log(`REFUSED ${action.action_label}: ${verdict.reason}`);
      }
    }
    this.lastTickAt = Date.now();
    this.lastError = "";
  }

  /** Check for new proposals every `intervalMs` until `stop()`. Errors are logged and retried. */
  start(intervalMs = 1500): void {
    const loop = async () => {
      if (this.stopped) return;
      if (!this.running) {
        this.running = true;
        try {
          await this.tick();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message !== this.lastError) this.log(`error: ${message.slice(0, 300)}`);
          this.lastError = message;
        } finally {
          this.running = false;
        }
      }
      setTimeout(loop, intervalMs);
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
  }
}
