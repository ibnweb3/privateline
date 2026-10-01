// Anonymous feedback from people who tried the demo: a few multiple-choice questions and an
// optional note. No name, email or phone number is asked for or stored. The answers are the
// evidence behind the Metrics step, so the question ids here must match web/feedback.html (a test
// checks that).

export class FeedbackError extends Error {}

export const QUESTIONS = {
  who: ["trader", "salaried", "student", "builder", "other"],
  phone: ["basic", "smartphone"],
  would_use: ["yes", "maybe", "no"],
  amount: ["under5k", "5k-20k", "20k-100k", "over100k", "none"],
  worry: ["trust", "cost", "signup", "language", "unclear", "nothing"],
} as const;

export type Question = keyof typeof QUESTIONS;

const REQUIRED: Record<string, string> = {
  who: "Please tell us which describes you best.",
  would_use: "Please tell us whether you would use it.",
};
const SOURCES = ["try", "direct"];
export const MAX_COMMENT = 500;

export interface Feedback {
  who: string;
  phone: string | null;
  would_use: string;
  amount: string | null;
  worry: string | null;
  comment: string | null;
  source: string;
}

export interface FeedbackRow extends Feedback {
  id: number;
  at: number;
}

/** Validates a submission: every answer must be one of the offered choices. */
export function parseFeedback(body: Record<string, unknown>): Feedback {
  const choice = (name: Question): string | null => {
    const value = body[name];
    if (value === undefined || value === null || value === "") {
      const message = REQUIRED[name];
      if (message) throw new FeedbackError(message);
      return null;
    }
    if (typeof value !== "string" || !(QUESTIONS[name] as readonly string[]).includes(value)) {
      throw new FeedbackError("Please pick one of the answers offered.");
    }
    return value;
  };
  const note = typeof body.comment === "string"
    // eslint-disable-next-line no-control-regex
    ? body.comment.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, MAX_COMMENT)
    : "";
  return {
    who: choice("who")!,
    phone: choice("phone"),
    would_use: choice("would_use")!,
    amount: choice("amount"),
    worry: choice("worry"),
    comment: note === "" ? null : note,
    source: typeof body.source === "string" && SOURCES.includes(body.source) ? body.source : "direct",
  };
}

export interface FeedbackSummary {
  total: number;
  would_use: Record<string, number>;
  who: Record<string, number>;
  amount: Record<string, number>;
  worry: Record<string, number>;
  /** The same "would you use it" split among small traders and shop owners: the first customer. */
  traders: { total: number; would_use: Record<string, number> };
}

const zeros = (options: readonly string[]): Record<string, number> => Object.fromEntries(options.map((option) => [option, 0]));

/** Counts only. Comments and individual answers never leave the server through this. */
export function summarize(rows: readonly Feedback[]): FeedbackSummary {
  const summary: FeedbackSummary = {
    total: rows.length,
    would_use: zeros(QUESTIONS.would_use),
    who: zeros(QUESTIONS.who),
    amount: zeros(QUESTIONS.amount),
    worry: zeros(QUESTIONS.worry),
    traders: { total: 0, would_use: zeros(QUESTIONS.would_use) },
  };
  for (const row of rows) {
    summary.would_use[row.would_use]! += 1;
    summary.who[row.who]! += 1;
    if (row.amount) summary.amount[row.amount]! += 1;
    if (row.worry) summary.worry[row.worry]! += 1;
    if (row.who === "trader") {
      summary.traders.total += 1;
      summary.traders.would_use[row.would_use]! += 1;
    }
  }
  return summary;
}
