import type { BillingAccess, BillingActor, SettlementEvidence, SettlementEvidenceReader } from "./index.ts";

/** Trusted, consistent immutable source only; not a model response or client payload. */
export interface EvidenceMaterialSource { read(workspaceId: string, evidenceId: string): Promise<unknown> }
export class EvidenceReadError extends Error {
  readonly code: "FORBIDDEN" | "NOT_FOUND" | "UNAVAILABLE" | "CONFLICT";
  constructor(code: EvidenceReadError["code"]) { super(code); this.code = code; }
}
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\r\n]/.test(value);
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length
    || !keys.every(key => Object.hasOwn(value, key))) throw new EvidenceReadError("CONFLICT");
  return value as Record<string, unknown>;
}
function binding(value: unknown): string {
  const record = object(value, ["workspaceId", "taskId", "unitId", "projectId", "chapterId", "sourceVersionId", "upstreamVersionIds"]);
  const names = ["workspaceId", "taskId", "unitId", "projectId", "chapterId", "sourceVersionId"];
  if (!names.every(key => id(record[key])) || !Array.isArray(record.upstreamVersionIds)
    || !record.upstreamVersionIds.every(id) || new Set(record.upstreamVersionIds).size !== record.upstreamVersionIds.length) throw new EvidenceReadError("CONFLICT");
  return JSON.stringify([...names.map(key => record[key]), record.upstreamVersionIds]);
}

export function createVerifiedSettlementEvidenceReader(options: { access: BillingAccess; source: EvidenceMaterialSource }): SettlementEvidenceReader {
  const authorize = options.access.authorize.bind(options.access), read = options.source.read.bind(options.source);
  return Object.freeze({ async read(actor: BillingActor, evidenceId: string): Promise<SettlementEvidence> {
    let caller: BillingActor;
    try {
      caller = structuredClone(actor);
      object(caller, ["workspaceId", "serviceId"]);
      if (!id(caller.workspaceId) || !id(caller.serviceId) || !id(evidenceId)
        || await authorize(structuredClone(caller), "settle") !== true) throw new Error();
    } catch { throw new EvidenceReadError("FORBIDDEN"); }
    let raw: unknown;
    try { raw = structuredClone(await read(caller.workspaceId, evidenceId)); }
    catch { throw new EvidenceReadError("UNAVAILABLE"); }
    if (raw === null) throw new EvidenceReadError("NOT_FOUND");
    try {
      const record = object(raw, ["id", "formatVersion", "binding", "ruleVersion", "snapshot", "execution", "results", "pricing"]);
      const expected = binding(record.binding);
      const scope = record.binding as Record<string, string>;
      if (record.id !== evidenceId || record.formatVersion !== 1 || scope.workspaceId !== caller.workspaceId || !id(record.ruleVersion)) throw new Error();
      const snapshot = object(record.snapshot, ["binding", "responsibility", "quoteId", "priceVersion", "reserved"]);
      const execution = object(record.execution, ["binding", "id", "state", "closed"]);
      if (binding(snapshot.binding) !== expected || binding(execution.binding) !== expected || !id(execution.id)
        || (snapshot.responsibility !== "platform" && snapshot.responsibility !== "byok") || !id(snapshot.quoteId) || !id(snapshot.priceVersion)
        || !Number.isSafeInteger(snapshot.reserved) || Number(snapshot.reserved) < 0
        || (snapshot.responsibility === "byok" ? snapshot.reserved !== 0 : Number(snapshot.reserved) === 0)
        || typeof execution.closed !== "boolean" || !Array.isArray(record.results)) throw new Error();
      const results = record.results.map(value => {
        const result = object(value, ["binding", "id", "executionId", "original", "persisted", "validation", "ruleVersion"]);
        if (binding(result.binding) !== expected || !id(result.id) || result.executionId !== execution.id
          || result.original !== true || result.persisted !== true || result.ruleVersion !== record.ruleVersion
          || (result.validation !== "passed" && result.validation !== "failed")) throw new Error();
        return result;
      });
      let outcome: SettlementEvidence["outcome"], amount: number | null = null, resultVersionId: string | null = null;
      if (execution.state === "unknown" && results.length === 0 && record.pricing === null) outcome = "unknown";
      else if (execution.closed === true && execution.state === "not_sent" && results.length === 0 && record.pricing === null) outcome = "failed";
      else if (execution.closed === true && execution.state === "invalid_response" && results.length === 0 && record.pricing === null) outcome = "failed";
      else if (execution.closed === true && execution.state === "completed" && results.length === 1) {
        const result = results[0]!;
        if (result.validation === "failed" && record.pricing === null) outcome = "failed";
        else {
          const pricing = object(record.pricing, ["binding", "id", "resultVersionId", "quoteId", "priceVersion", "origin", "amount"]);
          if (result.validation !== "passed" || binding(pricing.binding) !== expected || !id(pricing.id)
            || pricing.resultVersionId !== result.id || pricing.quoteId !== snapshot.quoteId || pricing.priceVersion !== snapshot.priceVersion
            || pricing.origin !== "quote" || !Number.isSafeInteger(pricing.amount) || Number(pricing.amount) < 0) throw new Error();
          outcome = "succeeded"; amount = pricing.amount as number; resultVersionId = result.id as string;
        }
      } else throw new Error();
      return { id: evidenceId, workspaceId: caller.workspaceId, taskId: scope.taskId!, unitId: scope.unitId!, sourceVersionId: scope.sourceVersionId!,
        outcome, amount, resultVersionId, ruleVersion: record.ruleVersion };
    } catch { throw new EvidenceReadError("CONFLICT"); }
  } });
}
