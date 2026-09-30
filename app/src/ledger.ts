// Minimal client for the Canton JSON Ledger API v2 of one participant.
// Values use the Daml-LF JSON encoding: Decimal and Int as strings, a DA.Map as a list of
// [key, value] pairs, an enum as its constructor name, and a variant as {tag, value}.

import { randomUUID } from "node:crypto";

export interface Contract<T = Record<string, unknown>> {
  contractId: string;
  templateId: string;
  payload: T;
  createdAt: string;
  /** Parties who signed the contract. */
  signatories: string[];
  /** Parties who can see it without having signed. */
  observers: string[];
}

interface CreatedEvent {
  contractId: string;
  templateId: string;
  createArgument: Record<string, unknown>;
  createdAt: string;
  signatories: string[];
  observers: string[];
}

type Event = { CreatedEvent?: CreatedEvent; ArchivedEvent?: unknown; ExercisedEvent?: unknown };

export interface Transaction {
  updateId: string;
  events: Event[];
}

export type Command =
  | { CreateCommand: { templateId: string; createArguments: Record<string, unknown> } }
  | { ExerciseCommand: { templateId: string; contractId: string; choice: string; choiceArgument: Record<string, unknown> } };

export class Ledger {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly userId: string;

  constructor(baseUrl: string, token: string, userId: string) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.userId = userId;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const response = await fetch(this.baseUrl + path, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Ledger ${method} ${this.baseUrl}${path} returned ${response.status}: ${text}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** The local party whose id starts with `hint::`, if this participant hosts one. */
  async findParty(hint: string): Promise<string | undefined> {
    let pageToken = "";
    do {
      const result = await this.request<{ partyDetails: { party: string; isLocal: boolean }[]; nextPageToken?: string }>(
        "GET", `/v2/parties?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`);
      const found = result.partyDetails.find((details) => details.isLocal && details.party.startsWith(`${hint}::`));
      if (found) return found.party;
      pageToken = result.nextPageToken ?? "";
    } while (pageToken);
    return undefined;
  }

  /** Allocate a party hosted on this participant and let the API user act and read as it. */
  async allocateParty(hint: string): Promise<string> {
    const result = await this.request<{ partyDetails: { party: string } }>("POST", "/v2/parties", { partyIdHint: hint });
    const party = result.partyDetails.party;
    await this.grantRights(party);
    return party;
  }

  /** Find the party, or allocate it if it doesn't exist yet. */
  async ensureParty(hint: string): Promise<string> {
    const existing = await this.findParty(hint);
    if (existing) {
      await this.grantRights(existing);
      return existing;
    }
    return this.allocateParty(hint);
  }

  async grantRights(party: string): Promise<void> {
    await this.request("POST", `/v2/users/${encodeURIComponent(this.userId)}/rights`, {
      userId: this.userId,
      identityProviderId: "",
      rights: [
        { kind: { CanActAs: { value: { party } } } },
        { kind: { CanReadAs: { value: { party } } } },
      ],
    });
  }

  /** Submit commands atomically and return the resulting transaction (creates and archives visible to the submitters). */
  async submit(actAs: string[], commands: Command[], readAs: string[] = []): Promise<Transaction> {
    const result = await this.request<{ transaction: Transaction }>("POST", "/v2/commands/submit-and-wait-for-transaction", {
      commands: { commands, commandId: randomUUID(), userId: this.userId, actAs, readAs },
    });
    return result.transaction;
  }

  /** Create one contract and return its id. */
  async create(actAs: string, templateId: string, createArguments: Record<string, unknown>): Promise<string> {
    const transaction = await this.submit([actAs], [{ CreateCommand: { templateId, createArguments } }]);
    const created = createdEvents(transaction).find((event) => sameTemplate(event.templateId, templateId));
    if (!created) throw new Error(`no ${templateId} contract in transaction ${transaction.updateId}`);
    return created.contractId;
  }

  async exercise(actAs: string[], templateId: string, contractId: string, choice: string,
    choiceArgument: Record<string, unknown>, readAs: string[] = []): Promise<Transaction> {
    return this.submit(actAs, [{ ExerciseCommand: { templateId, contractId, choice, choiceArgument } }], readAs);
  }

  /** Active contracts of one template that `party` can see on this participant. */
  async query<T = Record<string, unknown>>(party: string, templateId: string): Promise<Contract<T>[]> {
    const { offset } = await this.request<{ offset: number }>("GET", "/v2/state/ledger-end");
    const entries = await this.request<{ contractEntry?: { JsActiveContract?: { createdEvent: CreatedEvent } } }[]>(
      "POST", "/v2/state/active-contracts", {
        activeAtOffset: offset,
        eventFormat: {
          filtersByParty: {
            [party]: { cumulative: [{ identifierFilter: { TemplateFilter: { value: { templateId, includeCreatedEventBlob: false } } } }] },
          },
          verbose: true,
        },
      });
    return entries.flatMap((entry) => {
      const event = entry.contractEntry?.JsActiveContract?.createdEvent;
      return event
        ? [{
          contractId: event.contractId,
          templateId: event.templateId,
          payload: event.createArgument as T,
          createdAt: event.createdAt,
          signatories: event.signatories ?? [],
          observers: event.observers ?? [],
        }]
        : [];
    });
  }
}

export function createdEvents(transaction: Transaction): CreatedEvent[] {
  return transaction.events.flatMap((event) => (event.CreatedEvent ? [event.CreatedEvent] : []));
}

/**
 * Whether an event's template id (package-id format, `<pkgId>:Module:Entity`) names the same
 * template as a package-name reference (`#pkg-name:Module:Entity`).
 */
export function sameTemplate(eventTemplateId: string, reference: string): boolean {
  const moduleAndEntity = (id: string) => id.split(":").slice(1).join(":");
  return moduleAndEntity(eventTemplateId) === moduleAndEntity(reference);
}
