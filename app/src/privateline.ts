// Template ids and payload shapes of PrivateLine's Daml package (daml/privateline), plus the
// governance-core templates we read. Ids use the package-name reference format.

const pkg = "#privateline-v0";

export const templates = {
  account: `${pkg}:PrivateLine.Account:Account`,
  demoHolding: `${pkg}:PrivateLine.Holding:DemoHolding`,
  quote: `${pkg}:PrivateLine.Desk:Quote`,
  fill: `${pkg}:PrivateLine.Desk:Fill`,
  deskAgreement: `${pkg}:PrivateLine.Desk:DeskAgreement`,
  demoFaucet: `${pkg}:PrivateLine.Desk:DemoFaucet`,
  openAccountProposal: `${pkg}:PrivateLine.Actions:OpenAccountProposal`,
  depositProposal: `${pkg}:PrivateLine.Actions:DepositProposal`,
  tradeProposal: `${pkg}:PrivateLine.Actions:TradeProposal`,
  settleProposal: `${pkg}:PrivateLine.Actions:SettleProposal`,
  changePhoneProposal: `${pkg}:PrivateLine.Actions:ChangePhoneProposal`,
  withdrawProposal: `${pkg}:PrivateLine.Actions:WithdrawProposal`,
  checkRefusal: `${pkg}:PrivateLine.Checks:CheckRefusal`,
  governableAction: "#governance-action-v1:Governance.Action:GovernableAction",
  governanceRules: "#governance-core-v1:Governance.Rules:GovernanceRules",
  executionResult: "#governance-core-v1:Governance.ExecutionResult:GovernanceExecutionResult",
} as const;

/** Symbol of the demo dollar (stands in for USDCx). */
export const DOLLAR = "USD";

export type Side = "Buy" | "Sell";
export type TradeAmount = { tag: "Dollars"; value: string } | { tag: "Units"; value: string };

export interface Account {
  vault: string;
  user: string;
  accountId: string;
  phoneTag: string;
  /** DA.Map Text Decimal, encoded as [symbol, amount] pairs. */
  balances: [string, string][];
  dailyLimit: string;
  spentToday: string;
  spentOn: string;
}

export interface Quote {
  desk: string;
  vault: string;
  symbol: string;
  bid: string;
  ask: string;
  source: string;
  quotedAt: string;
  validUntil: string;
}

export interface Fill {
  desk: string;
  vault: string;
  symbol: string;
  side: Side;
  units: string;
  price: string;
  dollars: string;
  tradeRef: string;
  filledAt: string;
}

export interface TradeProposal {
  vault: string;
  proposer: string;
  accountCid: string;
  accountId: string;
  quoteCid: string;
  symbol: string;
  side: Side;
  amount: TradeAmount;
  limitPrice: string;
  tradeRef: string;
}

export interface OpenAccountProposal {
  vault: string;
  proposer: string;
  user: string;
  accountId: string;
  dailyLimit: string;
  startingDollars: string;
}

export interface DepositProposal {
  accountCid: string;
  accountId: string;
  amount: string;
}

export interface WithdrawProposal {
  accountCid: string;
  accountId: string;
  amount: string;
  vaultHoldings: string[];
  payoutRef: string;
}

export interface SettleProposal {
  fills: string[];
  vaultHoldings: string[];
  batchRef: string;
}

export interface ChangePhoneProposal {
  accountCid: string;
  accountId: string;
  newPhoneTag: string;
  requestedAt: string;
  /** DA.Time RelTime. */
  cooldown: { microseconds: string };
}

export interface CheckRefusal {
  vault: string;
  checker: string;
  proposalCid: string;
  actionLabel: string;
  reason: string;
  refusedAt: string;
}

export interface DemoHolding {
  issuer: string;
  owner: string;
  symbol: string;
  amount: string;
}

export interface GovernanceRules {
  governanceParty: string;
  /** DA.Set Party, encoded as a record around a map of party to unit. */
  members: { map: [string, unknown][] };
  threshold: string;
}

export interface ExecutionResult {
  governanceParty: string;
  actionLabel: string;
  description: string;
  executor: string;
  confirmers: string[];
  executedAt: string;
}

export function balancesOf(account: Account): Record<string, number> {
  return Object.fromEntries(account.balances.map(([symbol, amount]) => [symbol, Number(amount)]));
}

/** Daml Decimal as a JSON string, rounded to Decimal's 10 places. */
export function decimal(value: number): string {
  return value.toFixed(10).replace(/0+$/, "").replace(/\.$/, ".0");
}
