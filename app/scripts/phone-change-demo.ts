// SIM-swap protection end to end, against a running PrivateLine (npm start):
// sign in by email, move the account to a new simulator phone, and watch the old phone get a
// warning, the cooldown pass, 2 of 3 operators approve, and the new phone take over.
//   node scripts/phone-change-demo.ts <email> <current +999 phone> [new +999 phone]
// Set PHONE_CHANGE_COOLDOWN_SECONDS=120 in app/.env for a two-minute demo.

const base = process.env.BASE_URL ?? "http://localhost:8790";
const [email, oldPhone, newPhoneArg] = process.argv.slice(2);
if (!email || !oldPhone) {
  console.error("usage: node scripts/phone-change-demo.ts <email> <current +999 phone> [new +999 phone]");
  process.exit(1);
}
const newPhone = newPhoneArg ?? `+999${Date.now().toString().slice(-7)}`;
let cookie = "";
const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

async function call<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
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

type Message = { id: number; direction: string; body: string };
const seen = new Map<string, number>();
async function newTexts(phone: string): Promise<string[]> {
  const { messages } = await call<{ messages: Message[] }>(`/api/sim/messages?phone=${encodeURIComponent(phone)}&after=${seen.get(phone) ?? 0}`);
  if (messages.length) seen.set(phone, messages.at(-1)!.id);
  return messages.filter((message) => message.direction === "out").map((message) => message.body);
}
async function waitForText(phone: string, pattern: RegExp, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const text of await newTexts(phone)) {
      log(`  text to ${phone}: ${text}`);
      if (pattern.test(text)) return text;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`no text matching ${pattern} to ${phone}`);
}

await newTexts(oldPhone);
const { devCode } = await call<{ devCode: string }>("/api/signin/start", { email });
await call("/api/signin/finish", { email, code: devCode });
log(`signed in as ${email}; moving the account from ${oldPhone} to ${newPhone}`);
await call("/api/me/phone", { phone: newPhone });
const code = /(\d{6})/.exec(await waitForText(newPhone, /PrivateLine code/, 30_000))![1];
const { readyAt } = await call<{ readyAt: number }>("/api/me/phone/confirm", { code });
log(`change requested; the contract won't run it before ${new Date(readyAt).toISOString()}`);
await waitForText(oldPhone, /Reply NO/, 30_000);
log("waiting out the cooldown (the checkers confirm only after it, and the operator then executes)...");
await waitForText(newPhone, /now uses this phone/, readyAt - Date.now() + 120_000);
const { messages } = await call<{ messages: Message[] }>(`/api/sim/messages?phone=${encodeURIComponent(newPhone)}`);
seen.set(newPhone, messages.at(-1)?.id ?? 0);
await call("/api/sim/send", { phone: newPhone, body: "BAL" });
await waitForText(newPhone, /Total/, 30_000);
await call("/api/sim/send", { phone: oldPhone, body: "BAL" });
await waitForText(oldPhone, /isn't on PrivateLine/, 30_000);
log("done: the account moved to the new phone, and the old phone no longer controls it");
