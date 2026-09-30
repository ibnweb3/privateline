// Endpoints of BitSafe's Decentralization Manager LocalNet (DLC-link/decentralization-manager,
// branch `hackathon`): one Canton participant and one DecMan node per operator.

export interface OperatorNode {
  /** Who runs this node in PrivateLine. */
  role: string;
  /** DecMan REST API and dashboard. */
  decman: string;
  /** Canton JSON Ledger API v2 of the node's participant. */
  ledger: string;
}

export const nodes = {
  operator: { role: "SMS operator (node 1)", decman: "http://localhost:8081", ledger: "http://localhost:3975" },
  priceChecker: { role: "price checker (node 2)", decman: "http://localhost:8082", ledger: "http://localhost:2975" },
  riskChecker: { role: "risk checker (node 3)", decman: "http://localhost:8083", ledger: "http://localhost:4975" },
} satisfies Record<string, OperatorNode>;

export type NodeName = keyof typeof nodes;

// LocalNet's unsafe-auth JWT (HS256 over the dev secret, sub=ledger-api-user, no expiry), published
// in BitSafe's hackathon/localnet.sh. It only works against LocalNet; set LEDGER_TOKEN anywhere else.
const LOCALNET_DEV_TOKEN =
  "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJodHRwczovL2NhbnRvbi5uZXR3b3JrLmdsb2JhbCIsImlhdCI6MTc2Mzc0ODcwMiwic3ViIjoibGVkZ2VyLWFwaS11c2VyIn0.vpkfH4SoM9AZqbE38W4hrvl3xxy69jYs4u8gveskw9k";

export const ledgerToken = process.env.LEDGER_TOKEN ?? LOCALNET_DEV_TOKEN;
export const ledgerUserId = process.env.LEDGER_USER_ID ?? "ledger-api-user";

/** Name of the decentralized party that is PrivateLine's vault (a prefix; Canton appends `::<fingerprint>`). */
export const vaultPartyPrefix = process.env.VAULT_PARTY_PREFIX ?? "privateline-vault";
