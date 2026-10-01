// What testers said, for the Metrics step. Prints the counts and every note. The notes are private:
// the public API only ever returns counts.
//   node scripts/feedback-report.ts          (on the server, from ~/privateline/app)

import { Db } from "../src/db.ts";
import { summarize } from "../src/feedback.ts";

const rows = new Db().allFeedback();
const summary = summarize(rows);

console.log(`${summary.total} response${summary.total === 1 ? "" : "s"}`);
for (const question of ["who", "would_use", "amount", "worry"] as const) {
  console.log(`\n${question}`);
  for (const [value, n] of Object.entries(summary[question])) console.log(`  ${value.padEnd(10)} ${n}`);
}
console.log(`\ntraders and shop owners: ${summary.traders.total} (would use: ${JSON.stringify(summary.traders.would_use)})`);

const withPhone = rows.filter((row) => row.phone).reduce<Record<string, number>>((all, row) => ({ ...all, [row.phone!]: (all[row.phone!] ?? 0) + 1 }), {});
console.log(`phone: ${JSON.stringify(withPhone)}`);

const notes = rows.filter((row) => row.comment);
console.log(`\n${notes.length} note${notes.length === 1 ? "" : "s"}`);
for (const row of notes) console.log(`- [${row.who}, ${row.would_use}, ${new Date(row.at).toISOString().slice(0, 10)}] ${row.comment}`);
