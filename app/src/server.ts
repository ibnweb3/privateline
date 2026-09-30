// HTTP: the website (static pages in web/), its JSON API, the sms-gate.app webhook and the phone
// simulator. Node's built-in http module; no framework.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

import { UserError, type PrivateLine } from "./app.ts";
import type { User } from "./db.ts";
import { ASSETS } from "./prices.ts";
import { BadSignatureError, isSimulatorPhone, parseSmsGateWebhook, type SimulatorGateway } from "./sms/gateway.ts";
import { normalizeE164 } from "./sms/phone.ts";

export interface ServerOptions {
  app: PrivateLine;
  simulator: SimulatorGateway;
  status: () => unknown;
  port: number;
  /** Interface to listen on; 127.0.0.1 behind a reverse proxy. All interfaces when unset. */
  host?: string;
  webhookSecret?: string;
  /** On a dual-SIM gateway phone, only handle texts that arrived on this SIM. */
  onlySim?: number;
  log: (line: string) => void;
}

const WEB_ROOT = fileURLToPath(new URL("../web/", import.meta.url));
const PAGES: Record<string, string> = {
  "/": "index.html",
  "/signup": "signup.html",
  "/signin": "signin.html",
  "/account": "account.html",
  "/privacy": "privacy.html",
  "/try": "try.html",
};
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};
const SESSION_COOKIE = "pl_session";

// Limits for a public demo: each sign-up creates a Canton party and needs 2 of 3 approvals.
const LIMITS: Record<string, { max: number; windowMs: number }> = {
  code: { max: 10, windowMs: 3600_000 },
  account: { max: 5, windowMs: 3600_000 },
  text: { max: 30, windowMs: 60_000 },
  api: { max: 300, windowMs: 60_000 },
};
const hits = new Map<string, { count: number; resetAt: number }>();

/** Fixed-window rate limit per client and bucket; throws a UserError when exceeded. */
function rateLimit(client: string, bucket: keyof typeof LIMITS): void {
  const limit = LIMITS[bucket]!;
  const key = `${bucket}:${client}`;
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || entry.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + limit.windowMs });
    if (hits.size > 50_000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    return;
  }
  entry.count += 1;
  if (entry.count > limit.max) throw new RateLimitError("Too many requests. Please wait a little and try again.");
}

class RateLimitError extends UserError {}

/** The client's address; behind the HTTPS proxy (TRUST_PROXY=1) it is the first X-Forwarded-For hop. */
function clientAddress(request: IncomingMessage): string {
  const forwarded = process.env.TRUST_PROXY === "1" ? (request.headers["x-forwarded-for"] as string | undefined) : undefined;
  return forwarded?.split(",")[0]?.trim() || request.socket.remoteAddress || "unknown";
}

async function readBody(request: IncomingMessage, limit = 64 * 1024): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new UserError("Request too large.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

function cookie(request: IncomingMessage, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function sessionCookie(token: string, request: IncomingMessage): string {
  const secure = request.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 3600}${secure}`;
}

function field(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || value.trim() === "") throw new UserError(`Missing ${name}.`);
  return value;
}

export function startServer(options: ServerOptions): void {
  const { app, simulator, log } = options;

  const requireUser = (request: IncomingMessage): User => {
    const user = app.userForSession(cookie(request, SESSION_COOKIE));
    if (!user) throw new UserError("Please sign in.");
    return user;
  };

  const handleApi = async (request: IncomingMessage, response: ServerResponse, path: string): Promise<void> => {
    const method = request.method ?? "GET";
    const client = clientAddress(request);
    rateLimit(client, "api");
    if (path === "/api/signup/start" || path === "/api/signin/start" || path === "/api/signup/phone" || path === "/api/me/phone") rateLimit(client, "code");
    if (path === "/api/signup/finish") rateLimit(client, "account");
    if (path === "/api/sim/send") rateLimit(client, "text");
    const body = method === "POST" ? JSON.parse((await readBody(request)) || "{}") as Record<string, unknown> : {};

    if (method === "GET" && path === "/api/status") return json(response, 200, options.status());
    if (method === "GET" && path === "/api/prices") {
      const rows = await Promise.all(ASSETS.map(async (asset) => {
        try {
          const quote = await app.options.desk.indicative(asset.symbol);
          const market = await app.options.feed.market(asset.symbol).catch(() => null);
          return { symbol: asset.symbol, name: asset.name, unit: asset.unit, alias: asset.aliases[0], ...quote, market };
        } catch {
          return { symbol: asset.symbol, name: asset.name, unit: asset.unit, alias: asset.aliases[0], unavailable: true };
        }
      }));
      return json(response, 200, { mode: app.options.feed.label, spread: app.options.desk.spread, assets: rows });
    }

    if (method === "POST") {
      switch (path) {
        case "/api/signup/start":
          return json(response, 200, await app.startSignup(field(body, "email")));
        case "/api/signup/email":
          return json(response, 200, await app.verifySignupEmail(field(body, "email"), field(body, "code")));
        case "/api/signup/phone":
          return json(response, 200, await app.signupPhone(field(body, "token"), field(body, "phone")));
        case "/api/signup/verify-phone":
          await app.verifySignupPhone(field(body, "token"), field(body, "code"));
          return json(response, 200, { ok: true });
        case "/api/signup/finish": {
          const result = await app.finishSignup(field(body, "token"), field(body, "pin"));
          return json(response, 200, { accountId: result.accountId }, { "Set-Cookie": sessionCookie(result.sessionToken, request) });
        }
        case "/api/signin/start":
          return json(response, 200, await app.startSignin(field(body, "email")));
        case "/api/signin/finish": {
          const result = await app.finishSignin(field(body, "email"), field(body, "code"));
          return json(response, 200, { ok: true }, { "Set-Cookie": sessionCookie(result.sessionToken, request) });
        }
        case "/api/signout": {
          const token = cookie(request, SESSION_COOKIE);
          if (token) app.signOut(token);
          return json(response, 200, { ok: true }, { "Set-Cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0` });
        }
        case "/api/me/lock":
          app.lock(requireUser(request));
          return json(response, 200, { ok: true });
        case "/api/me/unlock":
          app.unlock(requireUser(request));
          return json(response, 200, { ok: true });
        case "/api/me/phone":
          return json(response, 200, await app.requestPhoneChange(requireUser(request), field(body, "phone")));
        case "/api/me/phone/confirm":
          return json(response, 200, await app.confirmPhoneChange(requireUser(request), field(body, "code")));
        case "/api/sim/send": {
          const phone = normalizeE164(field(body, "phone"));
          if (!isSimulatorPhone(phone)) throw new UserError("The simulator only uses +999 numbers.");
          const text = field(body, "body").slice(0, 480);
          simulator.record(phone, "in", text);
          void app.receive({ from: phone, body: text, msgId: randomUUID() });
          return json(response, 200, { ok: true });
        }
      }
    }
    if (method === "GET") {
      switch (path) {
        case "/api/me":
          return json(response, 200, await app.accountView(requireUser(request)));
        case "/api/privacy":
          return json(response, 200, await app.privacyView(requireUser(request)));
        case "/api/sim/messages": {
          const url = new URL(request.url ?? "/", "http://localhost");
          const phone = normalizeE164(url.searchParams.get("phone") ?? "");
          if (!isSimulatorPhone(phone)) throw new UserError("The simulator only uses +999 numbers.");
          return json(response, 200, { messages: simulator.conversation(phone, Number(url.searchParams.get("after") ?? 0)) });
        }
      }
    }
    json(response, 404, { error: "Not found." });
  };

  const handleWebhook = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const raw = await readBody(request);
    try {
      const sms = parseSmsGateWebhook(raw, {
        signature: request.headers["x-signature"] as string | undefined,
        timestamp: request.headers["x-timestamp"] as string | undefined,
      }, options.webhookSecret, options.onlySim);
      json(response, 200, { ok: true });
      if (sms) void app.receive(sms);
    } catch (error) {
      if (error instanceof BadSignatureError) return json(response, 403, { error: "bad signature" });
      throw error;
    }
  };

  const serveStatic = async (response: ServerResponse, path: string): Promise<void> => {
    const file = PAGES[path] ?? (path.startsWith("/static/") && !path.includes("..") ? path.slice(1) : undefined);
    if (!file) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return void response.end("Not found");
    }
    try {
      const data = await readFile(WEB_ROOT + file);
      response.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
      response.end(data);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  };

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    // Signed-in pages redirect before any HTML loads, so there is no flash of an empty account.
    if ((path === "/account" || path === "/privacy") && !app.userForSession(cookie(request, SESSION_COOKIE))) {
      response.writeHead(302, { Location: `/signin?next=${encodeURIComponent(path)}` });
      return void response.end();
    }
    const work = path.startsWith("/api/")
      ? handleApi(request, response, path)
      : path === "/sms/webhook" && request.method === "POST"
        ? handleWebhook(request, response)
        : serveStatic(response, path);
    work.catch((error: unknown) => {
      if (response.headersSent) return;
      if (error instanceof RateLimitError) return json(response, 429, { error: error.message });
      if (error instanceof UserError) return json(response, 400, { error: error.message });
      if (error instanceof SyntaxError) return json(response, 400, { error: "Invalid request." });
      log(`${request.method} ${path} failed: ${error instanceof Error ? error.stack ?? error.message : error}`);
      json(response, 500, { error: "Something went wrong on our side. Please try again." });
    });
  });
  server.listen(options.port, options.host ?? "::", () => log(`PrivateLine is on http://${options.host ?? "localhost"}:${options.port}`));
}
