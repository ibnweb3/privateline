import assert from "node:assert/strict";
import { test } from "node:test";

import { dollarsForNaira, naira, nairaForDollars, type NairaRates } from "../src/fx.ts";
import { BadPaymentSignatureError, demoTransferEvent, maskAccount, parsePaymentEvent, signPayment } from "../src/payments.ts";

const rates: NairaRates = { mid: 1500, deposit: 1522.5, withdraw: 1477.5, source: "test" };

test("naira and dollars convert with the spread against the user, rounded down", () => {
  assert.equal(dollarsForNaira(15_000, rates), 9.85);
  assert.equal(nairaForDollars(20, rates), 29_550);
  assert.equal(naira(29550), "N29,550");
});

test("a signed deposit notification parses; a forged one is refused", () => {
  const raw = demoTransferEvent({ toAccount: "9912345678", naira: 15_000, senderBank: "GTBank", senderAccount: "0123456789", senderName: "ADA OKAFOR", reference: "ref-1" });
  const transfer = parsePaymentEvent(raw, signPayment(raw, "secret"), "secret");
  assert.deepEqual(transfer, { reference: "ref-1", naira: 15_000, toAccount: "9912345678", sender: { bank: "GTBank", account: "0123456789", name: "ADA OKAFOR" } });
  assert.throws(() => parsePaymentEvent(raw, signPayment(raw, "other"), "secret"), BadPaymentSignatureError);
  const tampered = raw.replace("1500000", "9900000");
  assert.throws(() => parsePaymentEvent(tampered, signPayment(raw, "secret"), "secret"), BadPaymentSignatureError);
});

test("other events are ignored", () => {
  const raw = JSON.stringify({ event: "transfer.success", data: {} });
  assert.equal(parsePaymentEvent(raw, signPayment(raw, "s"), "s"), null);
  assert.equal(maskAccount("0123456789"), "****6789");
});
