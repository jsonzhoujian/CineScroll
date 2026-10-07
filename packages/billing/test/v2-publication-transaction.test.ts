import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryV2PublicationTransactionFixture } from "../src/v2-publication-transaction.ts";
import { fixture, reseal } from "./helpers/v2-source-bundle-fixture.ts";

test("async source values are refused and rejected promises are consumed", async () => {
  const value = fixture();
  for (const reject of [false, true]) {
    const publisher = new InMemoryV2PublicationTransactionFixture({ serviceId: "publisher", access: { authorize: async () => true },
      source: { readCurrentFixture: () => reject ? Promise.reject(new Error("private-async-source")) : Promise.resolve(value.bundle) } });
    await assert.rejects(publisher.publishFromSeal(value.command), { code: "INVALID_SOURCE_BUNDLE" });
    assert.equal(await publisher.lookupPublished(value.command), null);
  }
});

function completedAfter(previous: ReturnType<typeof fixture>) {
  const value = fixture(); value.bundle.seal.generation = 2; value.command.expectedGeneration = 2;
  value.bundle.seal.sealId = "seal-2"; value.command.expectedSealId = "seal-2";
  const execution = value.bundle.records.find(record => record.kind === "execution")!;
  const fence = value.bundle.records.find(record => record.kind === "fence")!;
  Object.assign(execution, { version: "2", revision: 2, predecessorVersion: "1" });
  Object.assign(fence, { version: "2", revision: 2, predecessorVersion: "1", payload: { ...Object(fence.payload), generation: 2 } });
  value.bundle.records.push(...previous.bundle.records.filter(record => ["execution", "fence"].includes(record.kind)).map(record => structuredClone(record)));
  value.command.references.execution.version = "2";
  reseal(value);
  const closure = value.bundle.records.find(record => record.kind === "closure")!;
  closure.payload = { ...Object(closure.payload), fenceVersion: "2", fenceFingerprint: fence.payloadFingerprint, predecessorExecutionVersion: "1" };
  reseal(value); return value;
}

test("publish and lookup observe one committed receipt with the final protocol identity", async () => {
  const value = fixture();
  const publisher = new InMemoryV2PublicationTransactionFixture({ serviceId: "publisher", access: { authorize: async () => true },
    source: { readCurrentFixture: () => value.bundle }, clock: () => new Date("2026-10-07T00:02:00.000Z") });
  const receipt = await publisher.publishFromSeal(value.command);
  assert.equal(receipt.protocolVersion, "evidence-publication-v2");
  assert.equal(receipt.publishedAt, "2026-10-07T00:02:00.000Z");
  assert.equal(receipt.expectedSealId, "seal");
  assert.equal(receipt.expectedManifestFingerprint, value.bundle.seal.fingerprint);
  assert.deepEqual(await publisher.lookupPublished(value.command), receipt);
});

test("an occupied capacity still allows lookup and replay but refuses new identities", async () => {
  const value = fixture(); let available = true;
  const publisher = new InMemoryV2PublicationTransactionFixture({ serviceId: "publisher", access: { authorize: async () => true }, source: { readCurrentFixture: () => { if (!available) throw new Error("source-offline"); return value.bundle; } },
    v1OccupiedRequests: Array.from({ length: 127 }, (_, n) => ({ workspaceId: "studio", requestId: `legacy-${n}` })) });
  const original = await publisher.publishFromSeal(value.command); available = false;
  await assert.rejects(publisher.publishFromSeal({ ...value.command, requestId: "new" }), { code: "CAPACITY" });
  assert.equal(await publisher.lookupPublished({ ...value.command, requestId: "new" }), null);
  assert.deepEqual(await publisher.publishFromSeal(value.command), original);
  assert.deepEqual(await publisher.lookupPublished(value.command), original);
});

test("a lost response after composite save is recovered by the original authorized request", async () => {
  const value = fixture(); let available = true;
  const publisher = new InMemoryV2PublicationTransactionFixture({ serviceId: "publisher", access: { authorize: async () => true },
    source: { readCurrentFixture: () => { if (!available) throw new Error("private-source"); return value.bundle; } }, failAt: "response" });
  await assert.rejects(publisher.publishFromSeal(value.command), { code: "UNAVAILABLE" });
  available = false;
  const original = await publisher.lookupPublished(value.command);
  assert.ok(original);
  assert.deepEqual(await publisher.publishFromSeal(value.command), original);
});

test("source and clock exceptions are sanitized without leaving a request mapping", async () => {
  const value = fixture();
  for (const overrides of [{ source: { readCurrentFixture: () => { throw new Error("private-key"); } } }, { clock: () => { throw new Error("private-clock"); } }]) {
    const publisher = new InMemoryV2PublicationTransactionFixture({ serviceId: "publisher", access: { authorize: async () => true }, source: { readCurrentFixture: () => value.bundle }, ...overrides });
    await assert.rejects(publisher.publishFromSeal(value.command), { code: "UNAVAILABLE", message: "UNAVAILABLE" });
    assert.equal(await publisher.lookupPublished(value.command), null);
  }
});

test("constructor captures service identity, dependency methods and legacy occupancy copies", async () => {
  const value = fixture();
  const options = { serviceId: "publisher", access: { authorize: async (actor: { workspaceId: string; serviceId: string }) => actor.serviceId === "publisher" },
    source: { readCurrentFixture: (): unknown => value.bundle }, v1OccupiedRequests: [{ workspaceId: "studio", requestId: "legacy" }] };
  const publisher = new InMemoryV2PublicationTransactionFixture(options);
  options.serviceId = "attacker"; options.access.authorize = async () => false; options.source.readCurrentFixture = () => null;
  options.v1OccupiedRequests[0]!.requestId = "changed";
  await publisher.publishFromSeal(value.command);
  await assert.rejects(publisher.lookupPublished({ ...value.command, requestId: "legacy" }), { code: "CONFLICT" });
});

test("matching request IDs in different workspaces remain independent", async () => {
  const a = fixture("unknown"), b = fixture("unknown");
  b.bundle.material.binding.workspaceId = "other"; b.command.workspaceId = "other"; reseal(b);
  const publisher = new InMemoryV2PublicationTransactionFixture({ serviceId: "publisher", access: { authorize: async () => true },
    source: { readCurrentFixture: workspaceId => workspaceId === "studio" ? a.bundle : b.bundle } });
  const first = await publisher.publishFromSeal(a.command), second = await publisher.publishFromSeal(b.command);
  assert.notEqual(first.evidenceId, second.evidenceId);
  assert.deepEqual(await publisher.lookupPublished(a.command), first);
  assert.deepEqual(await publisher.lookupPublished(b.command), second);
});

test("a reused seal identity cannot change its historical manifest under a new request", async () => {
  let current = fixture("unknown");
  const publisher = new InMemoryV2PublicationTransactionFixture({ serviceId: "publisher", access: { authorize: async () => true }, source: { readCurrentFixture: () => current.bundle } });
  await publisher.publishFromSeal(current.command);
  current = completedAfter(current); current.bundle.seal.sealId = "seal"; current.command.expectedSealId = "seal"; reseal(current);
  await assert.rejects(publisher.publishFromSeal({ ...current.command, requestId: "changed" }), { code: "CONFLICT" });
});

test("supplement uses a new request and retains immutable predecessor bindings and history", async () => {
  let current = fixture("unknown");
  const publisher = new InMemoryV2PublicationTransactionFixture({ serviceId: "publisher", access: { authorize: async () => true }, source: { readCurrentFixture: () => current.bundle } });
  const oldCommand = structuredClone(current.command);
  const old = await publisher.publishFromSeal(oldCommand);
  current = completedAfter(current);
  const supplement = { ...current.command, requestId: "supplement", operation: "supplement", predecessorId: old.evidenceId };
  const next = await publisher.publishFromSeal(supplement);
  assert.equal(next.predecessorId, old.evidenceId);
  assert.deepEqual(await publisher.lookupPublished(oldCommand), old);
  await assert.rejects(publisher.publishFromSeal({ ...supplement, requestId: "missing", predecessorId: "absent" }), { code: "PREDECESSOR_NOT_FOUND" });
  assert.equal(await publisher.lookupPublished({ ...supplement, requestId: "missing", predecessorId: "absent" }), null);
});

test("concurrent same-key publishes converge and returned receipts are isolated copies", async () => {
  const value = fixture(); let timestamp = 0;
  const publisher = new InMemoryV2PublicationTransactionFixture({ serviceId: "publisher", access: { authorize: async () => true }, source: { readCurrentFixture: () => value.bundle }, clock: () => new Date(1_791_331_320_000 + timestamp++) });
  const receipts = await Promise.all(Array.from({ length: 8 }, () => publisher.publishFromSeal(value.command)));
  for (const receipt of receipts) assert.deepEqual(receipt, receipts[0]);
  const original = structuredClone(receipts[0]); receipts[0]!.publishedAt = "changed";
  assert.deepEqual(await publisher.lookupPublished(value.command), original);
});

test("advanced source heads reject old new requests but keep committed historical replay", async () => {
  const value = fixture("unknown");
  const publisher = new InMemoryV2PublicationTransactionFixture({ serviceId: "publisher", access: { authorize: async () => true }, source: { readCurrentFixture: () => value.bundle } });
  const oldCommand = structuredClone(value.command);
  const original = await publisher.publishFromSeal(oldCommand);
  value.bundle.seal.generation = 2; reseal(value);
  assert.deepEqual(await publisher.publishFromSeal(oldCommand), original);
  await assert.rejects(publisher.publishFromSeal({ ...oldCommand, requestId: "new-request" }), { code: "INVALID_SOURCE_BUNDLE" });
  assert.equal(await publisher.lookupPublished({ ...oldCommand, requestId: "new-request" }), null);
});

test("each staged save failure leaves lookup empty and never advertises a half publication", async () => {
  const value = fixture();
  for (const failAt of ["request", "material", "audit", "receipt"] as const) {
    const publisher = new InMemoryV2PublicationTransactionFixture({ serviceId: "publisher", access: { authorize: async () => true }, source: { readCurrentFixture: () => value.bundle }, failAt });
    await assert.rejects(publisher.publishFromSeal(value.command), { code: "UNAVAILABLE", message: "UNAVAILABLE" });
    assert.equal(await publisher.lookupPublished(value.command), null);
  }
});

test("source movement during preparation aborts new publication without a partial receipt", async () => {
  const value = fixture(); let changed = false;
  const publisher = new InMemoryV2PublicationTransactionFixture({ serviceId: "publisher", access: { authorize: async () => true }, source: { readCurrentFixture: () => value.bundle },
    clock: () => { if (!changed) { changed = true; value.bundle.seal.generation = 2; reseal(value); } return new Date("2026-10-07T00:02:00Z"); } });
  const command = structuredClone(value.command);
  await assert.rejects(publisher.publishFromSeal(command), { code: "CONFLICT" });
  assert.equal(await publisher.lookupPublished(command), null);
});

test("a v1 occupancy shares the same request namespace without importing legacy evidence", async () => {
  const value = fixture();
  const publisher = new InMemoryV2PublicationTransactionFixture({ serviceId: "publisher", access: { authorize: async () => true }, source: { readCurrentFixture: () => value.bundle },
    v1OccupiedRequests: [{ workspaceId: "studio", requestId: "request" }] });
  await assert.rejects(publisher.publishFromSeal(value.command), { code: "CONFLICT" });
  await assert.rejects(publisher.lookupPublished(value.command), { code: "CONFLICT" });
  assert.equal(await publisher.lookupPublished({ ...value.command, workspaceId: "other" }), null);
});

test("same identity replays the exact original receipt and conflicting commands cannot replace it", async () => {
  const value = fixture(); let sourceAvailable = true; let time = 0;
  const publisher = new InMemoryV2PublicationTransactionFixture({ serviceId: "publisher", access: { authorize: async () => true },
    source: { readCurrentFixture: () => { if (!sourceAvailable) throw new Error("private-source"); return value.bundle; } }, clock: () => new Date(1_791_331_320_000 + time++) });
  const original = await publisher.publishFromSeal(value.command);
  sourceAvailable = false;
  assert.deepEqual(await publisher.publishFromSeal(value.command), original);
  for (const changed of [{ expectedGeneration: 2 }, { expectedSealId: "other" }, { expectedManifestFingerprint: "b".repeat(64) }, { unitId: "other" }]) {
    await assert.rejects(publisher.publishFromSeal({ ...value.command, ...changed }), { code: "CONFLICT" });
    await assert.rejects(publisher.lookupPublished({ ...value.command, ...changed }), { code: "CONFLICT" });
  }
  assert.deepEqual(await publisher.lookupPublished(value.command), original);
});

test("revoked or exceptional authorization denies publish, lookup and historical replay", async () => {
  const value = fixture(); let allowed = true;
  const publisher = new InMemoryV2PublicationTransactionFixture({ serviceId: "publisher", access: { authorize: async () => allowed }, source: { readCurrentFixture: () => value.bundle } });
  await publisher.publishFromSeal(value.command); allowed = false;
  await assert.rejects(publisher.publishFromSeal(value.command), { code: "FORBIDDEN" });
  await assert.rejects(publisher.lookupPublished(value.command), { code: "FORBIDDEN" });
  const broken = new InMemoryV2PublicationTransactionFixture({ serviceId: "publisher", access: { authorize: async () => { throw new Error("private-key"); } }, source: { readCurrentFixture: () => value.bundle } });
  await assert.rejects(broken.publishFromSeal(value.command), { code: "FORBIDDEN", message: "FORBIDDEN" });
});
