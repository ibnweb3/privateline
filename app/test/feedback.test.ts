import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Db } from "../src/db.ts";
import { FeedbackError, MAX_COMMENT, parseFeedback, QUESTIONS, summarize, type Feedback } from "../src/feedback.ts";

const valid = { who: "trader", phone: "basic", would_use: "yes", amount: "5k-20k", worry: "trust", comment: "  Looks good  ", source: "try" };

test("a complete submission is accepted and tidied", () => {
  assert.deepEqual(parseFeedback(valid), { ...valid, comment: "Looks good" });
});

test("only who and would_use are required", () => {
  assert.deepEqual(parseFeedback({ who: "student", would_use: "maybe" }), {
    who: "student", phone: null, would_use: "maybe", amount: null, worry: null, comment: null, source: "direct",
  });
  assert.throws(() => parseFeedback({ would_use: "yes" }), FeedbackError);
  assert.throws(() => parseFeedback({ who: "trader" }), FeedbackError);
});

test("answers outside the offered choices are refused", () => {
  assert.throws(() => parseFeedback({ ...valid, would_use: "definitely" }), /offered/);
  assert.throws(() => parseFeedback({ ...valid, worry: 3 }), FeedbackError);
  assert.equal(parseFeedback({ ...valid, source: "somewhere-else" }).source, "direct");
});

test("the note is capped and stripped of control characters", () => {
  const long = parseFeedback({ ...valid, comment: "x".repeat(MAX_COMMENT + 100) });
  assert.equal(long.comment?.length, MAX_COMMENT);
  assert.equal(parseFeedback({ ...valid, comment: "a\u0000b\u0007c" }).comment, "abc");
  assert.equal(parseFeedback({ ...valid, comment: "   " }).comment, null);
});

test("the summary counts answers, and the trader split is the first customer", () => {
  const row = (overrides: Partial<Feedback>): Feedback => ({ ...parseFeedback(valid), ...overrides });
  const summary = summarize([
    row({ who: "trader", would_use: "yes" }),
    row({ who: "trader", would_use: "maybe", amount: null }),
    row({ who: "builder", would_use: "no", worry: null }),
  ]);
  assert.equal(summary.total, 3);
  assert.deepEqual(summary.would_use, { yes: 1, maybe: 1, no: 1 });
  assert.equal(summary.who.trader, 2);
  assert.equal(summary.amount["5k-20k"], 2);
  assert.deepEqual(summary.traders, { total: 2, would_use: { yes: 1, maybe: 1, no: 0 } });
  assert.deepEqual(summarize([]).would_use, { yes: 0, maybe: 0, no: 0 });
});

test("answers are stored without anything that identifies the person", () => {
  const db = new Db(":memory:");
  db.addFeedback(parseFeedback(valid), 1_790_000_000_000);
  const [stored] = db.allFeedback();
  assert.deepEqual(Object.keys(stored!).sort(), ["amount", "at", "comment", "id", "phone", "source", "who", "worry", "would_use"]);
  assert.equal(stored!.who, "trader");
});

test("the form's choices match what the server accepts", () => {
  const html = readFileSync(new URL("../web/feedback.html", import.meta.url), "utf8");
  const offered: Record<string, string[]> = {};
  for (const [, name, value] of html.matchAll(/<input type="radio" name="([a-z_]+)" value="([^"]+)"/g)) {
    (offered[name!] ??= []).push(value!);
  }
  assert.deepEqual(offered, Object.fromEntries(Object.entries(QUESTIONS).map(([name, values]) => [name, [...values]])));
});
