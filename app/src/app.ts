// PrivateLine's application service: text commands, sign-up and sign-in, the account and privacy
// views, and the background jobs (price alerts, net settlement, phone changes, quote clean-up).
// Money only moves through the Operator, so every trade still needs 2 of 3 operators.

import { randomBytes, randomUUID } from "node:crypto";

import { policyFromEnv } from "./checks.ts";
import type { Db, User } from "./db.ts";
import { dollarsForNaira, naira, nairaForDollars, nairaRates } from "./fx.ts";
import {
  DEMO_BANK, demoTransferEvent, maskAccount, newVirtualAccountNumber, parsePaymentEvent, signPayment,
  type IncomingTransfer,
} from "./payments.ts";
import type { Desk } from "./desk.ts";
import type { Ledger } from "./ledger.ts";
import type { Deployment } from "./localnet.ts";
import { newTradeRef, type Operator } from "./operator.ts";
import { ASSETS, assetBySymbol, type Asset, type PriceFeed } from "./prices.ts";
import {
  balancesOf, templates,
  type Account, type CheckRefusal, type DemoHolding, type ExecutionResult, type Fill, type TradeProposal,
} from "./privateline.ts";
import * as secrets from "./secrets.ts";
import { parseCommand } from "./sms/commands.ts";
import { price, quantity, signedPct, usd } from "./sms/format.ts";
import { isSimulatorPhone, type InboundSms, type RoutingGateway } from "./sms/gateway.ts";
import { maskPhone, normalizeE164 } from "./sms/phone.ts";

/** A problem to show the person on the website. */
export class UserError extends Error {}

interface PendingWithdrawal {
  dollars: number;
  naira: number;
  rate: number;
  bank: string;
  account: string;
  name: string;
  ref: string;
}

interface PendingTrade {
  side: "Buy" | "Sell";
  symbol: string;
  /** Dollars to spend or receive; absent for SELL ALL. */
  dollars?: string;
  /** Exact units for SELL ALL. */
  units?: string;
  /** The desk's price shown in the confirmation text. */
  indicative: number;
  tradeRef: string;
}

const CONFIRM_TTL_MS = 2 * 60_000;
const PIN_MAX_FAILURES = 3;
const PIN_LOCK_MS = 15 * 60_000;
/** How far the executed price may move against the user from the price in their confirmation text. */
const SLIPPAGE = 0.01;
const CODE_TTL_MS = 10 * 60_000;
const CODE_MAX_ATTEMPTS = 5;
const SIGNUP_TTL_MS = 30 * 60_000;
const SESSION_TTL_MS = 7 * 24 * 3600_000;

export interface AppOptions {
  db: Db;
  gateway: RoutingGateway;
  operator: Operator;
  desk: Desk;
  deployment: Deployment;
  /** The SMS operator's ledger node: hosts user parties, reads as the vault. */
  operatorLedger: Ledger;
  /** The desk's ledger node, for the privacy view. */
  deskLedger: Ledger;
  /** Market reference prices for PRICE replies. */
  feed: PriceFeed;
  publicUrl: string;
  startingDollars: number;
  dailyLimit: number;
  phoneChangeCooldownSeconds: number;
  /** "dev" shows email codes on screen instead of emailing them. */
  emailMode: "dev";
  /** Shared secret that signs deposit notifications from the payment provider. */
  paymentsSecret: string;
  log: (line: string) => void;
}

export class PrivateLine {
  readonly options: AppOptions;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly strangerReplies = new Map<string, number>();
  private readonly policy = policyFromEnv();
  private privacyProbe: string | undefined;

  constructor(options: AppOptions) {
    this.options = options;
  }

  private get db(): Db {
    return this.options.db;
  }

  private log(line: string): void {
    this.options.log(line);
  }

  // ==========================================================================
  // Text messages
  // ==========================================================================

  /** Handle one inbound text. Texts from the same user are processed one at a time, in order. */
  async receive(sms: InboundSms): Promise<void> {
    if (!this.db.firstSighting(sms.msgId)) return;
    const user = this.db.userByPhone(secrets.phoneLookup(sms.from));
    if (!user) return this.replyToStranger(sms.from);
    const previous = this.queues.get(user.id) ?? Promise.resolve();
    const next = previous
      .then(() => this.handle(user.id, sms.from, sms.body))
      .catch((error: unknown) => {
        this.log(`sms from ${maskPhone(sms.from)} failed: ${error instanceof Error ? error.stack ?? error.message : error}`);
        return this.send(sms.from, "Sorry, something went wrong on our side. Nothing was traded. Please try again.");
      });
    this.queues.set(user.id, next);
    return next;
  }

  private async send(phone: string, text: string): Promise<void> {
    try {
      await this.options.gateway.send(phone, text);
    } catch (error) {
      this.log(`send to ${maskPhone(phone)} failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async replyToStranger(phone: string): Promise<void> {
    const last = this.strangerReplies.get(phone) ?? 0;
    if (Date.now() - last < 3600_000) return;
    this.strangerReplies.set(phone, Date.now());
    await this.send(phone, `This number isn't on PrivateLine yet. Sign up at ${this.options.publicUrl}/signup`);
  }

  private async handle(userId: string, phone: string, body: string): Promise<void> {
    const user = this.db.userById(userId);
    if (!user) return;
    const command = parseCommand(body);
    const reply = (text: string) => this.send(phone, text);

    if (user.locked && command.kind !== "help") {
      return reply(`Your PrivateLine account is locked. Unlock it at ${this.options.publicUrl}/account with your email.`);
    }

    switch (command.kind) {
      case "help":
        return reply("PrivateLine: BAL | DEPOSIT | PRICE GOLD | BUY GOLD 20 | SELL GOLD 10 or ALL | WITHDRAW 20 | ALERT GOLD 2 | LOCK. Amounts in US$. Trades and withdrawals need YES + your PIN.");
      case "deposit":
        return reply(await this.depositInstructions(user));
      case "withdraw":
        return reply(await this.startWithdrawal(user, command.dollars, command.all));
      case "balance":
        return reply(await this.balanceText(user));
      case "price":
        return reply(command.asset ? await this.priceText(command.asset) : await this.pricesText());
      case "buy":
        return reply(await this.startTrade(user, "Buy", command.asset, command.dollars));
      case "sell":
        return reply(await this.startTrade(user, "Sell", command.asset, command.dollars, command.all));
      case "yes":
        return reply(await this.confirmTrade(user, command.pin));
      case "no":
        return reply(await this.cancel(user));
      case "alert": {
        const { mid } = await this.options.desk.indicative(command.asset.symbol);
        this.db.putAlert({ user_id: user.id, symbol: command.asset.symbol, pct: command.pct, base_price: mid });
        return reply(`OK: we'll text you when ${command.asset.name} moves ${command.pct}% from ${price(mid)}/${command.asset.unit}. ALERTS OFF to stop.`);
      }
      case "alerts": {
        const alerts = this.db.alerts(user.id);
        return reply(alerts.length === 0
          ? "No price alerts. e.g. ALERT GOLD 2 texts you when gold moves 2%."
          : `Your alerts: ${alerts.map((alert) => `${assetBySymbol(alert.symbol).name} ${alert.pct}%`).join(", ")}. ALERTS OFF to stop.`);
      }
      case "alertsOff":
        this.db.deleteAlerts(user.id);
        return reply("Price alerts are off. Your account is unchanged.");
      case "lock":
        this.db.setLocked(user.id, true);
        this.db.deletePending(user.id);
        this.db.addActivity(user.id, "Account locked by text (LOCK)");
        return reply(`Locked. No trades until you unlock it at ${this.options.publicUrl}/account with your email. Your money stays in your account.`);
      case "unknown":
        return reply(command.hint ? `${command.hint}. Text HELP for all commands.` : "Sorry, I didn't get that. Text HELP for commands.");
    }
  }

  /** The user's account contract, read as the user's own party. */
  async account(user: User): Promise<{ contractId: string; payload: Account; signatories: string[]; observers: string[] }> {
    const accounts = await this.options.operatorLedger.query<Account>(user.party, templates.account);
    const account = accounts.find((candidate) => candidate.payload.vault === this.options.deployment.vault);
    if (!account) throw new Error(`no account for ${user.account_id}`);
    return account;
  }

  /** Holdings with their value at the desk's mid price. */
  async holdings(account: Account): Promise<{ cash: number; items: { asset: Asset; units: number; unitsText: string; value: number; price: number }[]; total: number }> {
    const balances = balancesOf(account);
    const cash = balances.USD ?? 0;
    const items = [];
    for (const [symbol, unitsText] of account.balances) {
      if (symbol === "USD") continue;
      const asset = assetBySymbol(symbol);
      const { mid } = await this.options.desk.indicative(symbol);
      const units = Number(unitsText);
      items.push({ asset, units, unitsText, value: units * mid, price: mid });
    }
    return { cash, items, total: cash + items.reduce((sum, item) => sum + item.value, 0) };
  }

  private async balanceText(user: User): Promise<string> {
    const account = await this.account(user);
    const { cash, items, total } = await this.holdings(account.payload);
    const parts = [`Cash ${usd(cash)}`, ...items.map((item) => `${item.asset.name} ${quantity(item.units)} ${item.asset.unit} (${usd(item.value)})`)];
    return `${parts.join(" | ")} | Total ${usd(total)}. Acct ${user.account_id}`;
  }

  private async priceText(asset: Asset): Promise<string> {
    const { bid, ask } = await this.options.desk.indicative(asset.symbol);
    let market = "";
    try {
      const reference = await this.options.feed.market(asset.symbol);
      market = ` Market price ${price(reference)} (Canton ${signedPct((bid + ask) / 2 / reference - 1)}).`;
    } catch {
      // The reference is informational here.
    }
    return `${asset.name} on Canton: buy ${price(ask)}, sell ${price(bid)} per ${asset.unit}.${market} BUY ${asset.aliases[0]} 20 buys $20 worth.`;
  }

  private async pricesText(): Promise<string> {
    const parts = [];
    for (const asset of ASSETS) {
      const { mid } = await this.options.desk.indicative(asset.symbol);
      parts.push(`${asset.name} ${price(mid)}`);
    }
    return `Canton prices: ${parts.join(" | ")}. PRICE GOLD for details.`;
  }

  private async startTrade(user: User, side: "Buy" | "Sell", asset: Asset, dollars?: string, all = false): Promise<string> {
    const account = (await this.account(user)).payload;
    const balances = balancesOf(account);
    const { bid, ask } = await this.options.desk.indicative(asset.symbol);
    const indicative = side === "Buy" ? ask : bid;
    const tradeRef = newTradeRef();
    const today = new Date().toISOString().slice(0, 10);
    const spent = account.spentOn === today ? Number(account.spentToday) : 0;
    const left = Number(account.dailyLimit) - spent;

    let pending: PendingTrade;
    let restated: string;
    if (side === "Buy") {
      const amount = Number(dollars);
      if (amount < 1) return "The smallest trade is $1.";
      if (amount > this.policy.maxTradeDollars) return `The largest single trade is ${usd(this.policy.maxTradeDollars)}.`;
      if (amount > (balances.USD ?? 0)) return `You have ${usd(balances.USD ?? 0)} in cash. Text BAL to see your account.`;
      if (amount > left) return `That's over your daily limit: ${usd(Math.max(0, left))} left today.`;
      pending = { side, symbol: asset.symbol, dollars, indicative, tradeRef };
      restated = `Buy ${usd(amount)} of ${asset.name} at about ${price(ask)}/${asset.unit} (${quantity(amount / ask)} ${asset.unit})`;
    } else {
      const held = account.balances.find(([symbol]) => symbol === asset.symbol)?.[1];
      if (!held) return `You don't hold any ${asset.name}. Text BAL to see your account.`;
      if (all) {
        const value = Number(held) * bid;
        if (value > left) return `That's over your daily limit: ${usd(Math.max(0, left))} left today.`;
        pending = { side, symbol: asset.symbol, units: held, indicative, tradeRef };
        restated = `Sell all ${quantity(Number(held))} ${asset.unit} of ${asset.name} at about ${price(bid)}/${asset.unit} (about ${usd(value)})`;
      } else {
        const amount = Number(dollars);
        if (amount < 1) return "The smallest trade is $1.";
        if (amount / bid > Number(held)) return `You hold ${quantity(Number(held))} ${asset.unit} of ${asset.name} (about ${usd(Number(held) * bid)}). Try SELL ${asset.aliases[0]} ALL.`;
        if (amount > left) return `That's over your daily limit: ${usd(Math.max(0, left))} left today.`;
        pending = { side, symbol: asset.symbol, dollars, indicative, tradeRef };
        restated = `Sell ${usd(amount)} of ${asset.name} at about ${price(bid)}/${asset.unit}`;
      }
    }
    this.db.putPending(user.id, "trade", pending, Date.now() + CONFIRM_TTL_MS);
    return `${restated}? Reply YES and your PIN within 2 min to confirm, NO to cancel. Ref ${tradeRef}`;
  }

  private async confirmTrade(user: User, pin: string): Promise<string> {
    const pendingRow = this.db.pending(user.id);
    if (!pendingRow || pendingRow.expires_at < Date.now()) {
      if (pendingRow) this.db.deletePending(user.id);
      return "Nothing to confirm. Confirmations expire after 2 minutes; text BUY, SELL or WITHDRAW to start again.";
    }
    if (user.pin_locked_until > Date.now()) {
      return `Too many wrong PINs. Trading is paused until ${new Date(user.pin_locked_until).toISOString().slice(11, 16)} UTC.`;
    }
    if (!secrets.verifyPin(pin, user.pin_hash)) {
      const failures = user.pin_failures + 1;
      if (failures >= PIN_MAX_FAILURES) {
        this.db.setPinState(user.id, 0, Date.now() + PIN_LOCK_MS);
        this.db.deletePending(user.id);
        this.db.addActivity(user.id, "Trading paused for 15 minutes after 3 wrong PINs");
        return "Wrong PIN 3 times. Trading is paused for 15 minutes and nothing was traded.";
      }
      this.db.setPinState(user.id, failures, 0);
      return `Wrong PIN. ${PIN_MAX_FAILURES - failures} ${PIN_MAX_FAILURES - failures === 1 ? "try" : "tries"} left.`;
    }
    this.db.setPinState(user.id, 0, 0);
    this.db.deletePending(user.id);
    if (pendingRow.kind === "withdraw") return this.executeWithdrawal(user, JSON.parse(pendingRow.payload) as PendingWithdrawal);
    const pending = JSON.parse(pendingRow.payload) as PendingTrade;
    return this.executeTrade(user, pending);
  }

  // ==========================================================================
  // Money in and out (LocalNet: the demo bank; MainNet: a payment provider + a licensed exchange)
  // ==========================================================================

  /** The user's personal deposit account number, created on first use. */
  virtualAccount(user: User): string {
    let account = this.db.virtualAccount(user.id);
    if (!account) {
      do account = newVirtualAccountNumber(); while (this.db.userByVirtualAccount(account));
      this.db.putVirtualAccount(account, user.id);
    }
    return account;
  }

  private async depositInstructions(user: User): Promise<string> {
    const rates = await nairaRates();
    return `To add money, send naira to ${DEMO_BANK}, account ${this.virtualAccount(user)} (PrivateLine ${user.account_id}), from your bank app or USSD. Rate: ${naira(rates.deposit)} = $1. We'll text you when it lands.`;
  }

  /**
   * A naira transfer landed in a user's deposit account: convert it at the current rate and credit
   * the dollars, approved 2 of 3. Idempotent per transfer reference, since providers retry.
   */
  async receivePayment(transfer: IncomingTransfer): Promise<void> {
    if (this.db.deposit(transfer.reference)) return;
    const user = this.db.userByVirtualAccount(transfer.toAccount);
    if (!user) {
      this.log(`payment ${transfer.reference} to unknown account ${transfer.toAccount}`);
      return;
    }
    const rates = await nairaRates();
    const dollars = dollarsForNaira(transfer.naira, rates);
    const deposit = { reference: transfer.reference, user_id: user.id, naira: transfer.naira, dollars, rate: rates.deposit, status: "received", at: Date.now() };
    this.db.putDeposit(deposit);
    // Withdrawals only ever go back to a bank account that has funded this wallet.
    this.db.putFundingSource({ user_id: user.id, bank: transfer.sender.bank, account_number: transfer.sender.account, name: transfer.sender.name, last_used: Date.now() });
    const phone = secrets.decryptPhone(user.phone_enc);
    if (dollars < 1 || dollars > this.policy.maxDeposit) {
      this.db.putDeposit({ ...deposit, status: "review" });
      this.db.addActivity(user.id, `Deposit of ${naira(transfer.naira)} held for review (outside $1-$${this.policy.maxDeposit})`);
      await this.send(phone, `We received ${naira(transfer.naira)}. Deposits must be between $1 and $${this.policy.maxDeposit}, so our team will review this one. Ref ${transfer.reference.slice(-6)}`);
      return;
    }
    await this.creditDeposit(user, deposit);
  }

  private async creditDeposit(user: User, deposit: { reference: string; naira: number; dollars: number; rate: number; status: string; at: number; user_id: string }): Promise<boolean> {
    const account = await this.account(user);
    const outcome = await this.options.operator.deposit({ accountCid: account.contractId, accountId: user.account_id, amount: deposit.dollars });
    const phone = secrets.decryptPhone(user.phone_enc);
    if (!outcome.ok) {
      this.db.putDeposit({ ...deposit, status: "retry" });
      this.log(`deposit ${deposit.reference} not credited yet: ${outcome.reason}`);
      return false;
    }
    this.db.putDeposit({ ...deposit, status: "credited" });
    const cash = balancesOf((await this.account(user)).payload).USD ?? 0;
    this.db.addActivity(user.id, `Deposit: ${naira(deposit.naira)} = ${usd(deposit.dollars)} at ${naira(deposit.rate)}/$ (approved 2 of 3 in ${(outcome.elapsedMs / 1000).toFixed(1)}s)`);
    await this.send(phone, `Received ${naira(deposit.naira)} = ${usd(deposit.dollars)} at ${naira(deposit.rate)}/$. Cash ${usd(cash)}. Text BUY GOLD 10 to invest.`);
    return true;
  }

  private async startWithdrawal(user: User, dollars: string | undefined, all: boolean): Promise<string> {
    const payout = this.db.payoutAccount(user.id);
    if (!payout) return "Withdrawals go back to the bank account you deposited from. Text DEPOSIT to add money first.";
    const cash = balancesOf((await this.account(user)).payload).USD ?? 0;
    const amount = all ? Math.floor(cash * 100) / 100 : Number(dollars);
    if (amount < 1) return all ? "You have less than $1 in cash. Text BAL to see your account." : "The smallest withdrawal is $1.";
    if (amount > cash + 1e-9) return `You have ${usd(cash)} in cash. Sell first (e.g. SELL GOLD ALL) or withdraw less.`;
    if (amount > this.policy.maxWithdrawal) return `The largest single withdrawal is ${usd(this.policy.maxWithdrawal)}.`;
    const rates = await nairaRates();
    const pending: PendingWithdrawal = {
      dollars: amount,
      naira: nairaForDollars(amount, rates),
      rate: rates.withdraw,
      bank: payout.bank,
      account: payout.account_number,
      name: payout.name,
      ref: `W${randomBytes(2).toString("hex").toUpperCase()}`,
    };
    this.db.putPending(user.id, "withdraw", pending, Date.now() + CONFIRM_TTL_MS);
    return `Withdraw ${usd(amount)} = ${naira(pending.naira)} (${naira(pending.rate)}/$) to ${payout.bank} ${maskAccount(payout.account_number)} (${payout.name})? Reply YES and your PIN within 2 min, NO to cancel. Ref ${pending.ref}`;
  }

  private async executeWithdrawal(user: User, pending: PendingWithdrawal): Promise<string> {
    const account = await this.account(user);
    const outcome = await this.options.operator.payOut({
      accountCid: account.contractId,
      accountId: user.account_id,
      amount: pending.dollars,
      payoutRef: `${pending.bank} ${maskAccount(pending.account)}`,
    });
    if (!outcome.ok) {
      this.db.addActivity(user.id, `${pending.ref}: withdrawal of ${usd(pending.dollars)} not done: ${outcome.reason}`);
      return `Not done: ${explainForUser(outcome.reason ?? "it was not approved", assetBySymbol("SPYe"))}. No money moved. Ref ${pending.ref}`;
    }
    // LocalNet: the demo bank pays the naira. MainNet: the exchange sells USDCx and the provider pays out.
    this.db.addDemoBankEntry({ account_number: pending.account, direction: "in", counterparty: `PrivateLine ${user.account_id}`, naira: pending.naira, reference: pending.ref });
    const cash = balancesOf((await this.account(user)).payload).USD ?? 0;
    this.db.addActivity(user.id, `${pending.ref}: withdrew ${usd(pending.dollars)} = ${naira(pending.naira)} to ${pending.bank} ${maskAccount(pending.account)} (approved 2 of 3 in ${(outcome.elapsedMs / 1000).toFixed(1)}s)`);
    return `Done: sent ${naira(pending.naira)} to ${pending.bank} ${maskAccount(pending.account)}. Cash ${usd(cash)}. Ref ${pending.ref}`;
  }

  /** The demo bank: a transfer from someone's bank account to a PrivateLine deposit account. */
  async demoBankTransfer(fields: { toAccount: string; naira: number; senderBank: string; senderAccount: string; senderName: string }): Promise<{ reference: string }> {
    if (!/^\d{10}$/.test(fields.toAccount)) throw new UserError("The account number must be 10 digits.");
    if (!/^\d{10}$/.test(fields.senderAccount)) throw new UserError("Your account number must be 10 digits.");
    if (!(fields.naira >= 100 && fields.naira <= 5_000_000)) throw new UserError("Send between N100 and N5,000,000.");
    if (!this.db.userByVirtualAccount(fields.toAccount)) throw new UserError("No PrivateLine account has that deposit number. Text DEPOSIT to get yours.");
    const reference = `DEMO-${Date.now()}-${randomBytes(3).toString("hex")}`;
    // Same path as a real provider: a signed notification, verified and parsed before we act on it.
    const raw = demoTransferEvent({ ...fields, reference });
    const transfer = parsePaymentEvent(raw, signPayment(raw, this.options.paymentsSecret), this.options.paymentsSecret);
    if (!transfer) throw new Error("demo transfer produced no payment");
    this.db.addDemoBankEntry({ account_number: fields.senderAccount, direction: "out", counterparty: `${DEMO_BANK} ${fields.toAccount}`, naira: fields.naira, reference });
    void this.receivePayment(transfer).catch((error: unknown) => this.log(`payment ${reference} failed: ${error instanceof Error ? error.message : error}`));
    return { reference };
  }

  demoBankStatement(account: string) {
    if (!/^\d{10}$/.test(account)) throw new UserError("The account number must be 10 digits.");
    return this.db.demoBankStatement(account);
  }

  /** Credit deposits whose approval failed earlier (for example while a checker was offline). */
  async retryDeposits(): Promise<void> {
    for (const deposit of this.db.depositsWithStatus("retry")) {
      const user = this.db.userById(deposit.user_id);
      if (user) await this.creditDeposit(user, deposit);
    }
  }

  private async executeTrade(user: User, pending: PendingTrade): Promise<string> {
    const asset = assetBySymbol(pending.symbol);
    const account = await this.account(user);
    const limitPrice = pending.side === "Buy" ? pending.indicative * (1 + SLIPPAGE) : pending.indicative * (1 - SLIPPAGE);
    const result = await this.options.operator.trade({
      accountCid: account.contractId,
      accountId: user.account_id,
      symbol: asset.symbol,
      side: pending.side,
      amount: pending.units ? { tag: "Units", value: pending.units } : { tag: "Dollars", value: pending.dollars! },
      limitPrice,
      tradeRef: pending.tradeRef,
    });
    if (!result.ok || !result.fill) {
      const why = explainForUser(result.reason ?? "it was not approved", asset);
      this.db.addActivity(user.id, `${pending.tradeRef}: ${pending.side.toLowerCase()} ${asset.name} not done: ${result.reason}`);
      return `Not done: ${why}. No money moved. Ref ${pending.tradeRef}`;
    }
    const fill = result.fill;
    const after = balancesOf((await this.account(user)).payload);
    const verb = pending.side === "Buy" ? "bought" : "sold";
    const summary = `${verb} ${quantity(Number(fill.units))} ${asset.unit} ${asset.name} for ${usd(Number(fill.dollars))} at ${price(Number(fill.price))}/${asset.unit}`;
    this.db.addActivity(user.id, `${pending.tradeRef}: ${summary} (approved 2 of 3 in ${(result.elapsedMs / 1000).toFixed(1)}s)`);
    return `Done: ${summary}. Cash ${usd(after.USD ?? 0)}. Ref ${pending.tradeRef}`;
  }

  private async cancel(user: User): Promise<string> {
    if (this.db.pending(user.id)) {
      this.db.deletePending(user.id);
      return "Cancelled. Nothing was traded.";
    }
    const change = this.db.phoneChange(user.id);
    if (change) {
      await this.options.operator.withdraw(change.proposal_cid);
      this.db.deletePhoneChange(user.id);
      this.db.addActivity(user.id, "Phone change stopped from the current phone (NO)");
      return "Stopped: your account stays on this phone. If you didn't ask for a change, sign in and check your account.";
    }
    return "Nothing to cancel.";
  }

  // ==========================================================================
  // Sign-up and sign-in (website)
  // ==========================================================================

  private issueCode(purpose: string, target: string, payload?: string): string {
    const code = secrets.newCode();
    this.db.putCode(purpose, target, secrets.hashCode(purpose, code), Date.now() + CODE_TTL_MS, payload);
    return code;
  }

  /** Check a code; on success it is used up and its payload returned. */
  private checkCode(purpose: string, target: string, code: string): string | null {
    const stored = this.db.code(purpose, target);
    if (!stored || stored.expires_at < Date.now()) throw new UserError("That code has expired. Ask for a new one.");
    if (stored.attempts >= CODE_MAX_ATTEMPTS) throw new UserError("Too many wrong codes. Ask for a new one.");
    if (secrets.hashCode(purpose, code.trim()) !== stored.code_hash) {
      this.db.bumpCodeAttempts(purpose, target);
      throw new UserError("That code isn't right.");
    }
    this.db.deleteCode(purpose, target);
    return stored.payload;
  }

  private deliverEmailCode(email: string, code: string): { devCode?: string } {
    // LocalNet demo: no mail provider is configured, so the code is shown on screen and logged.
    this.log(`[email to ${email}] PrivateLine code ${code}`);
    return { devCode: code };
  }

  async startSignup(emailInput: string): Promise<{ devCode?: string }> {
    const email = normalizeEmail(emailInput);
    if (this.db.userByEmail(email)) throw new UserError("That email already has an account. Sign in instead.");
    return this.deliverEmailCode(email, this.issueCode("signup-email", email));
  }

  async verifySignupEmail(emailInput: string, code: string): Promise<{ signupToken: string }> {
    const email = normalizeEmail(emailInput);
    this.checkCode("signup-email", email, code);
    const signupToken = secrets.newToken();
    this.db.putSignup(secrets.hashToken(signupToken), email, Date.now() + SIGNUP_TTL_MS);
    return { signupToken };
  }

  private signupFor(token: string) {
    const signup = this.db.signup(secrets.hashToken(token));
    if (!signup || signup.expires_at < Date.now()) throw new UserError("Your sign-up expired. Please start again.");
    return signup;
  }

  async signupPhone(token: string, phoneInput: string): Promise<{ phone: string; simulator: boolean }> {
    this.signupFor(token);
    let e164: string;
    try {
      e164 = normalizeE164(phoneInput);
    } catch {
      throw new UserError("That doesn't look like a phone number. Include the country code, e.g. +234 803 123 4567.");
    }
    if (!isSimulatorPhone(e164) && !this.options.gateway.hasRealGateway) {
      throw new UserError("This demo can only text simulator phones: use a +999 number and the phone on the Try it page.");
    }
    const lookup = secrets.phoneLookup(e164);
    if (this.db.userByPhone(lookup)) throw new UserError("That phone number already has an account.");
    this.db.setSignupPhone(secrets.hashToken(token), secrets.encryptPhone(e164), lookup);
    const code = this.issueCode("signup-phone", lookup);
    await this.options.gateway.send(e164, `PrivateLine code: ${code}. It expires in 10 minutes. Never share it.`);
    return { phone: maskPhone(e164), simulator: isSimulatorPhone(e164) };
  }

  async verifySignupPhone(token: string, code: string): Promise<void> {
    const signup = this.signupFor(token);
    if (!signup.phone_lookup) throw new UserError("Add your phone number first.");
    this.checkCode("signup-phone", signup.phone_lookup, code);
    this.db.markSignupPhoneVerified(secrets.hashToken(token));
  }

  /** Create the user's party and open the account (2 of 3 operators approve). */
  async finishSignup(token: string, pin: string): Promise<{ sessionToken: string; accountId: string }> {
    const signup = this.signupFor(token);
    if (!signup.phone_enc || !signup.phone_lookup || !signup.phone_verified) throw new UserError("Verify your phone number first.");
    checkPinStrength(pin);
    let accountId: string;
    do accountId = `pl-${randomBytes(2).toString("hex")}`; while (this.db.allUsers().some((user) => user.account_id === accountId));
    const phone = secrets.decryptPhone(signup.phone_enc);
    const party = await this.options.operatorLedger.allocateParty(accountId);
    const outcome = await this.options.operator.openAccount({
      user: party,
      accountId,
      phoneTag: secrets.phoneTag(phone),
      dailyLimit: this.options.dailyLimit,
      startingDollars: this.options.startingDollars,
    });
    if (!outcome.ok) throw new UserError(`The operators didn't approve the account: ${outcome.reason}`);
    const user: User = {
      id: randomUUID(),
      email: signup.email,
      phone_lookup: signup.phone_lookup,
      phone_enc: signup.phone_enc,
      phone_tag: secrets.phoneTag(phone),
      pin_hash: secrets.hashPin(pin),
      party,
      account_id: accountId,
      created_at: Date.now(),
      pin_failures: 0,
      pin_locked_until: 0,
      locked: 0,
    };
    this.db.insertUser(user);
    this.db.deleteSignup(secrets.hashToken(token));
    this.db.addActivity(user.id, `Account ${accountId} opened with ${usd(this.options.startingDollars)} in demo dollars (approved 2 of 3 in ${(outcome.elapsedMs / 1000).toFixed(1)}s)`);
    await this.send(phone, `Welcome to PrivateLine! You have ${usd(this.options.startingDollars)} in demo dollars. Text BAL, PRICE GOLD or BUY GOLD 10. Every trade needs YES + your PIN.`);
    this.log(`account ${accountId} opened`);
    return { sessionToken: this.newSession(user.id), accountId };
  }

  async startSignin(emailInput: string): Promise<{ devCode?: string }> {
    const email = normalizeEmail(emailInput);
    if (!this.db.userByEmail(email)) throw new UserError("No account uses that email. Sign up instead.");
    return this.deliverEmailCode(email, this.issueCode("signin", email));
  }

  async finishSignin(emailInput: string, code: string): Promise<{ sessionToken: string }> {
    const email = normalizeEmail(emailInput);
    this.checkCode("signin", email, code);
    const user = this.db.userByEmail(email)!;
    return { sessionToken: this.newSession(user.id) };
  }

  private newSession(userId: string): string {
    const token = secrets.newToken();
    this.db.putSession(secrets.hashToken(token), userId, Date.now() + SESSION_TTL_MS);
    return token;
  }

  userForSession(token: string | undefined): User | undefined {
    return token ? this.db.sessionUser(secrets.hashToken(token), Date.now()) : undefined;
  }

  signOut(token: string): void {
    this.db.deleteSession(secrets.hashToken(token));
  }

  // ==========================================================================
  // Account page
  // ==========================================================================

  async accountView(user: User) {
    const account = await this.account(user);
    const { cash, items, total } = await this.holdings(account.payload);
    const today = new Date().toISOString().slice(0, 10);
    const change = this.db.phoneChange(user.id);
    return {
      accountId: user.account_id,
      email: user.email,
      phone: maskPhone(secrets.decryptPhone(user.phone_enc)),
      locked: user.locked === 1,
      cash,
      holdings: items.map((item) => ({ symbol: item.asset.symbol, name: item.asset.name, unit: item.asset.unit, units: item.unitsText, price: item.price, value: item.value })),
      total,
      dailyLimit: Number(account.payload.dailyLimit),
      spentToday: account.payload.spentOn === today ? Number(account.payload.spentToday) : 0,
      alerts: this.db.alerts(user.id).map((alert) => ({ name: assetBySymbol(alert.symbol).name, pct: alert.pct })),
      activity: this.db.activity(user.id),
      phoneChange: change ? { readyAt: change.ready_at, phone: maskPhone(secrets.decryptPhone(change.new_phone_enc)) } : null,
      pinPausedUntil: user.pin_locked_until > Date.now() ? user.pin_locked_until : null,
      funding: await (async () => {
        const rates = await nairaRates();
        const payout = this.db.payoutAccount(user.id);
        return {
          bank: DEMO_BANK,
          accountNumber: this.virtualAccount(user),
          depositRate: rates.deposit,
          withdrawRate: rates.withdraw,
          marketRate: rates.mid,
          rateSource: rates.source,
          payout: payout ? { bank: payout.bank, account: maskAccount(payout.account_number), name: payout.name } : null,
        };
      })(),
    };
  }

  unlock(user: User): void {
    this.db.setLocked(user.id, false);
    this.db.addActivity(user.id, "Account unlocked on the website");
  }

  lock(user: User): void {
    this.db.setLocked(user.id, true);
    this.db.deletePending(user.id);
    this.db.addActivity(user.id, "Account locked on the website");
  }

  /** Send a code to the new phone; the change starts once the code comes back. */
  async requestPhoneChange(user: User, phoneInput: string): Promise<{ phone: string }> {
    let e164: string;
    try {
      e164 = normalizeE164(phoneInput);
    } catch {
      throw new UserError("That doesn't look like a phone number.");
    }
    if (!isSimulatorPhone(e164) && !this.options.gateway.hasRealGateway) throw new UserError("This demo can only text +999 simulator phones.");
    const lookup = secrets.phoneLookup(e164);
    if (lookup === user.phone_lookup) throw new UserError("That's already your phone number.");
    if (this.db.userByPhone(lookup)) throw new UserError("That phone number belongs to another account.");
    const code = this.issueCode("phone-change", user.id, JSON.stringify({ enc: secrets.encryptPhone(e164), lookup }));
    await this.options.gateway.send(e164, `PrivateLine code: ${code}. It moves your account to this phone. Never share it.`);
    return { phone: maskPhone(e164) };
  }

  async confirmPhoneChange(user: User, code: string): Promise<{ readyAt: number }> {
    const payload = this.checkCode("phone-change", user.id, code);
    const { enc, lookup } = JSON.parse(payload ?? "{}") as { enc: string; lookup: string };
    const newPhone = secrets.decryptPhone(enc);
    const account = await this.account(user);
    const cooldown = this.options.phoneChangeCooldownSeconds;
    const proposalCid = await this.options.operator.requestPhoneChange({
      accountCid: account.contractId,
      accountId: user.account_id,
      newPhoneTag: secrets.phoneTag(newPhone),
      cooldownSeconds: cooldown,
    });
    const readyAt = Date.now() + cooldown * 1000;
    this.db.putPhoneChange({ user_id: user.id, proposal_cid: proposalCid, new_phone_enc: enc, new_phone_lookup: lookup, new_phone_tag: secrets.phoneTag(newPhone), ready_at: readyAt });
    this.db.addActivity(user.id, `Phone change to ${maskPhone(newPhone)} requested; it can happen after ${new Date(readyAt).toISOString().slice(0, 16).replace("T", " ")} UTC`);
    const oldPhone = secrets.decryptPhone(user.phone_enc);
    await this.send(oldPhone, `PrivateLine: your account will move to a new phone (${maskPhone(newPhone)}) at ${new Date(readyAt).toISOString().slice(11, 16)} UTC. Not you? Reply NO to stop it.`);
    return { readyAt };
  }

  // ==========================================================================
  // Privacy view: what each kind of party can see of this account, read live from the ledger
  // ==========================================================================

  private async probeParty(): Promise<string> {
    this.privacyProbe ??= await this.options.operatorLedger.ensureParty("privacy-probe");
    return this.privacyProbe;
  }

  async privacyView(user: User) {
    const ledger = this.options.operatorLedger;
    const { vault, desk } = this.options.deployment;
    const mine = await this.account(user);
    const probe = await this.probeParty();
    const count = async (party: string, templateId: string, onLedger: Ledger = ledger) => (await onLedger.query(party, templateId)).length;

    const deskFills = await this.options.deskLedger.query<Fill>(desk, templates.fill);
    const deskHoldings = await this.options.deskLedger.query<DemoHolding>(desk, templates.demoHolding);
    const vaultAccounts = await ledger.query<Account>(vault, templates.account);
    const trades = await ledger.query<TradeProposal>(vault, templates.tradeProposal);
    const refusals = await ledger.query<CheckRefusal>(vault, templates.checkRefusal);
    const records = await ledger.query<ExecutionResult>(vault, templates.executionResult);

    return {
      you: {
        party: user.party,
        account: { contractId: mine.contractId, signatories: mine.signatories, observers: mine.observers, fields: mine.payload },
      },
      otherUser: {
        party: probe,
        accounts: await count(probe, templates.account),
        trades: await count(probe, templates.tradeProposal),
        fills: await count(probe, templates.fill),
        approvals: await count(probe, templates.executionResult),
        refusals: await count(probe, templates.checkRefusal),
      },
      desk: {
        party: desk,
        accounts: await count(desk, templates.account, this.options.deskLedger),
        trades: await count(desk, templates.tradeProposal, this.options.deskLedger),
        fills: deskFills.map((fill) => ({ symbol: fill.payload.symbol, side: fill.payload.side, units: fill.payload.units, dollars: fill.payload.dollars, tradeRef: fill.payload.tradeRef })),
        vaultHoldings: Object.entries(deskHoldings
          .filter((holding) => holding.payload.owner === vault)
          .reduce<Record<string, number>>((totals, holding) => {
            totals[holding.payload.symbol] = (totals[holding.payload.symbol] ?? 0) + Number(holding.payload.amount);
            return totals;
          }, {}))
          .map(([symbol, amount]) => ({ symbol, amount: String(Math.round(amount * 1e10) / 1e10) })),
      },
      operators: {
        vault,
        accounts: vaultAccounts.map((account) => ({ accountId: account.payload.accountId, phoneTag: account.payload.phoneTag, holdings: account.payload.balances.length })),
        pendingTrades: trades.length,
        refusals: refusals.length,
        approvals: records.filter((record) => record.payload.actionLabel.startsWith("PrivateLine")).length,
      },
      offLedger: {
        email: user.email,
        phoneEncrypted: `${user.phone_enc.slice(0, 18)}...`,
        phoneLookup: `${user.phone_lookup.slice(0, 16)}...`,
        pinHash: `${user.pin_hash.slice(0, 18)}...`,
      },
    };
  }

  // ==========================================================================
  // Background jobs
  // ==========================================================================

  /** Text users whose alert assets moved at least their threshold since the last alert. */
  async runAlerts(): Promise<void> {
    for (const alert of this.db.alerts()) {
      const user = this.db.userById(alert.user_id);
      if (!user || user.locked) continue;
      const asset = assetBySymbol(alert.symbol);
      const { mid } = await this.options.desk.indicative(alert.symbol);
      const change = mid / alert.base_price - 1;
      if (Math.abs(change) * 100 < alert.pct) continue;
      await this.send(secrets.decryptPhone(user.phone_enc),
        `PrivateLine alert: ${asset.name} is ${change >= 0 ? "up" : "down"} ${Math.abs(change * 100).toFixed(1)}% to ${price(mid)}/${asset.unit} since ${price(alert.base_price)}. PRICE ${asset.aliases[0]} for details. ALERTS OFF to stop.`);
      this.db.putAlert({ ...alert, base_price: mid });
      this.db.addActivity(user.id, `Alert sent: ${asset.name} ${signedPct(change)}`);
    }
  }

  /** Finish phone changes whose cooldown has passed and that 2 of 3 operators confirmed. */
  async runPhoneChanges(): Promise<void> {
    for (const change of this.db.phoneChanges()) {
      if (Date.now() < change.ready_at) continue;
      const status = await this.options.operator.executeIfReady(change.proposal_cid);
      if (status === "waiting") continue;
      const user = this.db.userById(change.user_id);
      this.db.deletePhoneChange(change.user_id);
      if (!user) continue;
      const account = await this.account(user).catch(() => undefined);
      if (status === "executed" || account?.payload.phoneTag === change.new_phone_tag) {
        this.db.setPhone(user.id, change.new_phone_lookup, change.new_phone_enc, change.new_phone_tag);
        this.db.addActivity(user.id, "Phone change completed (approved 2 of 3 after the cooldown)");
        await this.send(secrets.decryptPhone(change.new_phone_enc), "PrivateLine: your account now uses this phone. Your PIN is unchanged. Text BAL to check.");
      }
    }
  }

  startJobs(): void {
    const every = (label: string, ms: number, job: () => Promise<unknown>) => {
      const loop = async () => {
        try {
          await job();
        } catch (error) {
          this.log(`${label} job failed: ${error instanceof Error ? error.message : error}`);
        }
        setTimeout(loop, ms);
      };
      setTimeout(loop, ms);
    };
    every("alerts", 60_000, () => this.runAlerts());
    every("phone changes", 10_000, () => this.runPhoneChanges());
    every("settlement", Number(process.env.SETTLE_INTERVAL_MS ?? 5 * 60_000), async () => {
      const outcome = await this.options.operator.settle();
      if (outcome) this.log(`settlement ${outcome.ok ? "done" : `not done: ${outcome.reason}`}`);
    });
    every("quote clean-up", 5 * 60_000, () => this.options.desk.archiveExpired());
    every("deposit retries", 60_000, () => this.retryDeposits());
  }
}

function normalizeEmail(input: string): string {
  const email = input.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new UserError("That doesn't look like an email address.");
  return email;
}

function checkPinStrength(pin: string): void {
  if (!/^\d{4,6}$/.test(pin)) throw new UserError("Your PIN must be 4 to 6 digits.");
  const sequential = "01234567890".includes(pin) || "09876543210".includes(pin);
  if (/^(\d)\1+$/.test(pin) || sequential) throw new UserError("That PIN is too easy to guess. Avoid repeated or sequential digits.");
}

/** Turn a checker's or the ledger's reason into a short SMS explanation. */
export function explainForUser(reason: string, asset: Asset): string {
  const gap = /is ([\d.]+)% (above|below) the market price/.exec(reason);
  if (gap) {
    const direction = gap[2] === "above" ? "more" : "less";
    return `${asset.name} costs ${gap[1]}% ${direction} on Canton than on the market right now, so our independent price checkers refused it`;
  }
  // Before the "not enough" balance check: this reason also contains those words.
  if (/in time/.test(reason)) return "not enough operators approved it in time (2 of 3 are needed)";
  if (/daily limit/.test(reason)) return "it would go over your daily limit";
  if (/per-trade limit/.test(reason)) return "it's over the per-trade limit";
  if (/quote expired|quote no longer exists/.test(reason)) return "the price quote expired before approval";
  if (/price moved/.test(reason)) return "the price moved more than 1% from the one you confirmed";
  if (/not enough|doesn't hold enough/.test(reason)) return "you don't have enough for it";
  if (/account changed/.test(reason)) return "your account changed while it was being approved; please try again";
  if (/withdrawal needs|withdrawal over/.test(reason)) return "the vault couldn't release the dollars right now; please try again shortly";
  return reason;
}
