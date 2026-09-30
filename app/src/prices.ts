// Prices. The desk quotes from Cantex, where these tokens actually trade on Canton MainNet. The
// checkers compare against the real-world market (Yahoo Finance: SPY, QQQ, gold and silver
// futures, BTC and ETH), fetched independently. Replay mode serves a logged snapshot instead, so
// a past price drift can be shown on demand.

import { readFile } from "node:fs/promises";

export interface Asset {
  symbol: string;
  name: string;
  /** What one token represents, for SMS text ("oz", "share"). */
  unit: string;
  /** Words a user may text for it. */
  aliases: string[];
  /** Token symbol on Cantex. */
  cantexSymbol: string;
  /** Yahoo Finance symbol of the real-world reference. */
  marketSymbol: string;
}

export const ASSETS: Asset[] = [
  { symbol: "SPYe", name: "S&P 500", unit: "share", aliases: ["SPY", "SPYE", "SP500", "S&P", "S&P500", "SNP"], cantexSymbol: "SPYe", marketSymbol: "SPY" },
  { symbol: "QQQe", name: "Nasdaq 100", unit: "share", aliases: ["QQQ", "QQQE", "NASDAQ", "NDX"], cantexSymbol: "QQQe", marketSymbol: "QQQ" },
  { symbol: "eXAU", name: "Gold", unit: "oz", aliases: ["GOLD", "XAU", "EXAU"], cantexSymbol: "eXAU", marketSymbol: "GC=F" },
  { symbol: "eXAG", name: "Silver", unit: "oz", aliases: ["SILVER", "XAG", "EXAG"], cantexSymbol: "eXAG", marketSymbol: "SI=F" },
  { symbol: "cBTC", name: "Bitcoin", unit: "BTC", aliases: ["BTC", "BITCOIN", "CBTC"], cantexSymbol: "CBTC", marketSymbol: "BTC-USD" },
  { symbol: "cETH", name: "Ether", unit: "ETH", aliases: ["ETH", "ETHER", "ETHEREUM", "CETH"], cantexSymbol: "cETH", marketSymbol: "ETH-USD" },
];

export function findAsset(word: string): Asset | undefined {
  const key = word.trim().toUpperCase();
  return ASSETS.find((asset) => asset.symbol.toUpperCase() === key || asset.aliases.includes(key));
}

export function assetBySymbol(symbol: string): Asset {
  const asset = ASSETS.find((candidate) => candidate.symbol === symbol);
  if (!asset) throw new Error(`unknown asset ${symbol}`);
  return asset;
}

export interface PriceFeed {
  /** "live" or "replay 2026-09-26T06:38:14Z". */
  readonly label: string;
  /** Dollars per token on Cantex (pool mid price). */
  cantex(symbol: string): Promise<number>;
  /** Dollars per unit of the real-world asset. */
  market(symbol: string): Promise<number>;
}

const CANTEX_API = "https://api.cantex.io/v1/public";
const YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/";
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; PrivateLine/0.1)", Accept: "application/json" };
const CACHE_MS = 15_000;

/** GET JSON with up to 3 attempts: connections from here drop now and then. */
async function getJson<T>(url: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`${url} returned ${response.status}`);
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
  throw new Error(`${new URL(url).host} is unreachable: ${lastError instanceof Error ? lastError.message : lastError}`);
}

interface CantexPool {
  symbol: string;
  token_a_instrument: { admin: string; id: string };
  token_b_instrument: { admin: string; id: string };
  reserve_a: string;
  reserve_b: string;
}

/**
 * Dollar prices of every CC-paired Cantex token. Cantex pools all pair with Canton Coin (CC), so a
 * token's dollar price is its CC price times CC's dollar price from the CC-USDCx pool.
 */
export async function fetchCantexPrices(): Promise<Record<string, number>> {
  const [tokens, state] = await Promise.all([
    getJson<{ tokens: { info: { instrument_admin: string; instrument_id: string; symbol?: string } }[] }>(`${CANTEX_API}/tokens/info`),
    getJson<{ data: { pools: CantexPool[] } }>(`${CANTEX_API}/pools/state`),
  ]);
  const symbolOf = new Map(tokens.tokens.map((token) =>
    [`${token.info.instrument_admin}|${token.info.instrument_id}`, token.info.symbol ?? token.info.instrument_id]));
  const legs: { symbol: string; cc: number; asset: number }[] = [];
  for (const pool of state.data.pools) {
    const aIsCc = pool.token_a_instrument.id === "Amulet";
    const bIsCc = pool.token_b_instrument.id === "Amulet";
    if (aIsCc === bIsCc) continue;
    const other = aIsCc ? pool.token_b_instrument : pool.token_a_instrument;
    const cc = Number(aIsCc ? pool.reserve_a : pool.reserve_b);
    const asset = Number(aIsCc ? pool.reserve_b : pool.reserve_a);
    if (cc > 0 && asset > 0) legs.push({ symbol: symbolOf.get(`${other.admin}|${other.id}`) ?? other.id, cc, asset });
  }
  const usdcx = legs.find((leg) => leg.symbol === "USDCx");
  if (!usdcx) throw new Error("Cantex has no CC-USDCx pool to price CC in dollars");
  const ccUsd = usdcx.asset / usdcx.cc;
  return Object.fromEntries(legs.map((leg) => [leg.symbol, (leg.cc / leg.asset) * ccUsd]));
}

export async function fetchMarketPrice(marketSymbol: string): Promise<number> {
  const result = await getJson<{ chart: { result: { meta: { regularMarketPrice: number } }[] } }>(
    `${YAHOO_CHART}${encodeURIComponent(marketSymbol)}?interval=1d&range=1d`);
  const price = result.chart.result[0]?.meta.regularMarketPrice;
  if (!price) throw new Error(`no market price for ${marketSymbol}`);
  return price;
}

/** Live prices, cached for 15 seconds. Each checker creates its own feed, so each fetches independently. */
export function liveFeed(): PriceFeed {
  let cantexCache: { at: number; prices: Promise<Record<string, number>> } | undefined;
  const marketCache = new Map<string, { at: number; price: Promise<number> }>();
  return {
    label: "live",
    async cantex(symbol) {
      if (!cantexCache || Date.now() - cantexCache.at > CACHE_MS) {
        cantexCache = { at: Date.now(), prices: fetchCantexPrices() };
        cantexCache.prices.catch(() => { cantexCache = undefined; });
      }
      const price = (await cantexCache.prices)[assetBySymbol(symbol).cantexSymbol];
      if (!price) throw new Error(`Cantex has no price for ${symbol}`);
      return price;
    },
    async market(symbol) {
      const marketSymbol = assetBySymbol(symbol).marketSymbol;
      const cached = marketCache.get(marketSymbol);
      if (cached && Date.now() - cached.at <= CACHE_MS) return cached.price;
      const price = fetchMarketPrice(marketSymbol);
      marketCache.set(marketSymbol, { at: Date.now(), price });
      price.catch(() => marketCache.delete(marketSymbol));
      return price;
    },
  };
}

interface ReplaySnapshot {
  capturedAt: string;
  cantex: Record<string, number>;
  market: Record<string, number>;
}

/** Serve a logged snapshot, e.g. data/replay-2026-09-26T0638Z.json. */
export async function replayFeed(path: string | URL): Promise<PriceFeed> {
  const snapshot = JSON.parse(await readFile(path, "utf8")) as ReplaySnapshot;
  const pick = (table: Record<string, number>, symbol: string) => {
    const price = table[symbol];
    if (price === undefined) throw new Error(`the replay snapshot has no price for ${symbol}`);
    return price;
  };
  return {
    label: `replay ${snapshot.capturedAt}`,
    cantex: async (symbol) => pick(snapshot.cantex, symbol),
    market: async (symbol) => pick(snapshot.market, symbol),
  };
}

/** The feed chosen by PRICE_MODE: "live" (default) or "replay" (PRICE_REPLAY_FILE, default the Sep 26 snapshot). */
export async function feedFromEnv(): Promise<PriceFeed> {
  if (process.env.PRICE_MODE === "replay") {
    return replayFeed(process.env.PRICE_REPLAY_FILE ?? new URL("../data/replay-2026-09-26T0638Z.json", import.meta.url));
  }
  return liveFeed();
}
