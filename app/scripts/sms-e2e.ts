// End-to-end check of the SMS service against a running PrivateLine (npm start): sign up a
// simulator phone through the website API, then text it the way a user would and print the
// conversation. Every trade goes through the 2-of-3 approval on LocalNet.
//   BASE_URL=http://localhost:8790 node scripts/sms-e2e.ts

const base = process.env.BASE_URL ?? "http://localhost:8790";
const stamp = Date.now().toString().slice(-7);
const phone = `+999${stamp}`;
const email = `demo-${stamp}@example.com`;
const pin = "4829";
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
async function replies(timeoutMs = 60_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { messages } = await api<{ messages: { id: number; direction: string; body: string }[] }>(
      `/api/sim/messages?phone=${encodeURIComponent(phone)}&after=${seen}`);
    const out = messages.filter((message) => message.direction === "out");
    if (messages.length > 0) seen = messages[messages.length - 1]!.id;
    if (out.length > 0) return out.map((message) => message.body);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("no reply within the timeout");
}

async function text(body: string): Promise<void> {
  const started = Date.now();
  await api("/api/sim/send", { phone, body });
  const answers = await replies();
  console.log(`\n> ${body}`);
  for (const answer of answers) console.log(`< ${answer}  [${((Date.now() - started) / 1000).toFixed(1)}s]`);
}

console.log(`sign-up: ${email}, phone ${phone}`);
const { devCode } = await api<{ devCode: string }>("/api/signup/start", { email });
const { signupToken } = await api<{ signupToken: string }>("/api/signup/email", { email, code: devCode });
await api("/api/signup/phone", { token: signupToken, phone });
const [codeText] = await replies();
const phoneCode = /(\d{6})/.exec(codeText ?? "")?.[1];
console.log(`< ${codeText}`);
await api("/api/signup/verify-phone", { token: signupToken, code: phoneCode });
const started = Date.now();
const { accountId } = await api<{ accountId: string }>("/api/signup/finish", { token: signupToken, pin });
console.log(`account ${accountId} opened (2 of 3) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`< ${(await replies())[0]}`);

for (const body of ["BAL", "PRICE GOLD", "BUY GOLD 20", `YES ${pin}`, "BUY SPY 15", "YES 1111", "NO", "SELL GOLD ALL", `YES ${pin}`, "ALERT SILVER 2", "BUY GOLD 500", "HELP", "LOCK", "BAL"]) {
  await text(body);
}
const me = await api<{ cash: number; total: number; activity: { text: string }[] }>("/api/me");
console.log(`\naccount page: cash $${me.cash.toFixed(2)}, total $${me.total.toFixed(2)}`);
for (const entry of me.activity.slice(0, 6)) console.log(`  ${entry.text}`);
