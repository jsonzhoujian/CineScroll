import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryV2PublicationTransactionFixture } from "../src/v2-publication-transaction.ts";
import { fixture } from "./helpers/v2-source-bundle-fixture.ts";
import { validateV2SourceBundle } from "../src/v2-source-bundle.ts";

// A synthetic storage boundary fixture, not an expected projection oracle.
async function storedRecord() {
  const value = fixture();
  const prepared = await validateV2SourceBundle("publisher", value.command, value.bundle);
  const identity = prepared.identity;
  const { serviceId, references, ...receiptIdentity } = identity.identity;
  const publishedAt = "2026-10-08T00:00:00.000Z";
  return { protocolVersion: "evidence-publication-v2", request: identity.identity, material: prepared.material,
    audit: { auditId: identity.auditId, serviceId, ruleVersion: "quality", sourceSealId: "seal", sourceFingerprint: prepared.sourceFingerprint,
      generation: 1, verifiedAt: publishedAt, seal: value.bundle.seal, sourceBundle: value.bundle },
    receipt: { ...receiptIdentity, evidenceId: identity.evidenceId, requestFingerprint: identity.requestFingerprint,
      materialFingerprint: prepared.materialFingerprint, auditId: identity.auditId, publishedAt } };
}

test("a committed publication yields only the existing nine settlement fields", async () => {
  const value = fixture();
  const publisher = new InMemoryV2PublicationTransactionFixture({ serviceId: "publisher", access: { authorize: async () => true },
    settlementAccess: { authorize: async (_actor, operation) => operation === "settle" }, source: { readCurrentFixture: () => value.bundle } });
  const receipt = await publisher.publishFromSeal(value.command);
  assert.deepEqual(await publisher.readPublishedEvidence("studio", receipt.evidenceId), {
    id: receipt.evidenceId, workspaceId: "studio", taskId: "task", unitId: "unit", sourceVersionId: "source",
    outcome: "succeeded", amount: 40, resultVersionId: "result", ruleVersion: "quality",
  });
});

test("revocation during a malformed stored read wins over integrity details", async () => {
  let allowed = true;
  const publisher = new InMemoryV2PublicationTransactionFixture({ serviceId: "publisher", access: { authorize: async () => true },
    settlementAccess: { authorize: async () => allowed }, source: { readCurrentFixture: () => null },
    storedPublicationFixture: { read: () => { allowed = false; return { privateDetail: "corrupt" }; } } });
  await assert.rejects(publisher.readPublishedEvidence("studio", "evidence"), { code: "FORBIDDEN" });
});

test("publication rights do not grant settle access and denial hides storage existence", async () => {
  const value = fixture();
  const publisher = new InMemoryV2PublicationTransactionFixture({ serviceId: "publisher", access: { authorize: async () => true },
    source: { readCurrentFixture: () => value.bundle }, storedPublicationFixture: { read: () => { throw new Error("must-not-read"); } } });
  const receipt = await publisher.publishFromSeal(value.command);
  await assert.rejects(publisher.readPublishedEvidence("studio", receipt.evidenceId), { code: "FORBIDDEN" });
  await assert.rejects(publisher.readPublishedEvidence("studio", "absent"), { code: "FORBIDDEN" });
});

test("unknown, failed and BYOK publications preserve the existing projection semantics", async () => {
  for (const [state, verdict, responsibility, expected] of [
    ["unknown", "passed", "platform", { outcome: "unknown", amount: null, resultVersionId: null }],
    ["not_sent", "passed", "platform", { outcome: "failed", amount: null, resultVersionId: null }],
    ["completed", "failed", "platform", { outcome: "failed", amount: null, resultVersionId: null }],
    ["completed", "passed", "byok", { outcome: "succeeded", amount: 0, resultVersionId: "result" }],
  ] as const) {
    const value = fixture(state, verdict, responsibility);
    const publisher = new InMemoryV2PublicationTransactionFixture({ serviceId: "publisher", access: { authorize: async () => true },
      settlementAccess: { authorize: async () => true }, source: { readCurrentFixture: () => value.bundle } });
    const receipt = await publisher.publishFromSeal(value.command);
    const { outcome, amount, resultVersionId } = await publisher.readPublishedEvidence("studio", receipt.evidenceId);
    assert.deepEqual({ outcome, amount, resultVersionId }, expected);
  }
});

test("authorized history survives unavailable or advanced current sources and output mutation", async () => {
  const value = fixture(); let available = true;
  const publisher = new InMemoryV2PublicationTransactionFixture({ serviceId: "publisher", access: { authorize: async () => true },
    settlementAccess: { authorize: async () => true }, source: { readCurrentFixture: () => { if (!available) throw new Error("source-offline"); return value.bundle; } } });
  const receipt = await publisher.publishFromSeal(value.command);
  value.bundle.seal.generation = 2; available = false;
  const first = await publisher.readPublishedEvidence("studio", receipt.evidenceId);
  Reflect.set(first, "amount", 999);
  assert.equal((await publisher.readPublishedEvidence("studio", receipt.evidenceId)).amount, 40);
  await assert.rejects(publisher.readPublishedEvidence("other", receipt.evidenceId), { code: "NOT_FOUND" });
  await assert.rejects(publisher.readPublishedEvidence("studio", "absent"), { code: "NOT_FOUND" });
});

test("bare material and incomplete or altered publication associations are refused", async () => {
  const complete = await storedRecord(); let stored: unknown = complete;
  const publisher = new InMemoryV2PublicationTransactionFixture({ serviceId: "publisher", access: { authorize: async () => false },
    settlementAccess: { authorize: async () => true }, source: { readCurrentFixture: () => { throw new Error("must-not-read-current"); } },
    storedPublicationFixture: { read: () => stored } });
  const evidenceId = complete.receipt.evidenceId;
  assert.equal((await publisher.readPublishedEvidence("studio", evidenceId)).amount, 40);
  const mutations: ((record: typeof complete) => void)[] = [
    record => { Reflect.deleteProperty(record, "request"); },
    record => { Reflect.deleteProperty(record, "audit"); },
    record => { Reflect.deleteProperty(record, "receipt"); },
    record => { record.receipt.requestFingerprint = "0".repeat(64); },
    record => { record.receipt.materialFingerprint = "0".repeat(64); },
    record => { record.receipt.auditId = "other"; },
    record => { record.request.expectedGeneration = 2; },
    record => { record.material.pricing!.amount = 41; },
    record => { record.audit.sourceFingerprint = "0".repeat(64); },
    record => { record.audit.seal.members.pop(); },
    record => { record.audit.sourceBundle.records.pop(); },
    record => { record.audit.sourceBundle.seal.fingerprint = "0".repeat(64); },
    record => { record.audit.verifiedAt = "2026-10-09T00:00:00.000Z"; },
    record => { record.receipt.protocolVersion = "evidence-publication-v1" as "evidence-publication-v2"; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(complete); mutate(changed); stored = changed;
    await assert.rejects(publisher.readPublishedEvidence("studio", evidenceId), { code: "CONFLICT" });
  }
  stored = complete.material;
  await assert.rejects(publisher.readPublishedEvidence("studio", evidenceId), { code: "CONFLICT" });
  stored = complete;
  await assert.rejects(publisher.readPublishedEvidence("other", evidenceId), { code: "CONFLICT" });
});

test("storage exceptions are sanitized and async or non-JSON fixture values cannot escape", async () => {
  let stored: unknown = null; let unavailable = false;
  const publisher = new InMemoryV2PublicationTransactionFixture({ serviceId: "publisher", access: { authorize: async () => false },
    settlementAccess: { authorize: async () => true }, source: { readCurrentFixture: () => null },
    storedPublicationFixture: { read: () => { if (unavailable) throw new Error("private-storage-path"); return stored; } } });
  unavailable = true;
  await assert.rejects(publisher.readPublishedEvidence("studio", "evidence"), { code: "UNAVAILABLE", message: "UNAVAILABLE" });
  unavailable = false;
  for (const candidate of [undefined, { get request() { throw new Error("private-getter"); } }, Promise.resolve(null), Promise.reject(new Error("private-rejection"))]) {
    stored = candidate;
    await assert.rejects(publisher.readPublishedEvidence("studio", "evidence"), { code: "CONFLICT", message: "CONFLICT" });
  }
});

test("settle grants require strict true, fixed identity and bound dependency methods", async () => {
  const record = await storedRecord(); let grant: unknown = true;
  const options = { serviceId: "publisher", access: { authorize: async () => false }, source: { readCurrentFixture: () => null },
    settlementAccess: { authorize: async (actor: { workspaceId: string; serviceId: string }, operation: string) => {
      assert.deepEqual(actor, { workspaceId: "studio", serviceId: "publisher" }); assert.equal(operation, "settle");
      if (grant === "throw") throw new Error("private-auth"); return grant as boolean;
    } }, storedPublicationFixture: { read: () => record } };
  const publisher = new InMemoryV2PublicationTransactionFixture(options);
  options.serviceId = "intruder"; options.settlementAccess.authorize = async () => false; options.storedPublicationFixture.read = () => { throw new Error(); };
  assert.equal((await publisher.readPublishedEvidence("studio", record.receipt.evidenceId)).amount, 40);
  for (const denied of [false, "true", 1, "throw"]) {
    grant = denied;
    await assert.rejects(publisher.readPublishedEvidence("studio", record.receipt.evidenceId), { code: "FORBIDDEN", message: "FORBIDDEN" });
  }
  await assert.rejects(publisher.readPublishedEvidence("*", record.receipt.evidenceId), { code: "FORBIDDEN" });
});
