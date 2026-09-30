// The demo desk: quotes each token at its Cantex price plus a spread, valid for a minute. On
// LocalNet the desk is also the issuer of the mirror tokens it trades against the vault.

import type { Ledger } from "./ledger.ts";
import type { PriceFeed } from "./prices.ts";
import { decimal, templates, type Quote } from "./privateline.ts";

export interface QuoteInfo {
  quoteCid: string;
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  validUntil: Date;
}

export class Desk {
  private readonly ledger: Ledger;
  private readonly desk: string;
  private readonly vault: string;
  private readonly feed: PriceFeed;
  readonly spread: number;
  readonly validityMs: number;

  constructor(options: { ledger: Ledger; desk: string; vault: string; feed: PriceFeed; spread?: number; validityMs?: number }) {
    this.ledger = options.ledger;
    this.desk = options.desk;
    this.vault = options.vault;
    this.feed = options.feed;
    this.spread = options.spread ?? Number(process.env.DESK_SPREAD ?? 0.004);
    this.validityMs = options.validityMs ?? 60_000;
  }

  /** Indicative prices without committing to them on the ledger (for PRICE replies and confirmations). */
  async indicative(symbol: string): Promise<{ bid: number; ask: number; mid: number }> {
    const mid = await this.feed.cantex(symbol);
    return { bid: mid * (1 - this.spread), ask: mid * (1 + this.spread), mid };
  }

  /** Put a firm quote on the ledger that the vault can fill until it expires. */
  async quote(symbol: string): Promise<QuoteInfo> {
    const { bid, ask, mid } = await this.indicative(symbol);
    const now = Date.now();
    const validUntil = new Date(now + this.validityMs);
    const quoteCid = await this.ledger.create(this.desk, templates.quote, {
      desk: this.desk,
      vault: this.vault,
      symbol,
      bid: decimal(bid),
      ask: decimal(ask),
      source: `Cantex ${this.feed.label}, spread ${(this.spread * 100).toFixed(2)}%`,
      quotedAt: new Date(now).toISOString(),
      validUntil: validUntil.toISOString(),
    });
    return { quoteCid, symbol, bid, ask, mid, validUntil };
  }

  /** Archive the desk's expired quotes so the ledger doesn't collect them. */
  async archiveExpired(): Promise<number> {
    const quotes = await this.ledger.query<Quote>(this.desk, templates.quote);
    const expired = quotes.filter((quote) => new Date(quote.payload.validUntil).getTime() < Date.now() - 60_000);
    for (const quote of expired) {
      await this.ledger.exercise([this.desk], templates.quote, quote.contractId, "Archive", {});
    }
    return expired.length;
  }
}
