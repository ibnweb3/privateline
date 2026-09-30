// Client for BitSafe's Decentralization Manager REST API (one instance per operator node).
// Confirm and execute are package-agnostic for `core_domain` actions: they only need the
// proposal's contract id, so PrivateLine's own GovernableAction templates need no DecMan changes.

// `action` is required by the request schema but ignored for core_domain. BitSafe's own clients
// send this zero placeholder, and DecMan's local audit log stores the request as sent.
const PLACEHOLDER_ACTION = { type: "governance_set_threshold", new_threshold: 0 };

export interface PendingAction {
  proposal_cid: string;
  action_label: string;
  description: string;
  proposer: string;
  /** Epoch seconds. */
  created_at: number;
  can_execute: boolean;
  confirmation_count: number;
  confirmations: { contract_id: string; confirming_party: string; created_at: number; expires_at: number }[];
}

export interface AuditEntry {
  event_type: string;
  update_id?: string;
  offset?: number;
  timestamp?: string;
  acting_parties?: string[];
  contract_id?: string;
}

export class DecMan {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private async request<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
    const response = await fetch(this.baseUrl + path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`DecMan ${method} ${this.baseUrl}${path} returned ${response.status}: ${text}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async participantId(): Promise<string> {
    const config = await this.request<{ node: { participant_id: string } }>("GET", "/node-config");
    return config.node.participant_id;
  }

  async decentralizedParties(): Promise<{ party_id: string }[]> {
    const result = await this.request<{ parties?: { party_id: string }[] }>("GET", "/decentralized-parties");
    return result.parties ?? [];
  }

  /** The live GovernanceRules contract of a decentralized party (it changes when rules change). */
  async rulesCid(party: string): Promise<string> {
    const result = await this.request<{ state?: { contract_id?: string } }>(
      "GET", `/governance/state?party_id=${encodeURIComponent(party)}`);
    const cid = result.state?.contract_id;
    if (!cid) throw new Error(`no GovernanceRules contract for ${party} on ${this.baseUrl}`);
    return cid;
  }

  async pendingActions(party: string): Promise<PendingAction[]> {
    const result = await this.request<{ domain_actions?: PendingAction[] }>(
      "GET", `/governance/confirmations?party_id=${encodeURIComponent(party)}`);
    return result.domain_actions ?? [];
  }

  /** This node's member confirms a proposal (GovernanceRules_ConfirmAction). */
  async confirm(party: string, rulesCid: string, proposalCid: string): Promise<void> {
    await this.request("POST", "/governance/confirm", {
      party_id: party,
      rules_contract_id: rulesCid,
      action: PLACEHOLDER_ACTION,
      governance_type: "core_domain",
      proposal_cid: proposalCid,
    });
  }

  /** This node's member executes a proposal with the given confirmations (GovernanceRules_ExecuteConfirmedAction). */
  async execute(party: string, rulesCid: string, proposalCid: string, confirmationCids: string[]): Promise<void> {
    await this.request("POST", "/governance/execute", {
      party_id: party,
      rules_contract_id: rulesCid,
      action: PLACEHOLDER_ACTION,
      confirmation_cids: confirmationCids,
      disclosed_contracts: [],
      governance_type: "core_domain",
      proposal_cid: proposalCid,
    });
  }

  /** Start the multi-party workflow that uploads and vets DARs on this node and every peer. */
  async distributeDars(files: { filename: string; data: string }[], peerIds: string[]): Promise<void> {
    await this.request("POST", "/dars/distribute", { dar_files: files, peer_ids: peerIds });
  }

  async invitations(): Promise<{ id: string; invitation_type: string }[]> {
    const result = await this.request<{ invitations?: { id: string; invitation_type: string }[] }>("GET", "/invitations");
    return result.invitations ?? [];
  }

  async acceptInvitation(id: string): Promise<void> {
    await this.request("POST", "/invitations/accept", { id });
  }

  async workflowStatus(path: string): Promise<{ status?: string; error?: string }> {
    return this.request("GET", path);
  }

  async chainAudit(party: string, limit = 20): Promise<AuditEntry[]> {
    const result = await this.request<{ entries?: AuditEntry[] }>(
      "GET", `/governance/chain-audit?party_id=${encodeURIComponent(party)}&limit=${limit}&refresh=true`);
    return result.entries ?? [];
  }
}
