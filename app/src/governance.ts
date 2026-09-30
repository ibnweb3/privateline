// Drive a PrivateLine proposal through BitSafe's 2-of-3 approval: members confirm on their own
// DecMan nodes, then one member executes. DecMan indexes the ledger, so each step waits for the
// node to see the proposal and the confirmations first.

import type { DecMan, PendingAction } from "./decman.ts";

const POLL_MS = 1000;
const TIMEOUT_MS = 120_000;

async function waitFor<T>(what: string, check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const found = await check();
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export function waitForPending(node: DecMan, vault: string, proposalCid: string): Promise<PendingAction> {
  return waitFor(`${node.baseUrl} to list proposal ${proposalCid.slice(0, 12)}`, async () =>
    (await node.pendingActions(vault)).find((action) => action.proposal_cid === proposalCid));
}

export interface Approval {
  confirmedOn: string[];
  executedOn: string;
  confirmations: number;
}

/**
 * Confirm `proposalCid` on each of `confirmers` (each node confirms as its own member), then
 * execute it on `executor`. Throws with DecMan's error if execution fails, for example when a
 * check inside the proposal fails at execution time.
 */
export async function approve(vault: string, proposalCid: string, confirmers: DecMan[], executor: DecMan,
  log: (line: string) => void = () => {}): Promise<Approval> {
  const rulesCid = await executor.rulesCid(vault);
  for (const node of confirmers) {
    await waitForPending(node, vault, proposalCid);
    await node.confirm(vault, rulesCid, proposalCid);
    log(`confirmed on ${node.baseUrl}`);
  }
  const ready = await waitFor(`the proposal to reach the threshold on ${executor.baseUrl}`, async () => {
    const action = (await executor.pendingActions(vault)).find((pending) => pending.proposal_cid === proposalCid);
    return action?.can_execute ? action : undefined;
  });
  const confirmationCids = ready.confirmations.map((confirmation) => confirmation.contract_id);
  await executor.execute(vault, rulesCid, proposalCid, confirmationCids);
  log(`executed on ${executor.baseUrl} with ${confirmationCids.length} confirmations`);
  await waitFor(`the proposal to leave the pending list on ${executor.baseUrl}`, async () =>
    (await executor.pendingActions(vault)).some((pending) => pending.proposal_cid === proposalCid) ? undefined : true);
  return { confirmedOn: confirmers.map((node) => node.baseUrl), executedOn: executor.baseUrl, confirmations: confirmationCids.length };
}
