// The rules the independent checkers apply before confirming a PrivateLine action. Both checkers
// run the same rules on their own data (their own ledger node and their own price fetch), so either
// one can complete an approval and either one can refuse. The contracts enforce the hard limits
// again at execution; these rules add the market-price check the contracts can't do on their own.

export interface Policy {
  /** Largest gap allowed between the desk's price and the real-world price, against the user. */
  priceTolerance: number;
  maxTradeDollars: number;
  maxStartingDollars: number;
  maxDailyLimit: number;
  maxDeposit: number;
  maxWithdrawal: number;
  /** Shortest cooldown a checker accepts on a phone change, in seconds. */
  minPhoneChangeCooldownSeconds: number;
}

export function policyFromEnv(): Policy {
  const number = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
  return {
    priceTolerance: number("PRICE_TOLERANCE", 0.015),
    maxTradeDollars: number("MAX_TRADE_DOLLARS", 500),
    maxStartingDollars: number("MAX_STARTING_DOLLARS", 100),
    maxDailyLimit: number("MAX_DAILY_LIMIT", 1000),
    maxDeposit: number("MAX_DEPOSIT", 1000),
    maxWithdrawal: number("MAX_WITHDRAWAL", 500),
    minPhoneChangeCooldownSeconds: number("PHONE_CHANGE_COOLDOWN_SECONDS", 24 * 3600),
  };
}

export type Verdict = { ok: true; note: string } | { ok: false; reason: string } | { wait: string };

const money = (value: number) =>
  `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: value >= 100 ? 2 : 4 })}`;
const percent = (value: number) => `${(value * 100).toFixed(2)}%`;

/**
 * Refuse a price that is worse for the user than the real-world price by more than the tolerance:
 * buying above the market, or selling below it. A price that favors the user passes.
 */
export function checkPrice(symbol: string, side: "Buy" | "Sell", price: number, market: number, tolerance: number): Verdict {
  const gap = price / market - 1;
  const against = side === "Buy" ? gap : -gap;
  const where = gap >= 0 ? "above" : "below";
  const quoted = `${symbol} ${side === "Buy" ? "ask" : "bid"} ${money(price)} is ${percent(Math.abs(gap))} ${where} the market price ${money(market)}`;
  return against > tolerance
    ? { ok: false, reason: `${quoted} (limit ${percent(tolerance)})` }
    : { ok: true, note: quoted };
}

export interface TradeFacts {
  symbol: string;
  side: "Buy" | "Sell";
  /** The desk's price for this side. */
  price: number;
  market: number;
  /** Dollars the trade moves at the desk's price. */
  dollars: number;
  units: number;
  quoteValidUntil: Date;
  now: Date;
  account: { balances: Record<string, number>; dailyLimit: number; spentToday: number; spentOn: string };
}

export function checkTrade(facts: TradeFacts, policy: Policy): Verdict {
  if (facts.now > facts.quoteValidUntil) return { ok: false, reason: `the ${facts.symbol} quote expired` };
  if (facts.dollars > policy.maxTradeDollars) {
    return { ok: false, reason: `${money(facts.dollars)} is over the ${money(policy.maxTradeDollars)} per-trade limit` };
  }
  const today = facts.now.toISOString().slice(0, 10);
  const spent = (facts.account.spentOn === today ? facts.account.spentToday : 0) + facts.dollars;
  if (spent > facts.account.dailyLimit) {
    return { ok: false, reason: `it would take today's trading to ${money(spent)}, over the ${money(facts.account.dailyLimit)} daily limit` };
  }
  const [spend, need] = facts.side === "Buy" ? ["USD", facts.dollars] : [facts.symbol, facts.units];
  if ((facts.account.balances[spend] ?? 0) < need - 1e-10) {
    return { ok: false, reason: `the account doesn't hold enough ${spend === "USD" ? "dollars" : spend}` };
  }
  return checkPrice(facts.symbol, facts.side, facts.price, facts.market, policy.priceTolerance);
}
