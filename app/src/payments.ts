// Naira in and out. On MainNet a Nigerian payment provider would give each user a dedicated bank
// account number (a "virtual account"), notify us when a transfer lands, and pay withdrawals out;
// a licensed exchange would convert between naira and USDC. This module is the LocalNet stand-in:
// a demo bank with the same moving parts, and a deposit webhook modeled on Paystack's
// dedicated-virtual-account `charge.success` event, signed with HMAC-SHA512 like theirs.

import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

export const DEMO_BANK = "PrivateLine Demo Bank";

export interface PaymentEvent {
  event: string;
  data: {
    reference: string;
    /** Kobo (1/100 naira). */
    amount: number;
    currency: string;
    channel: string;
    paid_at: string;
    authorization: {
      receiver_bank: string;
      receiver_bank_account_number: string;
      sender_bank: string;
      sender_bank_account_number: string;
      sender_name: string;
      narration?: string;
    };
  };
}

export interface IncomingTransfer {
  reference: string;
  naira: number;
  toAccount: string;
  sender: { bank: string; account: string; name: string };
}

export function newVirtualAccountNumber(): string {
  // Ten digits like a NUBAN, starting 99 so it can't be mistaken for a real bank account.
  return `99${String(randomInt(0, 100_000_000)).padStart(8, "0")}`;
}

export function signPayment(raw: string, secret: string): string {
  return createHmac("sha512", secret).update(raw).digest("hex");
}

export class BadPaymentSignatureError extends Error {}

/** Verify and parse a deposit notification; null for events that aren't a completed naira transfer. */
export function parsePaymentEvent(raw: string, signature: string | undefined, secret: string): IncomingTransfer | null {
  const expected = signPayment(raw, secret);
  const given = (signature ?? "").trim().toLowerCase();
  if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    throw new BadPaymentSignatureError("payment webhook signature mismatch");
  }
  const event = JSON.parse(raw) as PaymentEvent;
  if (event.event !== "charge.success" || event.data?.currency !== "NGN" || event.data.channel !== "dedicated_nuban") return null;
  const auth = event.data.authorization;
  if (!auth?.receiver_bank_account_number || !(event.data.amount > 0)) return null;
  return {
    reference: event.data.reference,
    naira: event.data.amount / 100,
    toAccount: auth.receiver_bank_account_number,
    sender: { bank: auth.sender_bank, account: auth.sender_bank_account_number, name: auth.sender_name },
  };
}

/** What the demo bank sends when someone transfers naira to a PrivateLine account number. */
export function demoTransferEvent(fields: { toAccount: string; naira: number; senderBank: string; senderAccount: string; senderName: string; reference: string }): string {
  const event: PaymentEvent = {
    event: "charge.success",
    data: {
      reference: fields.reference,
      amount: Math.round(fields.naira * 100),
      currency: "NGN",
      channel: "dedicated_nuban",
      paid_at: new Date().toISOString(),
      authorization: {
        receiver_bank: DEMO_BANK,
        receiver_bank_account_number: fields.toAccount,
        sender_bank: fields.senderBank,
        sender_bank_account_number: fields.senderAccount,
        sender_name: fields.senderName,
        narration: "PrivateLine deposit",
      },
    },
  };
  return JSON.stringify(event);
}

export function maskAccount(account: string): string {
  return `****${account.slice(-4)}`;
}
