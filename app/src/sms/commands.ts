// Parse an inbound text into a command. Pure and forgiving about word order, case, "$" and
// commas, so "BUY GOLD 20", "buy 20 gold" and "Buy $20 Gold" all mean the same thing.

import { findAsset, type Asset } from "../prices.ts";

export type Command =
  | { kind: "help" }
  | { kind: "balance" }
  | { kind: "price"; asset?: Asset }
  | { kind: "buy"; asset: Asset; dollars: string }
  | { kind: "sell"; asset: Asset; dollars?: string; all: boolean }
  | { kind: "yes"; pin: string }
  | { kind: "no" }
  | { kind: "alert"; asset: Asset; pct: number }
  | { kind: "alerts" }
  | { kind: "alertsOff" }
  | { kind: "lock" }
  | { kind: "unknown"; hint?: string };

const AMOUNT = /^\$?(\d{1,7}(?:\.\d{1,2})?)$/;

function money(word: string): string | undefined {
  const match = AMOUNT.exec(word.replace(/,/g, ""));
  return match ? match[1] : undefined;
}

export function parseCommand(text: string): Command {
  const words = text.trim().toUpperCase().replace(/[.!]+$/, "").split(/\s+/).filter(Boolean);
  const [verb, ...rest] = words;
  if (!verb) return { kind: "unknown" };

  switch (verb) {
    case "HELP": case "MENU": case "?": case "HI": case "HELLO": case "START":
      return { kind: "help" };
    case "BAL": case "BALANCE":
      return { kind: "balance" };
    case "PRICE": case "PRICES": {
      if (rest.length === 0) return { kind: "price" };
      const asset = findAsset(rest.join(""));
      return asset ? { kind: "price", asset } : { kind: "unknown", hint: `I don't know "${rest.join(" ")}". Try PRICE GOLD` };
    }
    case "BUY": case "SELL": {
      const all = verb === "SELL" && rest.includes("ALL");
      const amountWords = rest.filter((word) => money(word) !== undefined);
      const assetWords = rest.filter((word) => money(word) === undefined && word !== "ALL" && word !== "OF" && word !== "WORTH");
      const asset = assetWords.length > 0 ? findAsset(assetWords.join("")) ?? findAsset(assetWords[0]!) : undefined;
      const example = `${verb} GOLD 20`;
      if (!asset) return { kind: "unknown", hint: `Which asset? e.g. ${example}${verb === "SELL" ? " or SELL GOLD ALL" : ""}` };
      if (all) return { kind: "sell", asset, all: true };
      const dollars = amountWords.length === 1 ? money(amountWords[0]!) : undefined;
      if (!dollars || Number(dollars) <= 0) return { kind: "unknown", hint: `How many US dollars? e.g. ${verb} ${asset.aliases[0]} 20` };
      return verb === "BUY" ? { kind: "buy", asset, dollars } : { kind: "sell", asset, dollars, all: false };
    }
    case "YES": case "Y": case "OK": {
      const pin = rest[0];
      return pin && /^\d{4,6}$/.test(pin) ? { kind: "yes", pin } : { kind: "unknown", hint: "Reply YES and your PIN, e.g. YES 1234" };
    }
    case "NO": case "N": case "CANCEL":
      return { kind: "no" };
    case "ALERT": {
      if (rest[0] === "OFF") return { kind: "alertsOff" };
      const pctWord = rest.find((word) => /^\d+(\.\d+)?%?$/.test(word));
      const asset = findAsset(rest.filter((word) => word !== pctWord).join("")) ?? (rest[0] ? findAsset(rest[0]) : undefined);
      const pct = pctWord ? Number(pctWord.replace("%", "")) : NaN;
      if (!asset || !(pct >= 0.5 && pct <= 50)) return { kind: "unknown", hint: "e.g. ALERT GOLD 2 texts you when gold moves 2%" };
      return { kind: "alert", asset, pct };
    }
    case "ALERTS":
      return rest[0] === "OFF" ? { kind: "alertsOff" } : { kind: "alerts" };
    case "STOP": case "UNSUBSCRIBE":
      return { kind: "alertsOff" };
    case "LOCK": case "FREEZE":
      return { kind: "lock" };
    default:
      return { kind: "unknown" };
  }
}
