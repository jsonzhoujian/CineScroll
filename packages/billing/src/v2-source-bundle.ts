import { createHash } from "node:crypto";
import { canonicalEvidenceValue, prepareEvidenceMaterial } from "./evidence-material-repository.ts";
import { prepareV2PublicationIdentity, type PreparedV2PublicationIdentity } from "./evidence-publication-v2.ts";
import { copySourceFixtureJson } from "./v2-source-fixture-copy.ts";

type PreparedMaterial = { id: string; pricing: Record<string, unknown> | null; [key: string]: unknown };
export type PreparedV2SourceBundle = { identity: PreparedV2PublicationIdentity; material: PreparedMaterial;
  materialFingerprint: string; sourceFingerprint: string; sourceSealId: string };
export class V2SourceBundleError extends Error {
  readonly code = "INVALID_SOURCE_BUNDLE";
  constructor() { super("INVALID_SOURCE_BUNDLE"); }
}
const hash = (value: unknown) => createHash("sha256").update(canonicalEvidenceValue(value)).digest("hex");
type SourceRecord = { kind: string; id: string; version: string; revision: number; predecessorVersion: string | null;
  payloadFingerprint: string; producerServiceId: string; ruleVersion: string; recordedAt: string; businessRecordId: string;
  binding: Record<string, unknown>; payload: Record<string, unknown> };
const recordKeys = ["kind", "id", "version", "revision", "predecessorVersion", "payloadFingerprint", "producerServiceId", "ruleVersion", "recordedAt", "businessRecordId", "binding", "payload"];
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length
    || !keys.every(key => Object.hasOwn(value, key))) throw new Error();
  return value as Record<string, unknown>;
}
const equal = (a: unknown, b: unknown) => canonicalEvidenceValue(a) === canonicalEvidenceValue(b);
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256
  && value.trim() === value && !/[\r\n*?]/.test(value) && !value.includes("://");
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const sourceKinds = ["task", "snapshot", "execution", "result", "validation", "pricing", "fence", "closure"];
const payloadKeys: Record<string, string[]> = {
  task: ["binding", "taskRevision", "scopeKeys"],
  snapshot: ["binding", "responsibility", "quoteId", "priceVersion", "reserved"],
  execution: ["binding", "id", "state", "closed"],
  result: ["binding", "id", "executionId", "original", "persisted", "validation", "ruleVersion"],
  validation: ["binding", "resultId", "resultVersion", "resultFingerprint", "verdict", "ruleVersion"],
  pricing: ["binding", "id", "resultVersionId", "quoteId", "priceVersion", "origin", "amount"],
  fence: ["binding", "executionId", "generation", "state", "dispatchAuthorized"],
  closure: ["binding", "executionId", "fenceId", "fenceVersion", "fenceFingerprint", "predecessorExecutionVersion", "reason", "dispatchClosed", "resultRegistrationClosed"],
};
function validateHistoricalAssociations(records: SourceRecord[], material: Record<string, unknown>): void {
  const snapshot = material.snapshot as Record<string, unknown>;
  const linked = (kind: string, recordId: unknown, version?: unknown) => {
    const matches = records.filter(record => record.kind === kind && record.id === recordId && (version === undefined || record.version === version));
    if (matches.length !== 1) throw new Error();
    return matches[0]!;
  };
  for (const record of records) {
    const payload = record.payload;
    if (record.kind === "validation") {
      const result = linked("result", payload.resultId, payload.resultVersion);
      if (payload.resultFingerprint !== result.payloadFingerprint || payload.verdict !== result.payload.validation
        || !["passed", "failed"].includes(payload.verdict as string) || payload.ruleVersion !== material.ruleVersion
        || record.recordedAt < result.recordedAt) throw new Error();
    }
    if (record.kind === "pricing") {
      const result = linked("result", payload.resultVersionId);
      if (payload.id !== record.id || result.payload.validation !== "passed" || payload.origin !== "quote"
        || payload.quoteId !== snapshot.quoteId || payload.priceVersion !== snapshot.priceVersion
        || !Number.isSafeInteger(payload.amount) || Number(payload.amount) < 0
        || snapshot.responsibility === "byok" && payload.amount !== 0 || record.recordedAt < result.recordedAt
        || !equal(payload, material.pricing)) throw new Error();
    }
    if (record.kind === "closure") {
      const fence = linked("fence", payload.fenceId, payload.fenceVersion);
      const executions = records.filter(source => source.kind === "execution" && source.id === payload.executionId
        && source.predecessorVersion === payload.predecessorExecutionVersion);
      if (executions.length !== 1) throw new Error();
      const execution = executions[0]!;
      if (payload.fenceFingerprint !== fence.payloadFingerprint || fence.payload.state !== "closed"
        || fence.payload.executionId !== execution.id || execution.payload.closed !== true || payload.reason !== execution.payload.state
        || payload.dispatchClosed !== true || payload.resultRegistrationClosed !== true
        || (payload.reason === "not_sent" ? fence.payload.dispatchAuthorized !== false : fence.payload.dispatchAuthorized !== true)
        || record.recordedAt < fence.recordedAt || record.recordedAt < execution.recordedAt) throw new Error();
    }
  }
}

/** Consistency fixture only, not origin authentication, a current-head barrier, authorization or publication. */
export async function validateV2SourceBundle(serviceId: string, command: unknown, input: unknown): Promise<PreparedV2SourceBundle> {
  try {
    const identity = prepareV2PublicationIdentity(serviceId, command);
    const bundle = object(copySourceFixtureJson(input), ["formatVersion", "material", "records", "seal"]);
    if (bundle.formatVersion !== 1 || !Array.isArray(bundle.records) || bundle.records.length === 0 || bundle.records.length > 256) throw new Error();
    const records = bundle.records.map(value => object(value, recordKeys) as SourceRecord);
    const seal = object(bundle.seal, ["formatVersion", "sealId", "binding", "generation", "kind", "ruleVersion", "producerServiceId", "sealedAt", "references", "unresolved", "members", "fingerprint"]);
    const { fingerprint, ...manifest } = seal;
    const expected = identity.identity;
    if (seal.formatVersion !== 1 || seal.sealId !== expected.expectedSealId || seal.generation !== expected.expectedGeneration
      || fingerprint !== expected.expectedManifestFingerprint || fingerprint !== hash(manifest)
      || !id(seal.producerServiceId) || !timestamp(seal.sealedAt)
      || !equal(seal.references, expected.references) || !equal(seal.members, records.map(({ payload, ...metadata }) => metadata))) throw new Error();
    const material = bundle.material as Record<string, unknown>;
    const binding = object(material.binding, ["workspaceId", "taskId", "unitId", "projectId", "chapterId", "sourceVersionId", "upstreamVersionIds"]);
    if (binding.workspaceId !== expected.workspaceId || binding.unitId !== expected.unitId || binding.taskId !== expected.references.task.id
      || !equal(seal.binding, binding) || seal.ruleVersion !== material.ruleVersion || !Array.isArray(binding.upstreamVersionIds)
      || binding.upstreamVersionIds.length > 100) throw new Error();
    for (const record of records) {
      if (!equal(record.binding, binding) || !equal(record.payload.binding, binding) || record.ruleVersion !== material.ruleVersion
        || record.payloadFingerprint !== hash(record.payload) || !sourceKinds.includes(record.kind)
        || ![record.id, record.version, record.producerServiceId, record.ruleVersion, record.businessRecordId].every(id)
        || !Number.isSafeInteger(record.revision) || record.revision < 1 || !timestamp(record.recordedAt)
        || record.recordedAt > seal.sealedAt) throw new Error();
      object(record.payload, payloadKeys[record.kind]!);
      if (record.kind === "snapshot" && !equal(record.payload, material.snapshot)) throw new Error();
      if (record.kind === "execution" && (record.payload.id !== expected.references.execution.id
        || !["unknown", "completed", "invalid_response", "not_sent"].includes(record.payload.state as string)
        || record.payload.closed !== (record.payload.state !== "unknown"))) throw new Error();
      if (record.kind === "fence" && (record.payload.executionId !== expected.references.execution.id
        || !Number.isSafeInteger(record.payload.generation) || Number(record.payload.generation) < 1 || Number(record.payload.generation) > Number(seal.generation)
        || !["open", "closed"].includes(record.payload.state as string) || typeof record.payload.dispatchAuthorized !== "boolean")) throw new Error();
    }
    for (const kind of sourceKinds) {
      const group = records.filter(record => record.kind === kind).toSorted((a, b) => a.revision - b.revision);
      if (new Set(group.map(record => record.id)).size > 1 || new Set(group.map(record => record.version)).size !== group.length) throw new Error();
      for (let index = 0; index < group.length; index++) {
        const record = group[index]!, previous = group[index - 1];
        if (record.revision !== index + 1 || record.predecessorVersion !== (previous?.version ?? null)
          || previous && record.recordedAt < previous.recordedAt) throw new Error();
        if (kind === "execution" && previous?.payload.closed === true
          && (record.payload.closed !== true || record.payload.state !== previous.payload.state)) throw new Error();
        if (kind === "fence" && previous && (Number(record.payload.generation) < Number(previous.payload.generation)
          || previous.payload.state === "closed" && record.payload.state !== "closed"
          || previous.payload.dispatchAuthorized === true && record.payload.dispatchAuthorized !== true)) throw new Error();
      }
    }
    const selected = (kind: string, ref: { id: string; version: string } | null) => {
      if (ref === null) {
        if (records.some(record => record.kind === kind)) throw new Error();
        return null;
      }
      const matches = records.filter(record => record.kind === kind && record.id === ref.id && record.version === ref.version);
      if (matches.length !== 1 || records.some(record => record.kind === kind && record.revision > matches[0]!.revision)) throw new Error();
      return matches[0]!;
    };
    const task = selected("task", expected.references.task)!;
    const taskPayload = object(task.payload, ["binding", "taskRevision", "scopeKeys"]);
    if (taskPayload.taskRevision !== task.revision || !Array.isArray(taskPayload.scopeKeys) || taskPayload.scopeKeys.length > 100 || !taskPayload.scopeKeys.every(id)
      || !taskPayload.scopeKeys.includes(binding.unitId) || new Set(taskPayload.scopeKeys).size !== taskPayload.scopeKeys.length) throw new Error();
    for (const kind of ["snapshot", "execution", "pricing"] as const) {
      const record = selected(kind, expected.references[kind]);
      if (!equal(record?.payload ?? null, material[kind])) throw new Error();
      if (kind !== "snapshot" && record && record.id !== record.payload.id) throw new Error();
    }
    const snapshot = material.snapshot as Record<string, unknown>, pricing = material.pricing as Record<string, unknown> | null;
    if (snapshot.responsibility === "byok" && pricing !== null && pricing.amount !== 0) throw new Error();
    const result = selected("result", expected.references.result);
    const validation = selected("validation", expected.references.validation);
    const allResults = records.filter(record => record.kind === "result");
    if (!equal(material.results, allResults.map(record => record.payload)) || allResults.length > 1 || (allResults.length === 0) !== (result === null)
      || (result === null) !== (validation === null)) throw new Error();
    if (result && result.id !== result.payload.id) throw new Error();
    validateHistoricalAssociations(records, material);
    const executionRecord = selected("execution", expected.references.execution)!;
    const execution = object(material.execution, ["binding", "id", "state", "closed"]);
    const singleton = (kind: string) => {
      const group = records.filter(record => record.kind === kind);
      if (new Set(group.map(record => record.id)).size > 1) throw new Error();
      return group.toSorted((a, b) => b.revision - a.revision)[0] ?? null;
    };
    const fenceRecord = singleton("fence");
    if (!fenceRecord) throw new Error();
    const fence = object(fenceRecord.payload, ["binding", "executionId", "generation", "state", "dispatchAuthorized"]);
    const closureRecord = singleton("closure");
    if (seal.unresolved !== false || fence.executionId !== execution.id || fence.generation !== seal.generation
      || typeof fence.dispatchAuthorized !== "boolean" || (execution.closed === true
        ? seal.kind !== "final" || fence.state !== "closed" || !closureRecord
        : execution.closed !== false || execution.state !== "unknown" || seal.kind !== "observation" || fence.state !== "open" || closureRecord !== null)) throw new Error();
    if (closureRecord) {
      const closure = object(closureRecord.payload, ["binding", "executionId", "fenceId", "fenceVersion", "fenceFingerprint", "predecessorExecutionVersion", "reason", "dispatchClosed", "resultRegistrationClosed"]);
      if (closure.executionId !== execution.id || closure.fenceId !== fenceRecord.id || closure.fenceVersion !== fenceRecord.version
        || closure.fenceFingerprint !== fenceRecord.payloadFingerprint || closure.predecessorExecutionVersion !== executionRecord.predecessorVersion
        || closure.reason !== execution.state || closure.dispatchClosed !== true || closure.resultRegistrationClosed !== true
        || (execution.state === "not_sent" ? records.some(record => record.kind === "fence" && record.payload.dispatchAuthorized !== false) : fence.dispatchAuthorized !== true)) throw new Error();
    }
    const checked = await prepareEvidenceMaterial(identity.identity.workspaceId, { ...material, id: identity.evidenceId }, identity.identity.predecessorId);
    return { identity, material: checked.material as PreparedMaterial, materialFingerprint: checked.fingerprint,
      sourceFingerprint: fingerprint as string, sourceSealId: seal.sealId as string };
  } catch { throw new V2SourceBundleError(); }
}
