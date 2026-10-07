import assert from "node:assert/strict";
import test from "node:test";
import { prepareV2PublicationIdentity } from "../src/evidence-publication-v2.ts";
import { evidencePublicationId } from "../src/evidence-publication.ts";

const command = () => ({ protocolVersion: "evidence-publication-v2", workspaceId: "studio", requestId: "request-1", unitId: "unit-1", operation: "publish",
  references: { task: { id: "task-1", version: "1" }, snapshot: { id: "snapshot-1", version: "1" }, execution: { id: "execution-1", version: "1" }, result: null, validation: null, pricing: null },
  expectedSealId: "seal-1", expectedGeneration: 1, expectedManifestFingerprint: "a".repeat(64), predecessorId: null });

test("v2 preparation matches contract vectors without changing the legacy v1 ID", () => {
  const prepared = prepareV2PublicationIdentity("publisher", command());
  assert.equal(prepared.requestFingerprint, "427658c7684e0eba33e46f1664b923db488b5fa3d7c977418263cad5703e8759");
  assert.equal(prepared.evidenceId, "evp2_9334b4e364a5bd11f01ccaf89c275e26886058818743892b028b264f9df3b665");
  assert.equal(prepared.auditId, "audit2_9334b4e364a5bd11f01ccaf89c275e26886058818743892b028b264f9df3b665");
  assert.equal(prepared.identity.serviceId, "publisher");
  assert.equal(evidencePublicationId("studio", "request-1"), "evp_ec4e5f98ccdd94c32550dc4fb85ea2856d9e9eda66ab0f7f00acba4cac8fb27a");
});

test("field order does not change identity while every seal expectation changes its fingerprint", () => {
  const prepared = prepareV2PublicationIdentity("publisher", command());
  const reordered: Record<string, unknown> = Object.fromEntries(Object.entries(command()).reverse());
  reordered.references = Object.fromEntries(Object.entries(command().references).reverse());
  assert.equal(prepareV2PublicationIdentity("publisher", reordered).requestFingerprint, prepared.requestFingerprint);
  for (const mutation of [{ expectedSealId: "seal-2" }, { expectedGeneration: 2 }, { expectedManifestFingerprint: "b".repeat(64) }, { unitId: "unit-2" }]) {
    const changed = prepareV2PublicationIdentity("publisher", { ...command(), ...mutation });
    assert.notEqual(changed.requestFingerprint, prepared.requestFingerprint);
    assert.equal(changed.evidenceId, prepared.evidenceId);
  }
  assert.notEqual(prepareV2PublicationIdentity("other-publisher", command()).requestFingerprint, prepared.requestFingerprint);
});

test("prepared identity is isolated from later input and output mutations", () => {
  const input = command();
  const prepared = prepareV2PublicationIdentity("publisher", input);
  input.references.task.id = "changed";
  assert.equal(prepared.identity.references.task.id, "task-1");
  Object.assign(prepared.identity.references.task, { id: "output-changed" });
  assert.equal(prepareV2PublicationIdentity("publisher", command()).identity.references.task.id, "task-1");
});

test("unknown symbol fields, accessors and non-JSON objects cannot be normalized into accepted commands", () => {
  const withSymbol = { ...command(), [Symbol("secret")]: "private" };
  assert.throws(() => prepareV2PublicationIdentity("publisher", withSymbol), { code: "INVALID_PUBLICATION" });
  const withAccessor = command();
  Object.defineProperty(withAccessor, "workspaceId", { enumerable: true, get: () => "studio" });
  assert.throws(() => prepareV2PublicationIdentity("publisher", withAccessor), { code: "INVALID_PUBLICATION" });
  assert.throws(() => prepareV2PublicationIdentity("publisher", Object.assign(new Date(), command())), { code: "INVALID_PUBLICATION" });
});

test("publish requires null predecessor and supplement rejects invalid or self predecessors", () => {
  assert.throws(() => prepareV2PublicationIdentity("publisher", { ...command(), predecessorId: "previous" }), { code: "INVALID_PUBLICATION" });
  assert.throws(() => prepareV2PublicationIdentity("publisher", { ...command(), operation: "supplement" }), { code: "INVALID_PUBLICATION" });
  const prepared = prepareV2PublicationIdentity("publisher", command());
  assert.throws(() => prepareV2PublicationIdentity("publisher", { ...command(), operation: "supplement", predecessorId: prepared.evidenceId }), { code: "INVALID_PUBLICATION" });
  const supplement = prepareV2PublicationIdentity("publisher", { ...command(), operation: "supplement", predecessorId: "previous" });
  assert.equal(supplement.identity.predecessorId, "previous");
  assert.notEqual(supplement.requestFingerprint, prepared.requestFingerprint);
});

test("v2 validates every nested reference and does not silently omit unknown or missing fields", () => {
  for (const ref of [null, { id: "task-1" }, { id: "task-1", version: "1", extra: true }, { id: "task-1", version: "*" }, { id: "task?", version: "1" }])
    assert.throws(() => prepareV2PublicationIdentity("publisher", { ...command(), references: { ...command().references, task: ref } }), { code: "INVALID_PUBLICATION" });
  assert.throws(() => prepareV2PublicationIdentity("publisher", { ...command(), references: { ...command().references, extra: true } }), { code: "INVALID_PUBLICATION" });
  assert.throws(() => prepareV2PublicationIdentity("publisher", { ...command(), references: { ...command().references, result: undefined } }), { code: "INVALID_PUBLICATION" });
});

test("v2 rejects invalid version, strings, generation and fingerprints with sanitized errors", () => {
  const malformed = [
    { protocolVersion: "evidence-publication-v1" }, { protocolVersion: undefined }, { workspaceId: " studio" },
    { requestId: "https://secret.invalid" }, { unitId: "*" }, { expectedSealId: "seal\nsecret" },
    { expectedGeneration: 0 }, { expectedGeneration: 1.5 }, { expectedGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { expectedManifestFingerprint: "A".repeat(64) }, { expectedManifestFingerprint: 123 }, { operation: "read" },
  ];
  for (const mutation of malformed) assert.throws(() => prepareV2PublicationIdentity("publisher", { ...command(), ...mutation }), { code: "INVALID_PUBLICATION", message: "INVALID_PUBLICATION" });
  for (const serviceId of ["", "*", " publisher", "https://secret.invalid", "x".repeat(257)])
    assert.throws(() => prepareV2PublicationIdentity(serviceId, command()), { code: "INVALID_PUBLICATION" });
});

test("v2 rejects caller-supplied identity, raw material and unknown fields instead of ignoring them", () => {
  for (const extra of [{ serviceId: "attacker" }, { material: {} }, { complete: true }, { amount: 1 }]) {
    assert.throws(() => prepareV2PublicationIdentity("publisher", { ...command(), ...extra }), { code: "INVALID_PUBLICATION" });
  }
  assert.throws(() => prepareV2PublicationIdentity("publisher", null), { code: "INVALID_PUBLICATION" });
});
