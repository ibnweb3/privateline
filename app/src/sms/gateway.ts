// SMS in and out. Two gateways:
//   - sms-gate.app (SMS Gateway for Android): an Android phone with any SIM relays texts. Ported
//     from BinaText's src/sms/smsgate.ts. The webhook is signed with HMAC-SHA256 over
//     `${x-timestamp}${rawBody}` (hex in x-signature), confirmed against a real capture.
//   - the simulator: a phone on the PrivateLine website, so the demo runs without a real phone.

import { createHmac, timingSafeEqual } from "node:crypto";

import { normalizeE164 } from "./phone.ts";

export interface InboundSms {
  /** Sender, E.164. */
  from: string;
  body: string;
  /** Provider message id, for de-duplication (gateways retry webhooks). */
  msgId: string;
}

export interface SmsGateway {
  readonly name: string;
  send(to: string, body: string): Promise<void>;
}

export class BadSignatureError extends Error {}

interface SmsGateWebhook {
  event?: string;
  payload?: {
    messageId?: string;
    message?: string;
    /** Newer app versions. */
    sender?: string;
    /** Older app versions. */
    phoneNumber?: string;
    /** Which SIM received it (1 or 2), on dual-SIM phones. */
    simNumber?: number;
  };
}

/**
 * Verify and parse an sms-gate.app `sms:received` webhook. Returns null for events we don't act
 * on, and for texts that arrived on another SIM when `onlySim` is set (a dual-SIM phone can serve
 * PrivateLine on one SIM and something else on the other).
 */
export function parseSmsGateWebhook(raw: string, headers: { signature?: string; timestamp?: string },
  secret: string | undefined, onlySim?: number): InboundSms | null {
  if (secret) {
    const expected = createHmac("sha256", secret).update(`${headers.timestamp ?? ""}${raw}`).digest("hex");
    const given = (headers.signature ?? "").trim().toLowerCase().replace(/^sha256=/, "");
    if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
      throw new BadSignatureError("sms-gate webhook signature mismatch");
    }
  }
  let data: SmsGateWebhook;
  try {
    data = JSON.parse(raw) as SmsGateWebhook;
  } catch {
    return null;
  }
  if (data.event && data.event !== "sms:received") return null;
  const payload = data.payload ?? {};
  if (onlySim !== undefined && payload.simNumber !== undefined && payload.simNumber !== onlySim) return null;
  const sender = payload.sender ?? payload.phoneNumber;
  if (!sender || payload.message === undefined || !payload.messageId) return null;
  try {
    return { from: normalizeE164(sender), body: payload.message.trim(), msgId: payload.messageId };
  } catch {
    return null;
  }
}

/** Send through the sms-gate.app cloud API. */
export class SmsGateGateway implements SmsGateway {
  readonly name = "sms-gate.app";
  private readonly auth: string;
  private readonly apiBase: string;
  private readonly simNumber: number | undefined;

  constructor(options: { username: string; password: string; apiBase?: string; simNumber?: number }) {
    this.auth = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`;
    this.apiBase = options.apiBase ?? "https://api.sms-gate.app/3rdparty/v1";
    this.simNumber = options.simNumber;
  }

  async send(to: string, body: string): Promise<void> {
    const response = await fetch(`${this.apiBase}/messages`, {
      method: "POST",
      headers: { authorization: this.auth, "content-type": "application/json" },
      body: JSON.stringify({ message: body, phoneNumbers: [to], ...(this.simNumber ? { simNumber: this.simNumber } : {}) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`sms-gate send returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
}

export interface SimulatedMessage {
  id: number;
  phone: string;
  direction: "in" | "out";
  body: string;
  at: number;
}

/** Keeps the simulator phones' conversations in memory. */
export class SimulatorGateway implements SmsGateway {
  readonly name = "simulator";
  private readonly messages: SimulatedMessage[] = [];
  private nextId = 1;

  record(phone: string, direction: "in" | "out", body: string): void {
    this.messages.push({ id: this.nextId++, phone, direction, body, at: Date.now() });
    if (this.messages.length > 2000) this.messages.splice(0, this.messages.length - 2000);
  }

  async send(to: string, body: string): Promise<void> {
    this.record(to, "out", body);
  }

  conversation(phone: string, afterId = 0): SimulatedMessage[] {
    return this.messages.filter((message) => message.phone === phone && message.id > afterId);
  }
}

/**
 * Simulator phones use country code +999, which is unassigned, so a simulated number can never
 * reach a real person's phone.
 */
export const SIMULATOR_PREFIX = "+999";

export function isSimulatorPhone(e164: string): boolean {
  return e164.startsWith(SIMULATOR_PREFIX);
}

/** Send +999 numbers to the simulator and every other number to the real gateway, if configured. */
export class RoutingGateway implements SmsGateway {
  readonly name: string;
  readonly simulator: SimulatorGateway;
  private readonly real: SmsGateway | undefined;

  constructor(simulator: SimulatorGateway, real?: SmsGateway) {
    this.simulator = simulator;
    this.real = real;
    this.name = real ? `${real.name} + simulator` : "simulator only";
  }

  get hasRealGateway(): boolean {
    return this.real !== undefined;
  }

  async send(to: string, body: string): Promise<void> {
    if (isSimulatorPhone(to)) return this.simulator.send(to, body);
    if (!this.real) throw new Error("no real SMS gateway is configured; only +999 simulator numbers work");
    return this.real.send(to, body);
  }
}
