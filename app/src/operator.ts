// The SMS operator's side of every action: propose it, add its own confirmation, wait for an
// independent checker, and execute once 2 of 3 have confirmed. If both checkers refuse, or approval
// times out, it withdraws the proposal and reports why, in words an SMS reply can use.

import { randomBytes } from "node:crypto";

import type { DecMan, PendingAction } from "./decman.ts";
import type { Desk, QuoteInfo } from "./desk.ts";
import { waitForPending } from "./governance.ts";
import type { Ledger } from "./ledger.ts";
import type { Deployment } from "./localnet.ts";
import {
  decimal, templates,
  type CheckRefusal, type DemoHolding, type Fill, type Side, type TradeAmount,
} from "./privateline.ts";

export interface Outcome {
  ok: boolean;
  proposalCid: string;
  /** Why it didn't happen, for the user. */
  reason?: string;
  /** Checkers' refusal reasons, if any. */
  refusals: string[];
  /** Milliseconds from proposal to result. */
  elapsedMs: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One confirmation per member. GovernanceRules rejects an execution that repeats a confirmer, and a
 * member can end up with two confirmations (for example two checker processes for one node).
 */
function oneConfirmationPerMember(action: PendingAction): string[] {
  const byMember = new Map<string, string>();
  for (const confirmation of action.confirmations) {
    if (confirmation.expires_at * 1000 > Date.now() && !byMember.has(confirmation.confirming_party)) {
      byMember.set(confirmation.confirming_party, confirmation.contract_id);
    }
  }
  return [...byMember.values()];
}

/** Turn a ledger rejection into a sentence, keeping the contract's own assertion text. */
export function explainLedgerError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const assertion = /(quote expired[^",\\]*|over the daily limit[^",\\]*|not enough [^",\\]*|price moved[^",\\]*|cooldown runs until[^",\\]*|faucet mints at most[^",\\]*|vault holds [^",\\]*)/.exec(text);
  if (assertion) return assertion[1]!.trim();
  if (/could not be found|CONTRACT_NOT_FOUND|not active/i.test(text)) return "the account changed while this was being approved";
  return "the ledger rejected it";
}

export class Operator {
  private readonly deployment: Deployment;
  private readonly decman: DecMan;
  private readonly ledger: Ledger;
  readonly desk: Desk;
  private readonly timeoutMs: number;
  private readonly log: (line: string) => void;

  constructor(options: { deployment: Deployment; decman: DecMan; ledger: Ledger; desk: Desk; timeoutMs?: number; log?: (line: string) => void }) {
    this.deployment = options.deployment;
    this.decman = options.decman;
    this.ledger = options.ledger;
    this.desk = options.desk;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.APPROVAL_TIMEOUT_MS ?? 30_000);
    this.log = options.log ?? (() => {});
  }

  private get vault(): string {
    return this.deployment.vault;
  }

  private get member(): string {
    return this.deployment.members.operator;
  }

  /** Create a proposal as the operator's member party. */
  async propose(templateId: string, fields: Record<string, unknown>): Promise<string> {
    return this.ledger.create(this.member, templateId, { vault: this.vault, proposer: this.member, ...fields });
  }

  /** Withdraw a proposal that won't run (GovernableAction_ProposerCancel). */
  async withdraw(proposalCid: string): Promise<void> {
    try {
      await this.ledger.exercise([this.member], templates.governableAction, proposalCid, "GovernableAction_ProposerCancel", {});
    } catch {
      // Already executed or withdrawn.
    }
  }

  private async refusalsFor(proposalCid: string): Promise<string[]> {
    const refusals = await this.ledger.query<CheckRefusal>(this.vault, templates.checkRefusal);
    return refusals.filter((refusal) => refusal.payload.proposalCid === proposalCid).map((refusal) => refusal.payload.reason);
  }

  /** Confirm our own proposal, wait for a checker, and execute. */
  async approveAndExecute(proposalCid: string, label: string): Promise<Outcome> {
    const started = Date.now();
    const done = (ok: boolean, refusals: string[], reason?: string): Outcome =>
      ({ ok, proposalCid, refusals, elapsedMs: Date.now() - started, ...(reason ? { reason } : {}) });

    await waitForPending(this.decman, this.vault, proposalCid);
    const rulesCid = await this.decman.rulesCid(this.vault);
    await this.decman.confirm(this.vault, rulesCid, proposalCid);

    let refusals: string[] = [];
    while (Date.now() - started < this.timeoutMs) {
      const action = (await this.decman.pendingActions(this.vault)).find((pending) => pending.proposal_cid === proposalCid);
      if (action?.can_execute) {
        try {
          await this.decman.execute(this.vault, rulesCid, proposalCid, oneConfirmationPerMember(action));
          this.log(`${label}: executed with ${action.confirmation_count} confirmations`);
          return done(true, refusals);
        } catch (error) {
          const reason = explainLedgerError(error);
          this.log(`${label}: execution failed: ${reason}`);
          await this.withdraw(proposalCid);
          return done(false, refusals, reason);
        }
      }
      refusals = await this.refusalsFor(proposalCid);
      if (refusals.length >= 2) {
        this.log(`${label}: refused by both checkers`);
        await this.withdraw(proposalCid);
        return done(false, refusals, refusals[0]);
      }
      await sleep(700);
    }
    await this.withdraw(proposalCid);
    this.log(`${label}: timed out waiting for approvals`);
    return done(false, refusals, refusals[0] ?? "not enough operators approved it in time");
  }

  async openAccount(fields: { user: string; accountId: string; phoneTag: string; dailyLimit: number; startingDollars: number }): Promise<Outcome> {
    const proposalCid = await this.propose(templates.openAccountProposal, {
      faucetCid: this.deployment.faucetCid,
      user: fields.user,
      accountId: fields.accountId,
      phoneTag: fields.phoneTag,
      dailyLimit: decimal(fields.dailyLimit),
      startingDollars: decimal(fields.startingDollars),
    });
    return this.approveAndExecute(proposalCid, `open account ${fields.accountId}`);
  }

  async deposit(fields: { accountCid: string; accountId: string; amount: number }): Promise<Outcome> {
    const proposalCid = await this.propose(templates.depositProposal, {
      faucetCid: this.deployment.faucetCid,
      accountCid: fields.accountCid,
      accountId: fields.accountId,
      amount: decimal(fields.amount),
    });
    return this.approveAndExecute(proposalCid, `deposit to ${fields.accountId}`);
  }

  /** Get a firm quote from the desk, propose the trade, and see it through. */
  async trade(fields: { accountCid: string; accountId: string; symbol: string; side: Side; amount: TradeAmount; limitPrice: number; tradeRef: string }):
    Promise<Outcome & { quote: QuoteInfo; fill?: Fill }> {
    const quote = await this.desk.quote(fields.symbol);
    const proposalCid = await this.propose(templates.tradeProposal, {
      accountCid: fields.accountCid,
      accountId: fields.accountId,
      quoteCid: quote.quoteCid,
      symbol: fields.symbol,
      side: fields.side,
      amount: fields.amount,
      limitPrice: decimal(fields.limitPrice),
      tradeRef: fields.tradeRef,
    });
    const outcome = await this.approveAndExecute(proposalCid, `trade ${fields.tradeRef}`);
    if (!outcome.ok) return { ...outcome, quote };
    const fills = await this.ledger.query<Fill>(this.vault, templates.fill);
    const fill = fills.find((candidate) => candidate.payload.tradeRef === fields.tradeRef)?.payload;
    return { ...outcome, quote, ...(fill ? { fill } : {}) };
  }

  /** Settle every open fill with the desk in one net batch. Returns undefined if there is nothing to settle. */
  async settle(): Promise<Outcome | undefined> {
    const fills = await this.ledger.query<Fill>(this.vault, templates.fill);
    if (fills.length === 0) return undefined;
    const holdings = await this.ledger.query<DemoHolding>(this.vault, templates.demoHolding);
    const proposalCid = await this.propose(templates.settleProposal, {
      deskAgreementCid: this.deployment.deskAgreementCid,
      fills: fills.map((fill) => fill.contractId),
      vaultHoldings: holdings.map((holding) => holding.contractId),
      batchRef: `S${randomBytes(3).toString("hex").toUpperCase()}`,
    });
    return this.approveAndExecute(proposalCid, `settle ${fills.length} fills`);
  }

  /**
   * Execute a proposal that was confirmed earlier (a phone change after its cooldown), if 2 of 3
   * have confirmed it by now. "gone" means it was withdrawn or already executed.
   */
  async executeIfReady(proposalCid: string): Promise<"executed" | "waiting" | "gone"> {
    const action = (await this.decman.pendingActions(this.vault)).find((pending) => pending.proposal_cid === proposalCid);
    if (!action) return "gone";
    if (!action.can_execute) return "waiting";
    const rulesCid = await this.decman.rulesCid(this.vault);
    await this.decman.execute(this.vault, rulesCid, proposalCid, oneConfirmationPerMember(action));
    return "executed";
  }

  /** Start a phone change; it can only execute after the cooldown. Returns the proposal id. */
  async requestPhoneChange(fields: { accountCid: string; accountId: string; newPhoneTag: string; cooldownSeconds: number }): Promise<string> {
    const proposalCid = await this.propose(templates.changePhoneProposal, {
      accountCid: fields.accountCid,
      accountId: fields.accountId,
      newPhoneTag: fields.newPhoneTag,
      requestedAt: new Date().toISOString(),
      cooldown: { microseconds: String(Math.round(fields.cooldownSeconds * 1e6)) },
    });
    await waitForPending(this.decman, this.vault, proposalCid);
    await this.decman.confirm(this.vault, await this.decman.rulesCid(this.vault), proposalCid);
    return proposalCid;
  }
}

/** A short reference for a trade, shown in the user's SMS. */
export function newTradeRef(): string {
  return `T${randomBytes(2).toString("hex").toUpperCase()}`;
}
