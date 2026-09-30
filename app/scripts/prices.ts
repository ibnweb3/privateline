// Print each asset's Cantex price next to its real-world market price.
// PRICE_MODE=replay shows the logged Sep 26 snapshot instead of live prices.

import { ASSETS, feedFromEnv } from "../src/prices.ts";

const feed = await feedFromEnv();
console.log(`prices (${feed.label})`);
for (const asset of ASSETS) {
  try {
    const [cantex, market] = await Promise.all([feed.cantex(asset.symbol), feed.market(asset.symbol)]);
    const gap = (cantex / market - 1) * 100;
    console.log(`${asset.name.padEnd(11)} ${asset.symbol.padEnd(5)} Cantex $${cantex.toFixed(2).padStart(10)}  market $${market.toFixed(2).padStart(10)}  gap ${gap >= 0 ? "+" : ""}${gap.toFixed(2)}%`);
  } catch (error) {
    console.log(`${asset.name.padEnd(11)} ${asset.symbol.padEnd(5)} unavailable: ${error instanceof Error ? error.message : error}`);
  }
}
