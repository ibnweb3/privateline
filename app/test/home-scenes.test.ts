import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

process.env.APP_SECRET ??= randomBytes(32).toString("hex");
const { explainForUser } = await import("../src/app.ts");
const { dollarsForNaira, naira } = await import("../src/fx.ts");
const { DEMO_BANK } = await import("../src/payments.ts");
const { assetBySymbol } = await import("../src/prices.ts");
const { price, quantity, usd } = await import("../src/sms/format.ts");

interface Step { you?: string; pl?: string; sys?: string; ops?: Record<string, string>; tally?: string[]; tone?: string; hold?: number; think?: number }
interface Scene { id: string; label: string; note: string; start?: Record<string, string>; steps: Step[] }
// A computed path keeps TypeScript from asking for types for a plain browser module.
const { SCENES, OPERATORS } = (await import(new URL("../web/static/home-scenes.js", import.meta.url).href)) as {
  SCENES: Scene[];
  OPERATORS: { id: string }[];
};

const scene = (id: string) => SCENES.find((candidate) => candidate.id === id)!;
const replies = (id: string) => scene(id).steps.flatMap((step) => (step.pl ? [step.pl] : []));
const CONFIRM = "Reply YES and your PIN within 2 min to confirm, NO to cancel.";

const gold = assetBySymbol("eXAU");
const sp500 = assetBySymbol("SPYe");

// The home page replays these as if they were live, so each reply must be word for word what the
// app sends. If a reply format changes in the app, this test says which animated line is now wrong.

test("the buy-gold replies are what the app sends", () => {
  const units = quantity(20 / 4145.59);
  assert.deepEqual(replies("buy"), [
    `Buy ${usd(20)} of ${gold.name} at about ${price(4145.59)}/${gold.unit} (${units} ${gold.unit})? ${CONFIRM} Ref TEA5E`,
    `Done: bought ${units} ${gold.unit} ${gold.name} for ${usd(20)} at ${price(4145.59)}/${gold.unit}. Cash ${usd(80)}. Ref TEA5E`,
  ]);
});

test("the naira deposit replies are what the app sends, and the sum is right", () => {
  assert.equal(dollarsForNaira(15_000, { mid: 1327, deposit: 1347, withdraw: 1307, source: "test" }), 11.13);
  assert.deepEqual(replies("deposit"), [
    `To add money, send naira to ${DEMO_BANK}, account 9912345678 (PrivateLine pl-a855), from your bank app or USSD. Rate: ${naira(1347)} = $1. We'll text you when it lands.`,
    `Received ${naira(15_000)} = ${usd(11.13)} at ${naira(1347)}/$. Cash ${usd(111.13)}. Text BUY GOLD 10 to invest.`,
  ]);
});

test("the refused sale is the real refusal, and the numbers agree", () => {
  const bid = 4112.56;
  const market = 4183.3;
  assert.equal(((market - bid) / market * 100).toFixed(2), "1.69");
  const held = 0.00482;
  assert.deepEqual(replies("refused"), [
    `Sell all ${quantity(held)} ${gold.unit} of ${gold.name} at about ${price(bid)}/${gold.unit} (about ${usd(held * bid)})? ${CONFIRM} Ref K3M9Q`,
    `Not done: ${explainForUser("eXAU bid $4,112.56 is 1.69% below the market price $4,183.30 (limit 1.50%)", gold)}. No money moved. Ref K3M9Q`,
  ]);
});

test("the one-node-down trade and the two-nodes-down timeout are what the app sends", () => {
  const units = quantity(15 / 771.22);
  assert.deepEqual(replies("down1"), [
    `Buy ${usd(15)} of ${sp500.name} at about ${price(771.22)}/${sp500.unit} (${units} ${sp500.unit})? ${CONFIRM} Ref 7QX2D`,
    `Done: bought ${units} ${sp500.unit} ${sp500.name} for ${usd(15)} at ${price(771.22)}/${sp500.unit}. Cash ${usd(85)}. Ref 7QX2D`,
  ]);
  assert.deepEqual(replies("down2"), [
    `Buy ${usd(20)} of ${gold.name} at about ${price(4145.59)}/${gold.unit} (${quantity(20 / 4145.59)} ${gold.unit})? ${CONFIRM} Ref 2WJ8C`,
    `Not done: ${explainForUser("not enough operators approved it in time", gold)}. No money moved. Ref 2WJ8C`,
  ]);
});

test("a real PIN is never shown", () => {
  const sent = SCENES.flatMap((s) => s.steps.flatMap((step) => (step.you ? [step.you] : [])));
  for (const text of sent.filter((text) => text.startsWith("YES"))) assert.match(text, /^YES •+$/);
});

test("every scene is well formed", () => {
  const operators = new Set(OPERATORS.map((operator) => operator.id));
  const states = new Set(["idle", "proposed", "confirmed", "refused", "offline"]);
  assert.equal(new Set(SCENES.map((s) => s.id)).size, SCENES.length, "scene ids are unique");
  for (const s of SCENES) {
    assert.ok(s.label && s.note, `${s.id} has a label and a caption`);
    assert.ok(s.steps.at(-1)?.pl, `${s.id} ends with a reply`);
    for (const id of Object.keys(s.start ?? {})) assert.ok(operators.has(id), `${s.id}: unknown operator ${id}`);
    for (const step of s.steps) {
      for (const [id, state] of Object.entries(step.ops ?? {})) {
        assert.ok(operators.has(id), `${s.id}: unknown operator ${id}`);
        assert.ok(states.has(state), `${s.id}: unknown state ${state}`);
      }
      if (step.tally) assert.ok(step.tally.length === 2 && ["wait", "ok", "bad"].includes(step.tone ?? ""), `${s.id}: tally needs two parts and a tone`);
    }
  }
});
