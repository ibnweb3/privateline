// Naira per dollar. The market rate comes from a free daily feed (open.er-api.com, with a second
// source as backup, or NGN_PER_USD if both are down). Deposits and withdrawals apply the exchange
// partner's spread against the user, the way a licensed exchange (Busha, Quidax) would quote.

const SOURCES: { url: string; pick: (json: any) => number | undefined }[] = [
  { url: "https://open.er-api.com/v6/latest/USD", pick: (json) => json?.rates?.NGN },
  { url: "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json", pick: (json) => json?.usd?.ngn },
];
const CACHE_MS = 60 * 60_000;

export interface NairaRates {
  /** Market naira per dollar. */
  mid: number;
  /** Naira the user pays per dollar credited. */
  deposit: number;
  /** Naira the user receives per dollar withdrawn. */
  withdraw: number;
  source: string;
}

let cached: { at: number; mid: number; source: string } | undefined;

async function marketRate(): Promise<{ mid: number; source: string }> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached;
  for (const source of SOURCES) {
    try {
      const response = await fetch(source.url, { signal: AbortSignal.timeout(10_000) });
      const rate = response.ok ? source.pick(await response.json()) : undefined;
      if (rate && rate > 100 && rate < 100_000) {
        cached = { at: Date.now(), mid: rate, source: new URL(source.url).host };
        return cached;
      }
    } catch {
      // Try the next source.
    }
  }
  if (cached) return cached;
  const fallback = Number(process.env.NGN_PER_USD ?? 1500);
  return { mid: fallback, source: "fixed fallback rate" };
}

export async function nairaRates(): Promise<NairaRates> {
  const spread = Number(process.env.FX_SPREAD ?? 0.015);
  const { mid, source } = await marketRate();
  return { mid, deposit: mid * (1 + spread), withdraw: mid * (1 - spread), source };
}

/** Dollars credited for a naira deposit, rounded down to the cent. */
export function dollarsForNaira(naira: number, rates: NairaRates): number {
  return Math.floor((naira / rates.deposit) * 100) / 100;
}

/** Naira paid out for a dollar withdrawal, rounded down to the naira. */
export function nairaForDollars(dollars: number, rates: NairaRates): number {
  return Math.floor(dollars * rates.withdraw);
}

export function naira(value: number): string {
  return `N${Math.round(value).toLocaleString("en-US")}`;
}
