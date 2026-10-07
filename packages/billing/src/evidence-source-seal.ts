import { createHash } from "node:crypto";
import { canonicalEvidenceValue } from "./evidence-material-repository.ts";

type Reference = { id: string; version: string };
export type SourceCollectionTarget = { workspaceId: string; unitId: string };
export type SourceCollectionBinding = SourceCollectionTarget & { task: Reference; snapshot: Reference };
export type SourceVersion = { kind: "task" | "snapshot" | "execution" | "result" | "validation" | "pricing";
  id: string; version: string; payloadFingerprint: string; state: string | null; resultId: string | null };
export type SourceSealKind = "observation" | "final";
export type SourceSeal = { sealId: string; binding: SourceCollectionBinding; generation: number;
  kind: SourceSealKind; sources: SourceVersion[]; fingerprint: string };
export type SourceRegistration = { status: "registered" | "replayed" | "quarantined"; generation: number };
export interface EvidenceSourceSealRepository {
  registerSource(target: SourceCollectionTarget, source: SourceVersion): Promise<SourceRegistration>;
  sealCollection(target: SourceCollectionTarget, kind: SourceSealKind): Promise<SourceSeal>;
  requireCurrentSeal(target: SourceCollectionTarget, expected: { sealId: string; generation: number; fingerprint: string }): Promise<SourceSeal>;
  readSeal(workspaceId: string, sealId: string): Promise<SourceSeal | null>;
}
export class EvidenceSourceSealError extends Error {
  readonly code: "INVALID_SOURCE" | "NOT_FOUND" | "CONFLICT" | "INCOMPLETE" | "CAPACITY";
  constructor(code: EvidenceSourceSealError["code"]) { super(code); this.code = code; }
}
type Collection = { binding: SourceCollectionBinding; generation: number; sources: SourceVersion[]; current: SourceSeal | null; quarantine: SourceVersion[] };
const collectionKey = (target: SourceCollectionTarget) => JSON.stringify([target.workspaceId, target.unitId]);
const hash = (value: unknown) => createHash("sha256").update(canonicalEvidenceValue(value)).digest("hex");
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256
  && value.trim() === value && !/[\r\n]/.test(value) && !value.includes("://") && value !== "*";
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}
const reference = (value: unknown) => exact(value, ["id", "version"]) && id(value.id) && id(value.version);
function sourceCopy(input: SourceVersion): SourceVersion {
  try {
    const source = structuredClone(input);
    if (!exact(source, ["kind", "id", "version", "payloadFingerprint", "state", "resultId"])
      || !["task", "snapshot", "execution", "result", "validation", "pricing"].includes(source.kind)
      || !id(source.id) || !id(source.version) || typeof source.payloadFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(source.payloadFingerprint)
      || (source.kind === "execution" ? !["unknown", "not-sent-open", "closed-success", "closed-failure"].includes(source.state ?? "") || source.resultId !== null
        : source.kind === "validation" ? !["valid", "invalid"].includes(source.state ?? "") || !id(source.resultId)
        : source.kind === "pricing" ? source.state !== null || !id(source.resultId)
        : source.state !== null || source.resultId !== null)) throw new Error();
    return source;
  } catch { throw new EvidenceSourceSealError("INVALID_SOURCE"); }
}

/** Rule fixture only. No authorization, origin authentication, database locking or production publication wiring.
 * Calls mutate synchronously before returning promises; there are no await gaps in the memory barrier.
 */
export class InMemoryEvidenceSourceSealRepository implements EvidenceSourceSealRepository {
  readonly #collections = new Map<string, Collection>();
  readonly #seals = new Map<string, SourceSeal>();
  constructor(bindings: SourceCollectionBinding[]) {
    try {
      const copies = structuredClone(bindings);
      if (!Array.isArray(copies) || copies.length > 64) throw new Error();
      for (const binding of copies) {
        if (!exact(binding, ["workspaceId", "unitId", "task", "snapshot"]) || !id(binding.workspaceId) || !id(binding.unitId)
          || !reference(binding.task) || !reference(binding.snapshot) || this.#collections.has(collectionKey(binding))) throw new Error();
        this.#collections.set(collectionKey(binding), { binding, generation: 1, sources: [], current: null, quarantine: [] });
      }
    } catch { throw new EvidenceSourceSealError("INVALID_SOURCE"); }
  }
  #collection(target: SourceCollectionTarget): Collection {
    if (!exact(target, ["workspaceId", "unitId"]) || !id(target.workspaceId) || !id(target.unitId)) throw new EvidenceSourceSealError("INVALID_SOURCE");
    const collection = this.#collections.get(collectionKey(target));
    if (!collection) throw new EvidenceSourceSealError("NOT_FOUND");
    return collection;
  }
  async registerSource(target: SourceCollectionTarget, input: SourceVersion): Promise<SourceRegistration> {
    const collection = this.#collection(target);
    const source = sourceCopy(input);
    if ((source.kind === "task" || source.kind === "snapshot")
      && (source.id !== collection.binding[source.kind].id || source.version !== collection.binding[source.kind].version))
      throw new EvidenceSourceSealError("CONFLICT");
    const sameVersion = [...collection.sources, ...collection.quarantine].filter(record => record.kind === source.kind && record.id === source.id && record.version === source.version);
    const existing = sameVersion.find(record => canonicalEvidenceValue(record) === canonicalEvidenceValue(source));
    if (existing) {
      return { status: collection.quarantine.includes(existing) ? "quarantined" : "replayed", generation: collection.generation };
    }
    if (sameVersion.length && collection.current?.kind !== "final") throw new EvidenceSourceSealError("CONFLICT");
    if (collection.sources.length + collection.quarantine.length >= 256) throw new EvidenceSourceSealError("CAPACITY");
    if (collection.current?.kind === "final") {
      collection.quarantine.push(structuredClone(source));
      return { status: "quarantined", generation: collection.generation };
    }
    if (collection.current) { collection.generation++; collection.current = null; }
    collection.sources.push(structuredClone(source));
    return { status: "registered", generation: collection.generation };
  }
  async sealCollection(target: SourceCollectionTarget, kind: SourceSealKind): Promise<SourceSeal> {
    const collection = this.#collection(target);
    if (kind !== "observation" && kind !== "final") throw new EvidenceSourceSealError("INVALID_SOURCE");
    const executions = collection.sources.filter(source => source.kind === "execution");
    const lastRegisteredExecution = executions.at(-1);
    const results = collection.sources.filter(source => source.kind === "result");
    const validations = collection.sources.filter(source => source.kind === "validation");
    const pricing = collection.sources.filter(source => source.kind === "pricing");
    const fixed = (type: "task" | "snapshot") => collection.sources.some(source => source.kind === type
      && source.id === collection.binding[type].id && source.version === collection.binding[type].version);
    const success = lastRegisteredExecution?.state === "closed-success" && results.length === 1 && validations.length === 1 && pricing.length === 1
      && validations[0]!.state === "valid" && validations[0]!.resultId === results[0]!.id && pricing[0]!.resultId === results[0]!.id;
    const failure = lastRegisteredExecution?.state === "closed-failure" && results.length === 0 && validations.length === 0 && pricing.length === 0;
    const closedStates = new Set(executions.filter(source => source.state?.startsWith("closed-")).map(source => source.state));
    if (!fixed("task") || !fixed("snapshot") || new Set(executions.map(source => source.id)).size !== 1
      || (kind === "observation" ? lastRegisteredExecution?.state !== "unknown" || closedStates.size > 0
        : closedStates.size !== 1 || !success && !failure))
      throw new EvidenceSourceSealError("INCOMPLETE");
    if (collection.current) {
      if (collection.current.kind !== kind) throw new EvidenceSourceSealError("CONFLICT");
      return structuredClone(collection.current);
    }
    const manifest = { binding: collection.binding, generation: collection.generation, kind, sources: collection.sources };
    const fingerprint = hash(manifest);
    const seal: SourceSeal = structuredClone({ ...manifest, fingerprint, sealId: `seal_${fingerprint}` });
    this.#seals.set(seal.sealId, seal); collection.current = seal;
    return structuredClone(seal);
  }
  async requireCurrentSeal(target: SourceCollectionTarget, expected: { sealId: string; generation: number; fingerprint: string }): Promise<SourceSeal> {
    const seal = this.#collection(target).current;
    if (!seal || seal.sealId !== expected.sealId || seal.generation !== expected.generation || seal.fingerprint !== expected.fingerprint)
      throw new EvidenceSourceSealError("CONFLICT");
    return structuredClone(seal);
  }
  async readSeal(workspaceId: string, sealId: string): Promise<SourceSeal | null> {
    const seal = this.#seals.get(sealId);
    return seal?.binding.workspaceId === workspaceId ? structuredClone(seal) : null;
  }
}
