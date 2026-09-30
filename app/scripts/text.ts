// Text a running PrivateLine (npm start) from a simulator phone and print the replies.
//   node scripts/text.ts +9994269527 "BUY GOLD 5" "YES 5830"
// Each message waits for its reply before the next is sent.

const base = process.env.BASE_URL ?? "http://localhost:8790";
const [phone, ...messages] = process.argv.slice(2);
if (!phone || messages.length === 0) {
  console.error('usage: node scripts/text.ts <+999 number> "<message>" ["<message>" ...]');
  process.exit(1);
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error);
  return data;
}

type Message = { id: number; direction: "in" | "out"; body: string };
const history = await call<{ messages: Message[] }>(`/api/sim/messages?phone=${encodeURIComponent(phone)}`);
let lastId = history.messages.at(-1)?.id ?? 0;

for (const message of messages) {
  const started = Date.now();
  await call("/api/sim/send", { phone, body: message });
  console.log(`> ${message}`);
  let replied = false;
  while (!replied && Date.now() - started < 90_000) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const { messages: fresh } = await call<{ messages: Message[] }>(`/api/sim/messages?phone=${encodeURIComponent(phone)}&after=${lastId}`);
    for (const reply of fresh) {
      lastId = reply.id;
      if (reply.direction === "out") {
        console.log(`< ${reply.body}  [${((Date.now() - started) / 1000).toFixed(1)}s]`);
        replied = true;
      }
    }
  }
  if (!replied) console.log("< (no reply within 90s)");
}
