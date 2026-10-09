// Offline design fixture only. No runtime export, authorization or database access.
import { createHash } from "node:crypto";
import { canonicalEvidenceValue } from "../../src/evidence-material-repository.ts";
import { prepareSourceBusinessFixture } from "../../src/source-business-fixture.ts";
import { prepareSourceIngestIdentity } from "../../src/evidence-source-ingest.ts";
import { sourceBusinessFixture } from "./source-business-fixture.ts";

export function buildInitializeVectors() {
  const fixture = sourceBusinessFixture();
  const [task, snapshot, execution, quote] = prepareSourceBusinessFixture(fixture).records;
  if (!task || !snapshot || !execution || !quote) throw new Error("fixture missing");
  const canonical = canonicalEvidenceValue;
  const hash = (x: unknown) => createHash("sha256").update(canonical(x), "utf8").digest("hex");
  const bytes = (x: unknown) => Buffer.byteLength(canonical(x), "utf8");
  const hex = (x: unknown) => Buffer.from(canonical(x), "utf8").toString("hex");
  const time = "2026-10-08T00:00:00.000Z", service = "collector";
  const collectionId = "00000000-0000-4000-8000-000000000001";
  // Unified evidence rule matches the synthetic quote; projection version is separate.
  const ruleVersion = "rule-v1", projectionRuleVersion = "source-projection-v1";
  const taskPayload = { binding: fixture.tasks[0].binding, taskRevision: 1, scopeKeys: ["unit"] };
  const snapshotPayload = { binding: fixture.snapshot.binding, responsibility: "platform",
    quoteId: "quote", priceVersion: "price-v1", reserved: 7 };
  const command = { protocolVersion: "source-ingest-v1", workspaceId: "studio", unitId: "unit", ingestId: "ingest-1",
    taskReference: { id: "task", version: "v1" }, snapshotReference: { id: "snapshot", version: "v1" },
    executionReference: { id: "execution", version: "v1" } };
  const prepared = prepareSourceIngestIdentity(service, "initialize", command);
  const rowScope = { workspace_id: "studio", collection_id: collectionId };
  const sourceScope = { ...rowScope, revision: 1, predecessor_version: null, introduced_generation: 1,
    producer_service_id: "producer", rule_version: ruleVersion, recorded_at: time };
  const taskSource = { ...sourceScope, kind: "task", id: "task", version: "v1", payload: taskPayload,
    canonical: hex(taskPayload), payload_fingerprint: hash(taskPayload) };
  const snapshotSource = { ...sourceScope, kind: "snapshot", id: "snapshot", version: "v1", payload: snapshotPayload,
    canonical: hex(snapshotPayload), payload_fingerprint: hash(snapshotPayload) };
  const linkScope = { ...rowScope, projection_rule_version: projectionRuleVersion,
    verified_by_service_id: service, verified_at: time };
  const taskLink = { ...linkScope, kind: "task", id: "task", version: "v1",
    payload_fingerprint: hash(taskPayload), business_fingerprint: task.businessFingerprint };
  const snapshotLink = { ...linkScope, kind: "snapshot", id: "snapshot", version: "v1",
    payload_fingerprint: hash(snapshotPayload), business_fingerprint: snapshot.businessFingerprint,
    quote_record_id: "quote-record", quote_record_version: "v1", quote_fingerprint: quote.businessFingerprint };
  const collectionBase = { ...rowScope, unit_id: "unit", task_id: "task", task_version: "v1",
    snapshot_id: "snapshot", snapshot_version: "v1", execution_id: "execution", execution_version: "v1",
    quote_record_id: "quote-record", quote_record_version: "v1", task_fingerprint: task.businessFingerprint,
    snapshot_fingerprint: snapshot.businessFingerprint, execution_fingerprint: execution.businessFingerprint,
    quote_fingerprint: quote.businessFingerprint, binding: fixture.tasks[0].binding, generation: 1,
    head_revision: 1, member_count: 2, history_count: 0, unresolved_count: 0, current_seal_id: null,
    final_seal_id: null, initial_task_kind: "task", initial_snapshot_kind: "snapshot" };
  const sourceReferences = [taskSource, snapshotSource].map(s => ({ kind: s.kind, id: s.id,
    version: s.version, payloadFingerprint: s.payload_fingerprint }));
  const receipt = { protocolVersion: "source-ingest-v1", workspaceId: "studio", ingestId: "ingest-1",
    operation: "initialize", producerServiceId: service, commandFingerprint: prepared.commandFingerprint,
    collectionId, unitId: "unit", generationAtCommit: 1, headRevisionAtCommit: 1,
    status: "initialized", sourceReferences, committedAt: time };
  const members = [taskSource, snapshotSource].map((s, ordinal) => ({ ...rowScope, ingest_id: "ingest-1",
    ordinal, kind: s.kind, id: s.id, version: s.version, payload_fingerprint: s.payload_fingerprint }));
  const receiptBase = { ...rowScope, ingest_id: "ingest-1", protocol_version: "source-ingest-v1",
    operation: "initialize", producer_service_id: service, command: prepared.identity,
    command_canonical: hex(prepared.identity), command_fingerprint: prepared.commandFingerprint,
    unit_id: "unit", generation_at_commit: 1, head_revision_at_commit: 1, status: "initialized",
    committed_at: time, receipt, receipt_canonical: hex(receipt), receipt_fingerprint: hash(receipt) };
  const packageBytes = bytes(collectionBase) + bytes(taskSource) + bytes(snapshotSource) + bytes(taskLink) + bytes(snapshotLink);
  const receiptCost = bytes(receiptBase) + members.reduce((n, m) => n + bytes(m), 0);
  const duplicateIdentity = prepareSourceIngestIdentity(service, "initialize", { ...command, ingestId: "ingest-2" });
  const duplicateReceipt = { ...receipt, ingestId: "ingest-2", status: "already_registered",
    commandFingerprint: duplicateIdentity.commandFingerprint };
  const duplicateBase = { ...receiptBase, ingest_id: "ingest-2", status: "already_registered",
    command: duplicateIdentity.identity, command_canonical: hex(duplicateIdentity.identity),
    command_fingerprint: duplicateIdentity.commandFingerprint, receipt: duplicateReceipt,
    receipt_canonical: hex(duplicateReceipt), receipt_fingerprint: hash(duplicateReceipt) };
  const duplicateMembers = members.map(m => ({ ...m, ingest_id: "ingest-2" }));
  const duplicateCost = bytes(duplicateBase) + duplicateMembers.reduce((n, m) => n + bytes(m), 0);
  const values = { identity: prepared.identity, taskPayload, snapshotPayload, receipt, collectionBase,
    taskSource, snapshotSource, taskLink, snapshotLink, receiptBase, member0: members[0], member1: members[1],
    duplicateIdentity: duplicateIdentity.identity, duplicateReceipt, duplicateBase,
    duplicateMember0: duplicateMembers[0], duplicateMember1: duplicateMembers[1] };
  return { format: "source-initialize-offline-v1", ruleVersion, projectionRuleVersion,
    vectors: Object.entries(values).map(([name, value]) => ({ name, canonical: canonical(value), bytes: bytes(value), sha256: hash(value) })),
    budget: { packageBytes, receiptCost, initialized: { sourceCount: 2, sourceBytes: packageBytes, receiptCount: 1, receiptBytes: receiptCost },
      alreadyRegistered: { sourceCount: 0, sourceBytes: 0, receiptCount: 1, receiptBytes: duplicateCost },
      replayed: { sourceCount: 0, sourceBytes: 0, receiptCount: 0, receiptBytes: 0 } } };
}
