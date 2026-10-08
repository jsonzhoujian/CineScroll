export { prepareSourceIngestIdentity, SourceIngestProtocolError } from "./evidence-source-ingest.ts";
export type { SourceIngestReference, InitializeSourceCommand, RegisterSourceCommand, SourceIngestIdentity, PreparedSourceIngestIdentity } from "./evidence-source-ingest.ts";

export type BillingActor = Readonly<{ workspaceId: string; serviceId: string }>;
export type BillingAccess = { authorize(actor: BillingActor, operation: "read" | "grant" | "reserve" | "settle"): Promise<boolean> };
export type GrantCommand = Readonly<{ eventId: string; grantId: string; amount: number; source: string }>;
export type ReserveCommand = Readonly<{
  eventId: string; taskId: string; projectId: string; chapterId: string; sourceVersionId: string;
  quoteId: string; priceVersion: string; responsibility: "platform" | "byok";
  units: ReadonlyArray<Readonly<{ id: string; reserved: number }>>;
}>;
export type CreditEntry = Readonly<{
  workspaceId: string; eventId: string; operation: "grant" | "reserve" | "consume" | "release";
  amount: number; taskId: string | null; unitId: string | null; grantId: string | null;
  evidenceId: string | null; serviceId: string; createdAt: string;
}>;
export type LedgerReceipt = Readonly<{ eventId: string; taskId: string | null; unitId: string | null; status: "applied" | "reconciling" | "exempt"; reason?: "EXECUTION_UNKNOWN" | "QUOTE_EXCEEDED" }>;
export type SettleCommand = Readonly<{ eventId: string; taskId: string; unitId: string; evidenceId: string }>;
export type SettlementEvidence = Readonly<{
  id: string; workspaceId: string; taskId: string; unitId: string; sourceVersionId: string;
  outcome: "succeeded" | "failed" | "unknown"; amount: number | null; resultVersionId: string | null; ruleVersion: string;
}>;
export interface SettlementEvidenceReader { read(actor: BillingActor, evidenceId: string): Promise<unknown> }
type Unit = { id: string; reserved: number; consumed: number; released: number; state: "reserved" | "reconciling" | "consumed" | "released" | "closed" | "exempt" };
export type BillingTask = { snapshot: ReserveCommand; units: Unit[] };
export type LedgerAggregate = {
  revision: number; entries: CreditEntry[]; tasks: BillingTask[];
  events: Array<{ eventId: string; fingerprint: string; receipt: LedgerReceipt }>;
  evidence: Array<{ id: string; fingerprint: string }>;
};
/** The eventual durable adapter must atomically compare revision and replace the aggregate. */
export interface CreditLedgerRepository {
  read(workspaceId: string): Promise<LedgerAggregate>;
  compareAndSwap(workspaceId: string, expectedRevision: number, next: LedgerAggregate): Promise<boolean>;
}
export class InMemoryCreditLedgerRepository implements CreditLedgerRepository {
  readonly #accounts = new Map<string,LedgerAggregate>();
  async read(workspaceId: string) { return structuredClone(this.#accounts.get(workspaceId) ?? { revision: 0,entries: [],tasks: [],events: [],evidence: [] }); }
  async compareAndSwap(workspaceId: string, expectedRevision: number, next: LedgerAggregate) {
    if ((this.#accounts.get(workspaceId)?.revision ?? 0) !== expectedRevision) return false;
    this.#accounts.set(workspaceId,structuredClone(next)); return true;
  }
}
export class CreditLedgerError extends Error {
  readonly code: "INVALID_COMMAND" | "FORBIDDEN" | "INSUFFICIENT_CREDITS" | "EVENT_CONFLICT" | "STATE_CONFLICT" | "TASK_NOT_FOUND" | "INVALID_EVIDENCE" | "STORAGE_UNAVAILABLE";
  constructor(code: CreditLedgerError["code"]) {
    super(code); this.code = code; this.name = "CreditLedgerError";
  }
}
type Options = { repository: CreditLedgerRepository; access: BillingAccess; clock: () => Date; evidenceReader?: SettlementEvidenceReader };
/** Trusted-server domain service only. No HTTP binding, member authority or production billing. */
export class CreditLedgerService {
  readonly #options: Options;
  constructor(options: Options) { this.#options = { ...options }; }
  async grant(actor: BillingActor, input: GrantCommand): Promise<LedgerReceipt> {
    const command = copyCommand(input);
    if (!hasKeys(command,["eventId","grantId","amount","source"]) || ![command.eventId,command.grantId,command.source].every(validId)) throw new CreditLedgerError("INVALID_COMMAND");
    quantity(command.amount,true);
    const trusted = await this.#authorize(actor,"grant");
    return this.#commit(trusted,command.eventId,JSON.stringify(["grant",command.grantId,command.amount,command.source]),state => {
      quantity(command.amount,true);
      if (state.entries.some(e => e.grantId === command.grantId)) throw new CreditLedgerError("STATE_CONFLICT");
      state.entries.push(this.#entry(trusted,command.eventId,"grant",command.amount,null,null,command.grantId));
      return { eventId: command.eventId,taskId: null,unitId: null,status: "applied" };
    });
  }
  async reserve(actor: BillingActor, input: ReserveCommand): Promise<LedgerReceipt> {
    const command = copyCommand(input);
    if (!hasKeys(command,["eventId","taskId","projectId","chapterId","sourceVersionId","quoteId","priceVersion","responsibility","units"])
      || ![command.eventId,command.taskId,command.projectId,command.chapterId,command.sourceVersionId,command.quoteId,command.priceVersion].every(validId)
      || !["platform","byok"].includes(command.responsibility) || !Array.isArray(command.units) || command.units.length < 1 || command.units.length > 100
      || !command.units.every(u => hasKeys(u,["id","reserved"]) && validId(u.id) && Number.isSafeInteger(u.reserved)
        && (command.responsibility === "byok" ? u.reserved === 0 : u.reserved > 0))
      || new Set(command.units.map(u => u.id)).size !== command.units.length) throw new CreditLedgerError("INVALID_COMMAND");
    const units = command.units.slice().sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const snapshot = { ...command,units };
    const trusted = await this.#authorize(actor,"reserve");
    return this.#commit(trusted,command.eventId,JSON.stringify(["reserve",command.taskId,command.projectId,command.chapterId,command.sourceVersionId,
      command.quoteId,command.priceVersion,command.responsibility,units.map(u => [u.id,u.reserved])]),state => {
      if (state.tasks.some(t => t.snapshot.taskId === command.taskId)) throw new CreditLedgerError("STATE_CONFLICT");
      const amount = command.units.reduce((sum,u) => add(sum,u.reserved),0);
      if (balanceOf(state).available < amount) throw new CreditLedgerError("INSUFFICIENT_CREDITS");
      const exempt = command.responsibility === "byok";
      state.tasks.push({ snapshot,units: units.map(u => ({ ...u,consumed: 0,released: 0,state: exempt ? "exempt" : "reserved" })) });
      if (!exempt) for (const unit of command.units) state.entries.push(this.#entry(trusted,command.eventId,"reserve",unit.reserved,command.taskId,unit.id,null));
      return { eventId: command.eventId,taskId: command.taskId,unitId: null,status: exempt ? "exempt" : "applied" };
    });
  }
  async settle(actor: BillingActor, input: SettleCommand): Promise<LedgerReceipt> {
    const command = copyCommand(input);
    if (!hasKeys(command,["eventId","taskId","unitId","evidenceId"]) || !Object.values(command).every(validId)) throw new CreditLedgerError("INVALID_COMMAND");
    const trusted = await this.#authorize(actor,"settle");
    let raw: unknown;
    try { raw = structuredClone(await this.#options.evidenceReader?.read(structuredClone(trusted),command.evidenceId)); }
    catch { throw new CreditLedgerError("INVALID_EVIDENCE"); }
    if (!hasKeys(raw,["id","workspaceId","taskId","unitId","sourceVersionId","outcome","amount","resultVersionId","ruleVersion"])) throw new CreditLedgerError("INVALID_EVIDENCE");
    const evidence = raw as SettlementEvidence;
    if (![evidence.id,evidence.workspaceId,evidence.taskId,evidence.unitId,evidence.sourceVersionId,evidence.ruleVersion].every(validId)) throw new CreditLedgerError("INVALID_EVIDENCE");
    if (evidence.id !== command.evidenceId || evidence.workspaceId !== trusted.workspaceId
      || evidence.taskId !== command.taskId || evidence.unitId !== command.unitId
      || !["succeeded","failed","unknown"].includes(evidence.outcome) || !validId(evidence.ruleVersion)) throw new CreditLedgerError("INVALID_EVIDENCE");
    if (evidence.outcome === "succeeded") {
      if (!validId(evidence.resultVersionId) || !Number.isSafeInteger(evidence.amount) || evidence.amount! < 0) throw new CreditLedgerError("INVALID_EVIDENCE");
    } else if (evidence.amount !== null || evidence.resultVersionId !== null) throw new CreditLedgerError("INVALID_EVIDENCE");
    const fingerprint = JSON.stringify(["settle",command.taskId,command.unitId,evidence.id,evidence.sourceVersionId,
      evidence.outcome,evidence.amount,evidence.resultVersionId,evidence.ruleVersion]);
    return this.#commit(trusted,command.eventId,fingerprint,state => {
      const used = state.evidence.find(e => e.id === evidence.id);
      if (used) throw new CreditLedgerError(used.fingerprint === fingerprint ? "STATE_CONFLICT" : "EVENT_CONFLICT");
      const task = state.tasks.find(t => t.snapshot.taskId === command.taskId);
      if (!task) throw new CreditLedgerError("TASK_NOT_FOUND");
      const unit = task.units.find(u => u.id === command.unitId);
      if (!unit || task.snapshot.sourceVersionId !== evidence.sourceVersionId) throw new CreditLedgerError("INVALID_EVIDENCE");
      state.evidence.push({ id: evidence.id,fingerprint });
      if (task.snapshot.responsibility === "byok") return { eventId: command.eventId,taskId: command.taskId,unitId: unit.id,status: "exempt" };
      if (!["reserved","reconciling"].includes(unit.state)) throw new CreditLedgerError("STATE_CONFLICT");
      if (evidence.outcome === "unknown") {
        unit.state = "reconciling";
        return { eventId: command.eventId,taskId: command.taskId,unitId: unit.id,status: "reconciling",reason: "EXECUTION_UNKNOWN" };
      }
      if (evidence.outcome === "failed") {
        unit.released = unit.reserved; unit.state = "released";
        state.entries.push(this.#entry(trusted,command.eventId,"release",unit.released,command.taskId,unit.id,null,evidence.id));
        return { eventId: command.eventId,taskId: command.taskId,unitId: unit.id,status: "applied" };
      }
      const amount = evidence.amount!;
      if (amount > unit.reserved) {
        unit.state = "reconciling";
        return { eventId: command.eventId,taskId: command.taskId,unitId: unit.id,status: "reconciling",reason: "QUOTE_EXCEEDED" };
      }
      unit.consumed = amount; unit.released = unit.reserved - amount;
      unit.state = unit.released ? "closed" : "consumed";
      if (amount) state.entries.push(this.#entry(trusted,command.eventId,"consume",amount,command.taskId,unit.id,null,evidence.id));
      if (unit.released) state.entries.push(this.#entry(trusted,command.eventId,"release",unit.released,command.taskId,unit.id,null,evidence.id));
      return { eventId: command.eventId,taskId: command.taskId,unitId: unit.id,status: "applied" };
    });
  }
  async balance(actor: BillingActor) { const trusted = await this.#authorize(actor,"read"); return balanceOf(await this.#read(trusted.workspaceId)); }
  async entries(actor: BillingActor) { const trusted = await this.#authorize(actor,"read"); return (await this.#read(trusted.workspaceId)).entries; }
  async task(actor: BillingActor, taskId: string): Promise<BillingTask> {
    if (!validId(taskId)) throw new CreditLedgerError("INVALID_COMMAND");
    const trusted = await this.#authorize(actor,"read"),state = await this.#read(trusted.workspaceId);
    const task = state.tasks.find(t => t.snapshot.taskId === taskId);
    if (!task) throw new CreditLedgerError("TASK_NOT_FOUND");
    return structuredClone(task);
  }
  async #authorize(actor: BillingActor, operation: Parameters<BillingAccess["authorize"]>[1]): Promise<BillingActor> {
    let snapshot: BillingActor;
    try {
      snapshot = structuredClone(actor);
      if (!hasKeys(snapshot,["workspaceId","serviceId"]) || !validId(snapshot.workspaceId) || !validId(snapshot.serviceId)
        || await this.#options.access.authorize(structuredClone(snapshot),operation) !== true) throw new Error();
    } catch { throw new CreditLedgerError("FORBIDDEN"); }
    return snapshot;
  }
  async #read(workspaceId: string) {
    try { return structuredClone(await this.#options.repository.read(workspaceId)); }
    catch { throw new CreditLedgerError("STORAGE_UNAVAILABLE"); }
  }
  async #commit(actor: BillingActor, eventId: string, fingerprint: string, apply: (state: LedgerAggregate) => LedgerReceipt): Promise<LedgerReceipt> {
    if (!validId(eventId)) throw new CreditLedgerError("INVALID_COMMAND");
    for (let attempt = 0; attempt < 20; attempt++) {
      const state = await this.#read(actor.workspaceId);
      const replay = state.events.find(e => e.eventId === eventId);
      if (replay) {
        if (replay.fingerprint !== fingerprint) throw new CreditLedgerError("EVENT_CONFLICT");
        return structuredClone(replay.receipt);
      }
      const receipt = apply(state);
      balanceOf(state);
      state.events.push({ eventId,fingerprint,receipt });
      const expected = state.revision; state.revision++;
      let saved;
      try { saved = await this.#options.repository.compareAndSwap(actor.workspaceId,expected,state); }
      catch { throw new CreditLedgerError("STORAGE_UNAVAILABLE"); }
      if (saved) return structuredClone(receipt);
    }
    throw new CreditLedgerError("STATE_CONFLICT");
  }
  #entry(actor: BillingActor, eventId: string, operation: CreditEntry["operation"], amount: number, taskId: string | null, unitId: string | null, grantId: string | null, evidenceId: string | null = null): CreditEntry {
    return { workspaceId: actor.workspaceId,eventId,operation,amount,taskId,unitId,grantId,evidenceId,serviceId: actor.serviceId,createdAt: this.#options.clock().toISOString() };
  }
}
function validId(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\r\n]/.test(value); }
function copyCommand<T>(value: T): T {
  try { return structuredClone(value); } catch { throw new CreditLedgerError("INVALID_COMMAND"); }
}
function hasKeys(value: unknown, keys: readonly string[]): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}
function quantity(value: number, positive = false): void {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw new CreditLedgerError("INVALID_COMMAND");
}
function add(a: number,b: number): number { quantity(a); quantity(b); const value = a + b; quantity(value); return value; }
function balanceOf(state: LedgerAggregate) {
  let granted = 0,reserved = 0,consumed = 0,released = 0;
  for (const entry of state.entries) {
    switch (entry.operation) {
      case "grant": granted = add(granted,entry.amount); break;
      case "reserve": reserved = add(reserved,entry.amount); break;
      case "consume": consumed = add(consumed,entry.amount); break;
      case "release": released = add(released,entry.amount); break;
    }
  }
  reserved -= consumed + released;
  const available = granted - consumed - reserved;
  if (!Number.isSafeInteger(reserved) || !Number.isSafeInteger(available) || reserved < 0 || available < 0) throw new CreditLedgerError("STATE_CONFLICT");
  return { available,reserved,consumed,granted };
}
