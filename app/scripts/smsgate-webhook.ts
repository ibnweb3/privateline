// Manage the sms-gate.app webhook that delivers texts from the gateway phone to PrivateLine.
// Reads SMSGATE_USERNAME / SMSGATE_PASSWORD (and PUBLIC_URL for register) from app/.env.
//   npm run smsgate -- list
//   npm run smsgate -- register            registers ${PUBLIC_URL}/sms/webhook for sms:received
//   npm run smsgate -- add <id> <https url>    register any webhook, e.g. to put another service's back
//   npm run smsgate -- delete <id>
//   npm run smsgate -- send <+number> "text"   a test text from the gateway phone

const API = "https://api.sms-gate.app/3rdparty/v1";
const { SMSGATE_USERNAME: user, SMSGATE_PASSWORD: pass, PUBLIC_URL: publicUrl } = process.env;
if (!user || !pass) {
  console.error("Set SMSGATE_USERNAME and SMSGATE_PASSWORD in app/.env (from the SMS Gateway app: Settings > Cloud server).");
  process.exit(1);
}
const auth = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(API + path, {
    method,
    headers: { authorization: auth, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case "list":
    console.log(JSON.stringify(await call("GET", "/webhooks"), null, 2));
    break;
  case "register": {
    if (!publicUrl?.startsWith("https://")) {
      console.error("Set PUBLIC_URL in app/.env to the public https address of this machine (the tunnel), e.g. https://example.trycloudflare.com");
      process.exit(1);
    }
    const url = `${publicUrl.replace(/\/$/, "")}/sms/webhook`;
    console.log(JSON.stringify(await call("POST", "/webhooks", { id: "privateline", url, event: "sms:received" }), null, 2));
    console.log(`texts to the gateway phone now go to ${url}`);
    break;
  }
  case "add": {
    const [id, url] = args;
    if (!id || !url?.startsWith("https://")) throw new Error("usage: add <webhook id> <https url>");
    console.log(JSON.stringify(await call("POST", "/webhooks", { id, url, event: "sms:received" }), null, 2));
    break;
  }
  case "delete":
    if (!args[0]) throw new Error("usage: delete <webhook id>");
    await call("DELETE", `/webhooks/${encodeURIComponent(args[0])}`);
    console.log(`deleted webhook ${args[0]}`);
    break;
  case "send": {
    const [to, text] = args;
    if (!to || !text) throw new Error('usage: send <+number> "text"');
    console.log(JSON.stringify(await call("POST", "/messages", { message: text, phoneNumbers: [to] }), null, 2));
    break;
  }
  default:
    console.error("usage: npm run smsgate -- list | register | add <id> <https url> | delete <id> | send <+number> \"text\"");
    process.exit(1);
}
