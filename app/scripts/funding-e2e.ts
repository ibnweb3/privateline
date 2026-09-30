// Money in and out, end to end, against a running PrivateLine: sign up a simulator phone, text
// DEPOSIT, send naira from the demo bank, then WITHDRAW back to that bank account. Deposits and
// withdrawals each need 2 of 3 operators on the ledger.
//   BASE_URL=https://<server> node scripts/funding-e2e.ts

const base = process.env.BASE_URL ?? "http://localhost:8790";
const stamp = Date.now().toString().slice(-7);
const phone = `+999${stamp}`;
const email = `funding-${stamp}@example.com`;
const pin = "4829";
const bankAccount = `0${stamp}${stamp.slice(0, 2)}`;
let cookie = "";

async function api<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0]!;
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(`${path}: ${data.error}`);
  return data;
}

let seen = 0;
async function nextText(pattern?: RegExp, timeoutMs = 90_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { messages } = await api<{ messages: { id: number; direction: string; body: string }[] }>(
      `/api/sim/messages?phone=${encodeURIComponent(phone)}&after=${seen}`);
    for (const message of messages) {
      seen = message.id;
      if (message.direction === "out" && (!pattern || pattern.test(message.body))) return message.body;
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  throw new Error(`no text matching ${pattern} within the timeout`);
}

async function text(body: string, pattern?: RegExp): Promise<string> {
  const started = Date.now();
  await api("/api/sim/send", { phone, body });
  const reply = await nextText(pattern);
  console.log(`> ${body}\n< ${reply}  [${((Date.now() - started) / 1000).toFixed(1)}s]`);
  return reply;
}

const { devCode } = await api<{ devCode: string }>("/api/signup/start", { email });
const { signupToken } = await api<{ signupToken: string }>("/api/signup/email", { email, code: devCode });
await api("/api/signup/phone", { token: signupToken, phone });
const code = /(\d{6})/.exec(await nextText(/code/))?.[1];
await api("/api/signup/verify-phone", { token: signupToken, code });
const { accountId } = await api<{ accountId: string }>("/api/signup/finish", { token: signupToken, pin });
await nextText(/Welcome/);
console.log(`signed up ${phone} as ${accountId}\n`);

const instructions = await text("DEPOSIT");
const depositAccount = /account (\d{10})/.exec(instructions)?.[1];
if (!depositAccount) throw new Error("no deposit account number in the reply");

const started = Date.now();
const { reference } = await api<{ reference: string }>("/api/demo-bank/transfer", {
  toAccount: depositAccount, naira: 15000, senderBank: "GTBank", senderAccount: bankAccount, senderName: "ADA OKAFOR",
});
console.log(`\ndemo bank: sent N15,000 from GTBank ${bankAccount} (ref ${reference})`);
console.log(`< ${await nextText(/Received/)}  [${((Date.now() - started) / 1000).toFixed(1)}s after the transfer]\n`);

await text("WITHDRAW 5", /Withdraw/);
await text(`YES ${pin}`, /Done|Not done/);
await text("BAL", /Total/);

const { entries } = await api<{ entries: { direction: string; counterparty: string; naira: number; reference: string }[] }>(
  `/api/demo-bank/statement?account=${bankAccount}`);
console.log("\ndemo bank statement:");
for (const entry of entries) console.log(`  ${entry.direction === "in" ? "+" : "-"}N${entry.naira.toLocaleString("en-US")} ${entry.direction === "in" ? "from" : "to"} ${entry.counterparty} (${entry.reference})`);
