// PrivateLine's deployment on BitSafe's LocalNet: who the vault, members and desk are, and the
// desk's standing contracts. `npm run localnet:setup` builds it and saves it to .localnet.json.

import { readFile, writeFile } from "node:fs/promises";

import { ledgerToken, ledgerUserId, nodes, vaultPartyPrefix, type NodeName } from "./config.ts";
import { DecMan } from "./decman.ts";
import { Ledger } from "./ledger.ts";
import { templates, type GovernanceRules } from "./privateline.ts";

export interface Deployment {
  /** The decentralized party: signs every account and holds the tokens. */
  vault: string;
  /** The member party each operator node confirms and executes as. */
  members: Record<NodeName, string>;
  /** The demo desk and token issuer, hosted on node 2's participant (LocalNet has only three). */
  desk: string;
  faucetCid: string;
  deskAgreementCid: string;
}

export const decman: Record<NodeName, DecMan> = {
  operator: new DecMan(nodes.operator.decman),
  priceChecker: new DecMan(nodes.priceChecker.decman),
  riskChecker: new DecMan(nodes.riskChecker.decman),
};

export const ledgers: Record<NodeName, Ledger> = {
  operator: new Ledger(nodes.operator.ledger, ledgerToken, ledgerUserId),
  priceChecker: new Ledger(nodes.priceChecker.ledger, ledgerToken, ledgerUserId),
  riskChecker: new Ledger(nodes.riskChecker.ledger, ledgerToken, ledgerUserId),
};

const STATE_FILE = new URL("../.localnet.json", import.meta.url);

export async function loadDeployment(): Promise<Deployment> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8")) as Deployment;
  } catch {
    throw new Error("no LocalNet deployment found: run `npm run localnet:setup` first");
  }
}

export async function saveDeployment(deployment: Deployment): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(deployment, null, 2) + "\n");
}

export async function findVault(): Promise<string> {
  const parties = await decman.operator.decentralizedParties();
  const vault = parties.find((party) => party.party_id.startsWith(`${vaultPartyPrefix}::`));
  if (!vault) {
    throw new Error(`no decentralized party ${vaultPartyPrefix} on LocalNet: run scripts/dev/localnet-vault.sh inside WSL first`);
  }
  return vault.party_id;
}

/**
 * Map each node to its member party. A party allocated on a participant carries that participant's
 * namespace, so the member whose id ends in a node's participant fingerprint is that node's member.
 */
export async function findMembers(vault: string): Promise<Record<NodeName, string>> {
  const [rules] = await ledgers.operator.query<GovernanceRules>(vault, templates.governanceRules);
  if (!rules) throw new Error(`no GovernanceRules contract for ${vault}`);
  const members = rules.payload.members.map.map(([party]) => party);
  const memberOn = async (name: NodeName): Promise<string> => {
    const fingerprint = (await decman[name].participantId()).split("::")[1];
    const member = members.find((party) => party.split("::")[1] === fingerprint);
    if (!member) throw new Error(`no governance member is hosted on ${nodes[name].role}`);
    return member;
  };
  return {
    operator: await memberOn("operator"),
    priceChecker: await memberOn("priceChecker"),
    riskChecker: await memberOn("riskChecker"),
  };
}
