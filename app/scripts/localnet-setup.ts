// Put PrivateLine on BitSafe's LocalNet. Safe to run again: each step checks what already exists.
//   1. Find the vault (the `privateline-vault` decentralized party) and each node's member party.
//   2. Distribute the PrivateLine DAR to all three participants through DecMan's workflow.
//   3. Allocate the demo desk party and create its faucet and settlement agreement.
// Needs the LocalNet stack (hackathon/up.sh), scripts/dev/localnet-vault.sh, and a built DAR
// (scripts/dev/daml-test.sh).

import { readFile } from "node:fs/promises";

import { DecMan } from "../src/decman.ts";
import { decman, findMembers, findVault, ledgers, saveDeployment, type Deployment } from "../src/localnet.ts";
import { templates } from "../src/privateline.ts";

const DAR_NAME = "privateline-v0-0.2.0.dar";
const DAR = new URL(`../../daml/privateline/.daml/dist/${DAR_NAME}`, import.meta.url);
// A template that first appears in this DAR version: if a participant can't resolve it, that
// participant doesn't have this version yet.
const NEWEST_TEMPLATE = templates.checkRefusal;

const log = (line: string) => console.log(line);

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 300_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function acceptInvitation(node: DecMan, kind: string): Promise<void> {
  let id: string | undefined;
  await waitFor(`a ${kind} invitation on ${node.baseUrl}`, async () => {
    id = (await node.invitations()).find((invitation) => invitation.invitation_type === kind)?.id;
    return id !== undefined;
  });
  await node.acceptInvitation(id!);
  log(`  ${node.baseUrl} accepted the ${kind} invitation`);
}

/** Whether every participant already has this version of the PrivateLine package. */
async function darOnAllNodes(vault: string): Promise<boolean> {
  const checks = Object.values(ledgers).map((ledger) =>
    ledger.query(vault, NEWEST_TEMPLATE).then(() => true, () => false));
  return (await Promise.all(checks)).every(Boolean);
}

async function distributeDar(vault: string): Promise<void> {
  if (await darOnAllNodes(vault)) {
    log("PrivateLine DAR: already on all three participants");
    return;
  }
  log("PrivateLine DAR: distributing through DecMan (node 1 proposes, nodes 2 and 3 accept)");
  const data = (await readFile(DAR)).toString("base64");
  const peers = [await decman.priceChecker.participantId(), await decman.riskChecker.participantId()];
  await decman.operator.distributeDars([{ filename: DAR_NAME, data }], peers);
  await acceptInvitation(decman.priceChecker, "Dars");
  await acceptInvitation(decman.riskChecker, "Dars");
  await waitFor("the DAR distribution workflow", async () => {
    const { status, error } = await decman.operator.workflowStatus("/dars/distribute/status");
    if (status === "failed" || status === "cancelled") throw new Error(`DAR distribution ${status}: ${error ?? "unknown error"}`);
    return status === "completed";
  });
  await waitFor("the package on every participant", () => darOnAllNodes(vault), 60_000);
  log("  distributed and vetted on all three participants");
}

async function main(): Promise<void> {
  const vault = await findVault();
  log(`vault: ${vault}`);
  const members = await findMembers(vault);
  log(`members: SMS operator ${members.operator}\n         price checker ${members.priceChecker}\n         risk checker ${members.riskChecker}`);

  await distributeDar(vault);

  // LocalNet has three participants, so the demo desk lives on node 2's.
  const deskLedger = ledgers.priceChecker;
  const desk = await deskLedger.ensureParty("privateline-desk");
  log(`desk: ${desk}`);

  const faucets = (await deskLedger.query<{ vault: string }>(desk, templates.demoFaucet))
    .filter((contract) => contract.payload.vault === vault);
  const faucetCid = faucets[0]?.contractId
    ?? await deskLedger.create(desk, templates.demoFaucet, { desk, vault, maxPerMint: "1000.0" });
  log(`demo faucet: ${faucetCid.slice(0, 16)}… (at most $1000 demo dollars per mint)`);

  const agreements = (await deskLedger.query<{ vault: string }>(desk, templates.deskAgreement))
    .filter((contract) => contract.payload.vault === vault);
  const deskAgreementCid = agreements[0]?.contractId
    ?? await deskLedger.create(desk, templates.deskAgreement, { desk, vault });
  log(`desk agreement: ${deskAgreementCid.slice(0, 16)}…`);

  const deployment: Deployment = { vault, members, desk, faucetCid, deskAgreementCid };
  await saveDeployment(deployment);
  log("saved to app/.localnet.json");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
