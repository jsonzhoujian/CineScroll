import { canonicalEvidenceValue } from "./evidence-material-repository.ts";
import { prepareV2PublicationIdentity, type PreparedV2PublicationIdentity, type V2PublicationCommand, type V2PublicationIdentity } from "./evidence-publication-v2.ts";
import type { EvidencePublicationAccess } from "./evidence-publication.ts";
import { validateV2SourceBundle, type PreparedV2SourceBundle } from "./v2-source-bundle.ts";
import { copySourceFixtureJson } from "./v2-source-fixture-copy.ts";
import type { BillingAccess, SettlementEvidence } from "./index.ts";
import { createVerifiedSettlementEvidenceReader, EvidenceReadError } from "./verified-evidence.ts";

export type V2PublicationReceipt = Pick<V2PublicationCommand, "protocolVersion" | "workspaceId" | "requestId" | "unitId" | "operation" | "predecessorId"
  | "expectedSealId" | "expectedGeneration" | "expectedManifestFingerprint"> & {
    evidenceId: string; requestFingerprint: string; materialFingerprint: string; auditId: string; publishedAt: string;
  };
type PublicationRecord = { protocolVersion: "evidence-publication-v2"; request: V2PublicationIdentity; material: PreparedV2SourceBundle["material"];
  audit: { auditId: string; serviceId: string; ruleVersion: unknown; sourceSealId: string; sourceFingerprint: string; generation: number; verifiedAt: string; seal: unknown; sourceBundle: unknown };
  receipt: V2PublicationReceipt };
type Options = { serviceId: string; access: EvidencePublicationAccess;
  settlementAccess?: BillingAccess; storedPublicationFixture?: { read(workspaceId: string, evidenceId: string): unknown };
  source: { readCurrentFixture(workspaceId: string, unitId: string): unknown }; clock?: () => Date;
  v1OccupiedRequests?: { workspaceId: string; requestId: string }[]; failAt?: "request" | "material" | "audit" | "receipt" | "response" };
type V1Occupancy = { protocolVersion: "evidence-publication-v1" };
export class V2PublicationTransactionError extends Error {
  readonly code: "FORBIDDEN" | "CONFLICT" | "UNAVAILABLE" | "INVALID_PUBLICATION" | "INVALID_SOURCE_BUNDLE" | "PREDECESSOR_NOT_FOUND" | "CAPACITY";
  constructor(code: V2PublicationTransactionError["code"]) { super(code); this.code = code; }
}
const key = (workspaceId: string, requestId: string) => JSON.stringify([workspaceId, requestId]);
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256
  && value.trim() === value && !/[\r\n*?]/.test(value) && !value.includes("://");

/** Single-process rule fixture only. No durable transaction, origin authentication or production wiring. */
export class InMemoryV2PublicationTransactionFixture {
  readonly #serviceId: string;
  readonly #authorize: EvidencePublicationAccess["authorize"];
  readonly #source: Options["source"]["readCurrentFixture"];
  readonly #clock: () => Date;
  readonly #failAt: Options["failAt"];
  readonly #records = new Map<string, PublicationRecord | V1Occupancy>();
  readonly #settleAuthorize: BillingAccess["authorize"];
  readonly #storedFixture: Options["storedPublicationFixture"];
  constructor(options: Options) {
    try {
      if (!validId(options.serviceId)) throw new Error();
      this.#serviceId = options.serviceId; this.#authorize = options.access.authorize.bind(options.access);
      this.#settleAuthorize = options.settlementAccess?.authorize.bind(options.settlementAccess) ?? (async () => false);
      this.#storedFixture = options.storedPublicationFixture ? { read: options.storedPublicationFixture.read.bind(options.storedPublicationFixture) } : undefined;
      this.#source = options.source.readCurrentFixture.bind(options.source); this.#clock = options.clock?.bind(options) ?? (() => new Date());
      this.#failAt = options.failAt;
      if (this.#failAt !== undefined && !["request", "material", "audit", "receipt", "response"].includes(this.#failAt)) throw new Error();
      const occupancies = copySourceFixtureJson(options.v1OccupiedRequests ?? []) as { workspaceId: string; requestId: string }[];
      if (!Array.isArray(occupancies) || occupancies.length > 128) throw new Error();
      for (const occupied of occupancies) {
        if (Reflect.ownKeys(occupied).length !== 2 || !validId(occupied.workspaceId) || !validId(occupied.requestId)
          || this.#records.has(key(occupied.workspaceId, occupied.requestId))) throw new Error();
        this.#records.set(key(occupied.workspaceId, occupied.requestId), { protocolVersion: "evidence-publication-v1" });
      }
    } catch { throw new Error("V2_PUBLICATION_FIXTURE_CONFIG_INVALID"); }
  }
  async #allowed(request: V2PublicationIdentity): Promise<void> {
    try {
      if (await this.#authorize({ workspaceId: request.workspaceId, serviceId: this.#serviceId }, request.operation) !== true) throw new Error();
    } catch { throw new V2PublicationTransactionError("FORBIDDEN"); }
  }
  #existing(identity: PreparedV2PublicationIdentity): V2PublicationReceipt | null {
    const record = this.#records.get(key(identity.identity.workspaceId, identity.identity.requestId));
    if (!record) return null;
    if (record.protocolVersion !== "evidence-publication-v2") throw new V2PublicationTransactionError("CONFLICT");
    if (record.receipt.requestFingerprint !== identity.requestFingerprint) throw new V2PublicationTransactionError("CONFLICT");
    return structuredClone(record.receipt);
  }
  #fail(stage: Options["failAt"]): void {
    if (this.#failAt === stage) throw new V2PublicationTransactionError("UNAVAILABLE");
  }
  #read(request: V2PublicationIdentity): unknown {
    let raw: unknown;
    try { raw = this.#source(request.workspaceId, request.unitId); }
    catch { throw new V2PublicationTransactionError("UNAVAILABLE"); }
    try {
      if (raw instanceof Promise) {
        void Promise.prototype.then.call(raw, undefined, () => {});
        throw new Error("ASYNC_SOURCE_NOT_SUPPORTED");
      }
      return copySourceFixtureJson(raw);
    }
    catch { throw new V2PublicationTransactionError("INVALID_SOURCE_BUNDLE"); }
  }
  #predecessor(prepared: PreparedV2SourceBundle, snapshot: unknown): void {
    const request = prepared.identity.identity;
    if (request.predecessorId === null) return;
    const previous = [...this.#records.values()].find((record): record is PublicationRecord => record.protocolVersion === "evidence-publication-v2"
      && record.request.workspaceId === request.workspaceId && record.receipt.evidenceId === request.predecessorId);
    if (!previous) throw new V2PublicationTransactionError("PREDECESSOR_NOT_FOUND");
    if (canonicalEvidenceValue(previous.material.binding) !== canonicalEvidenceValue(prepared.material.binding)
      || canonicalEvidenceValue(previous.material.snapshot) !== canonicalEvidenceValue(prepared.material.snapshot)
      || (previous.material.execution as { id: string }).id !== (prepared.material.execution as { id: string }).id)
      throw new V2PublicationTransactionError("CONFLICT");
    const oldMembers = (previous.audit.seal as { members: unknown[] }).members;
    const members = (snapshot as { seal: { members: unknown[] } }).seal.members;
    if (!oldMembers.every(member => members.some(candidate => canonicalEvidenceValue(member) === canonicalEvidenceValue(candidate))))
      throw new V2PublicationTransactionError("CONFLICT");
  }
  #sourceIntegrity(prepared: PreparedV2SourceBundle, snapshot: unknown): void {
    const request = prepared.identity.identity;
    const members = (snapshot as { seal: { members: unknown[] } }).seal.members;
    for (const record of this.#records.values()) {
      if (record.protocolVersion !== "evidence-publication-v2" || record.request.workspaceId !== request.workspaceId) continue;
      if (record.audit.sourceSealId === prepared.sourceSealId && record.audit.sourceFingerprint !== prepared.sourceFingerprint)
        throw new V2PublicationTransactionError("CONFLICT");
      if (canonicalEvidenceValue(record.material.binding) === canonicalEvidenceValue(prepared.material.binding)
        && (record.receipt.expectedGeneration > request.expectedGeneration
          || !(record.audit.seal as { members: unknown[] }).members.every(member => members.some(candidate => canonicalEvidenceValue(member) === canonicalEvidenceValue(candidate)))))
        throw new V2PublicationTransactionError("CONFLICT");
    }
  }
  async publishFromSeal(command: unknown): Promise<V2PublicationReceipt> {
    const identity = prepareV2PublicationIdentity(this.#serviceId, command);
    const request = identity.identity;
    await this.#allowed(request);
    const existing = this.#existing(identity);
    if (existing) return existing;
    if (this.#records.size >= 128) throw new V2PublicationTransactionError("CAPACITY");
    this.#fail("request");
    const snapshot = this.#read(request);
    const prepared = await validateV2SourceBundle(this.#serviceId, requestCommand(request), snapshot);
    await this.#allowed(request);
    const winner = this.#existing(identity);
    if (winner) return winner;
    this.#predecessor(prepared, snapshot);
    this.#fail("material");
    let publishedAt: string;
    try { publishedAt = this.#clock().toISOString(); }
    catch { throw new V2PublicationTransactionError("UNAVAILABLE"); }
    const { serviceId, references, ...receiptIdentity } = request;
    const receipt: V2PublicationReceipt = { ...receiptIdentity, evidenceId: identity.evidenceId, requestFingerprint: identity.requestFingerprint,
      materialFingerprint: prepared.materialFingerprint, auditId: identity.auditId, publishedAt };
    const record: PublicationRecord = { protocolVersion: "evidence-publication-v2", request, material: prepared.material,
      audit: { auditId: identity.auditId, serviceId, ruleVersion: prepared.material.ruleVersion, sourceSealId: prepared.sourceSealId,
        sourceFingerprint: prepared.sourceFingerprint, generation: request.expectedGeneration, verifiedAt: publishedAt,
        seal: (snapshot as { seal: unknown }).seal, sourceBundle: snapshot }, receipt };
    this.#fail("audit"); this.#fail("receipt");
    const current = this.#read(request);
    if (canonicalEvidenceValue(current) !== canonicalEvidenceValue(snapshot)) throw new V2PublicationTransactionError("CONFLICT");
    this.#sourceIntegrity(prepared, snapshot);
    if (this.#records.size >= 128 || Buffer.byteLength(canonicalEvidenceValue(record), "utf8") > 2 * 1024 * 1024)
      throw new V2PublicationTransactionError("CAPACITY");
    // No await or injected callback between this synchronous source comparison and the one composite save.
    let saved: PublicationRecord;
    try { saved = copySourceFixtureJson(record) as PublicationRecord; }
    catch { throw new V2PublicationTransactionError("CAPACITY"); }
    this.#records.set(key(request.workspaceId, request.requestId), saved);
    this.#fail("response");
    return structuredClone(receipt);
  }
  async lookupPublished(command: unknown): Promise<V2PublicationReceipt | null> {
    const identity = prepareV2PublicationIdentity(this.#serviceId, command);
    await this.#allowed(identity.identity);
    return this.#existing(identity);
  }
  async readPublishedEvidence(workspaceId: string, evidenceId: string): Promise<SettlementEvidence> {
    if (!validId(workspaceId) || !validId(evidenceId)) throw new EvidenceReadError("FORBIDDEN");
    // Keep gate errors intact; the legacy reader sanitizes arbitrary source failures as UNAVAILABLE.
    await this.#settleAllowed(workspaceId);
    let material: unknown, failure: unknown;
    try { material = await this.#publishedMaterial(workspaceId, evidenceId); }
    catch (error) { failure = error; }
    await this.#settleAllowed(workspaceId);
    if (failure) throw failure;
    const projection = createVerifiedSettlementEvidenceReader({ access: { authorize: this.#settleAuthorize }, source: { read: async () => material } });
    // The legacy reader's broad interface is unknown; this implementation validates and returns the nine-field projection.
    return await projection.read({ workspaceId, serviceId: this.#serviceId }, evidenceId) as SettlementEvidence;
  }
  async #settleAllowed(workspaceId: string): Promise<void> {
    try {
      if (await this.#settleAuthorize({ workspaceId, serviceId: this.#serviceId }, "settle") !== true) throw new Error();
    } catch { throw new EvidenceReadError("FORBIDDEN"); }
  }
  async #publishedMaterial(workspaceId: string, evidenceId: string): Promise<unknown> {
    let raw: unknown;
    try {
      raw = this.#storedFixture ? this.#storedFixture.read(workspaceId, evidenceId)
        : [...this.#records.values()].find(record => record.protocolVersion === "evidence-publication-v2"
          && record.request.workspaceId === workspaceId && record.receipt.evidenceId === evidenceId) ?? null;
    } catch { throw new EvidenceReadError("UNAVAILABLE"); }
    if (raw === null) throw new EvidenceReadError("NOT_FOUND");
    try {
      if (raw instanceof Promise) {
        void Promise.prototype.then.call(raw, undefined, () => {});
        throw new Error();
      }
      const record = copySourceFixtureJson(raw) as PublicationRecord;
      const request = record.request;
      const prepared = await validateV2SourceBundle(request.serviceId, requestCommand(request), record.audit.sourceBundle);
      const identity = prepared.identity;
      const { serviceId, references, ...receiptIdentity } = identity.identity;
      const publishedAt = record.receipt.publishedAt;
      if (typeof publishedAt !== "string" || new Date(publishedAt).toISOString() !== publishedAt
        || request.workspaceId !== workspaceId || identity.evidenceId !== evidenceId) throw new Error();
      const expected: PublicationRecord = { protocolVersion: "evidence-publication-v2", request: identity.identity, material: prepared.material,
        audit: { auditId: identity.auditId, serviceId, ruleVersion: prepared.material.ruleVersion, sourceSealId: prepared.sourceSealId,
          sourceFingerprint: prepared.sourceFingerprint, generation: request.expectedGeneration, verifiedAt: publishedAt,
          seal: (record.audit.sourceBundle as { seal: unknown }).seal, sourceBundle: record.audit.sourceBundle },
        receipt: { ...receiptIdentity, evidenceId: identity.evidenceId, requestFingerprint: identity.requestFingerprint,
          materialFingerprint: prepared.materialFingerprint, auditId: identity.auditId, publishedAt } };
      if (canonicalEvidenceValue(expected) !== canonicalEvidenceValue(record)) throw new Error();
      return prepared.material;
    } catch { throw new EvidenceReadError("CONFLICT"); }
  }
}
function requestCommand(identity: V2PublicationIdentity): V2PublicationCommand {
  const { serviceId, ...command } = identity;
  return command;
}
