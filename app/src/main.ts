// Start PrivateLine on BitSafe's LocalNet: the website and SMS service (the SMS operator, node 1),
// the demo desk, and, unless CHECKERS=off, the two independent checkers (nodes 2 and 3). In a real
// deployment each checker runs on its own operator's machines (scripts/checker.ts).

import { PrivateLine } from "./app.ts";
import { Checker } from "./checker.ts";
import { policyFromEnv } from "./checks.ts";
import { Db } from "./db.ts";
import { Desk } from "./desk.ts";
import { decman, ledgers, loadDeployment } from "./localnet.ts";
import { Operator } from "./operator.ts";
import { feedFromEnv } from "./prices.ts";
import { paymentsWebhookSecret } from "./secrets.ts";
import { startServer } from "./server.ts";
import { realNumberPolicy, RoutingGateway, SimulatorGateway, SmsGateGateway } from "./sms/gateway.ts";
import { normalizeE164 } from "./sms/phone.ts";

const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

const deployment = await loadDeployment();
const feed = await feedFromEnv();
const db = new Db();
const simulator = new SimulatorGateway();
const env = process.env;
const onlySim = env.SMSGATE_SIM ? Number(env.SMSGATE_SIM) : undefined;
const realGateway = env.SMSGATE_USERNAME && env.SMSGATE_PASSWORD
  ? new SmsGateGateway({ username: env.SMSGATE_USERNAME, password: env.SMSGATE_PASSWORD, ...(onlySim ? { simNumber: onlySim } : {}) })
  : undefined;
const gateway = new RoutingGateway(simulator, realGateway, realNumberPolicy(env.REAL_SMS_ALLOW, normalizeE164));

const desk = new Desk({ ledger: ledgers.priceChecker, desk: deployment.desk, vault: deployment.vault, feed });
const operator = new Operator({ deployment, decman: decman.operator, ledger: ledgers.operator, desk, log: (line) => log(`[operator] ${line}`) });

const phoneChangeCooldownSeconds = Number(env.PHONE_CHANGE_COOLDOWN_SECONDS ?? 24 * 3600);
const app = new PrivateLine({
  db,
  gateway,
  operator,
  desk,
  deployment,
  operatorLedger: ledgers.operator,
  deskLedger: ledgers.priceChecker,
  feed,
  publicUrl: env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 8790}`,
  startingDollars: Number(env.STARTING_DOLLARS ?? 100),
  dailyLimit: Number(env.DAILY_LIMIT ?? 200),
  phoneChangeCooldownSeconds,
  emailMode: "dev",
  paymentsSecret: paymentsWebhookSecret(),
  log,
});

const checkers: Checker[] = [];
if (env.CHECKERS !== "off") {
  const policy = policyFromEnv();
  checkers.push(
    new Checker({ name: "price checker", decman: decman.priceChecker, ledger: ledgers.priceChecker, member: deployment.members.priceChecker, vault: deployment.vault, feed: await feedFromEnv(), policy, log }),
    new Checker({ name: "risk checker", decman: decman.riskChecker, ledger: ledgers.riskChecker, member: deployment.members.riskChecker, vault: deployment.vault, feed: await feedFromEnv(), policy, log }),
  );
  for (const checker of checkers) checker.start();
}

app.startJobs();
startServer({
  app,
  simulator,
  port: Number(env.PORT ?? 8790),
  ...(env.HOST ? { host: env.HOST } : {}),
  ...(env.SMSGATE_WEBHOOK_SECRET ? { webhookSecret: env.SMSGATE_WEBHOOK_SECRET } : {}),
  ...(onlySim ? { onlySim } : {}),
  log,
  status: () => ({
    vault: deployment.vault,
    prices: feed.label,
    sms: gateway.name,
    phoneChangeCooldownSeconds,
    checkers: checkers.map((checker) => ({ name: checker.name, lastTickAt: checker.lastTickAt, lastError: checker.lastError || null })),
  }),
});
log(`prices: ${feed.label}; SMS: ${gateway.name}; checkers: ${checkers.length ? checkers.map((checker) => checker.name).join(", ") : "off"}`);
