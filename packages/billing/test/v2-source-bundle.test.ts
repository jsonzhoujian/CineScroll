import assert from "node:assert/strict";
import test from "node:test";
import { validateV2SourceBundle } from "../src/v2-source-bundle.ts";

import { fixture, reseal } from "./helpers/v2-source-bundle-fixture.ts";

test("complete successful sources prepare final protocol material without publishing", async () => {
  const { command, bundle } = fixture();
  const prepared = await validateV2SourceBundle("publisher", command, bundle);
  assert.equal(prepared.material.id, prepared.identity.evidenceId);
  assert.equal(prepared.material.pricing!.amount, 40);
  assert.equal(prepared.sourceSealId, "seal");
  assert.equal(prepared.sourceFingerprint, bundle.seal.fingerprint);
});

test("unselected historical validation cannot reference a nonexistent result", async () => {
  const a = fixture(); const current = a.bundle.records.find(record => record.kind === "validation")!;
  const old = Object.assign(structuredClone(current), { version: "old", payload: { ...Object(current.payload), resultVersion: "missing" } });
  Object.assign(current, { revision: 2, predecessorVersion: "old" }); a.bundle.records.push(old); reseal(a);
  await assert.rejects(validateV2SourceBundle("publisher", a.command, a.bundle), { code: "INVALID_SOURCE_BUNDLE" });
});

test("unselected historical pricing still requires safe integer amounts and fixed quote associations", async () => {
  for (const mutation of [{ amount: 0.5 }, { amount: -1 }, { amount: 30 }, { quoteId: "missing" }, { resultVersionId: "missing" }]) {
    const a = fixture(); const current = a.bundle.records.find(record => record.kind === "pricing")!;
    const old = Object.assign(structuredClone(current), { version: "old", payload: { ...Object(current.payload), ...mutation } });
    Object.assign(current, { revision: 2, predecessorVersion: "old" }); a.bundle.records.push(old); reseal(a);
    await assert.rejects(validateV2SourceBundle("publisher", a.command, a.bundle), { code: "INVALID_SOURCE_BUNDLE" });
  }
});

test("unselected historical closure must match an existing closed fence and execution predecessor", async () => {
  const a = fixture(); const current = a.bundle.records.find(record => record.kind === "closure")!;
  const old = Object.assign(structuredClone(current), { version: "old", payload: { ...Object(current.payload), fenceFingerprint: "b".repeat(64) } });
  Object.assign(current, { revision: 2, predecessorVersion: "old" }); a.bundle.records.push(old); reseal(a);
  await assert.rejects(validateV2SourceBundle("publisher", a.command, a.bundle), { code: "INVALID_SOURCE_BUNDLE" });
});

test("historical source versions cannot hide changed fixed snapshots or unrecognized payload fields", async () => {
  const a = fixture(); const snapshot = a.bundle.records[1]!;
  const old = Object.assign(structuredClone(snapshot), { version: "old", payload: { ...Object(snapshot.payload), reserved: 1 } });
  Object.assign(snapshot, { revision: 2, predecessorVersion: "old" }); a.bundle.records.push(old); reseal(a);
  await assert.rejects(validateV2SourceBundle("publisher", a.command, a.bundle), { code: "INVALID_SOURCE_BUNDLE" });
  const b = fixture(); b.bundle.records[0]!.payload = { ...Object(b.bundle.records[0]!.payload), secret: "private" }; reseal(b);
  await assert.rejects(validateV2SourceBundle("publisher", b.command, b.bundle), { code: "INVALID_SOURCE_BUNDLE" });
});

test("execution transitions use revision predecessors rather than source arrival order", async () => {
  const value = fixture();
  const execution = value.bundle.records.find(record => record.kind === "execution")!;
  const previous = Object.assign(structuredClone(execution), { version: "z-old", payload: { ...Object(execution.payload), state: "unknown", closed: false } });
  Object.assign(execution, { revision: 2, predecessorVersion: "z-old" });
  const closure = value.bundle.records.find(record => record.kind === "closure")!;
  closure.payload = { ...Object(closure.payload), predecessorExecutionVersion: "z-old" };
  value.bundle.records.push(previous); reseal(value);
  assert.equal((await validateV2SourceBundle("publisher", value.command, value.bundle)).sourceSealId, "seal");
  previous.payload.state = "not_sent"; previous.payload.closed = true; reseal(value);
  await assert.rejects(validateV2SourceBundle("publisher", value.command, value.bundle), { code: "INVALID_SOURCE_BUNDLE" });
});

test("validation and quote relationships reject consistent hashes pointing at the wrong facts", async () => {
  const a = fixture(); const validation = a.bundle.records.find(record => record.kind === "validation")!;
  validation.payload = { ...Object(validation.payload), resultVersion: "other" }; reseal(a);
  await assert.rejects(validateV2SourceBundle("publisher", a.command, a.bundle), { code: "INVALID_SOURCE_BUNDLE" });
  const b = fixture(); b.bundle.material.pricing!.quoteId = "other-quote"; reseal(b);
  await assert.rejects(validateV2SourceBundle("publisher", b.command, b.bundle), { code: "INVALID_SOURCE_BUNDLE" });
});

test("input mutation during asynchronous material checking cannot alter the returned preparation", async () => {
  const value = fixture(); const originalFingerprint = value.bundle.seal.fingerprint;
  const pending = validateV2SourceBundle("publisher", value.command, value.bundle);
  value.bundle.material.pricing!.amount = 999;
  value.command.expectedSealId = "changed";
  const prepared = await pending;
  assert.equal(prepared.material.pricing!.amount, 40);
  assert.equal(prepared.sourceFingerprint, originalFingerprint);
  prepared.material.pricing!.amount = 123;
  assert.equal((await validateV2SourceBundle("publisher", fixture().command, fixture().bundle)).material.pricing!.amount, 40);
});

test("nonzero BYOK pricing cannot pass as a free model responsibility", async () => {
  const a = fixture("completed", "passed", "byok");
  a.bundle.material.pricing!.amount = 1; reseal(a);
  await assert.rejects(validateV2SourceBundle("publisher", a.command, a.bundle), { code: "INVALID_SOURCE_BUNDLE" });
});

test("unknown fields and accessors are rejected before copying and capacity is bounded", async () => {
  const a = fixture(); Object.defineProperty(a.bundle, "private", { enumerable: false, value: "secret" });
  await assert.rejects(validateV2SourceBundle("publisher", a.command, a.bundle), { code: "INVALID_SOURCE_BUNDLE" });
  const b = fixture(); Object.defineProperty(b.bundle.records[0]!, "producerServiceId", { enumerable: true, get: () => "source-producer" });
  await assert.rejects(validateV2SourceBundle("publisher", b.command, b.bundle), { code: "INVALID_SOURCE_BUNDLE" });
  const c = fixture(); c.bundle.records = Array.from({ length: 257 }, () => structuredClone(c.bundle.records[0]!)); reseal(c);
  await assert.rejects(validateV2SourceBundle("publisher", c.command, c.bundle), { code: "INVALID_SOURCE_BUNDLE" });
});

test("invalid producer metadata, broken version chains and stale selected versions are rejected", async () => {
  const a = fixture(); a.bundle.records[0]!.producerServiceId = ""; reseal(a);
  await assert.rejects(validateV2SourceBundle("publisher", a.command, a.bundle), { code: "INVALID_SOURCE_BUNDLE" });
  const b = fixture(); b.bundle.records[0]!.revision = 2; reseal(b);
  await assert.rejects(validateV2SourceBundle("publisher", b.command, b.bundle), { code: "INVALID_SOURCE_BUNDLE" });
  const c = fixture(); c.bundle.records.push({ ...c.bundle.records[1]!, version: "2", revision: 2, predecessorVersion: "1" } as never); reseal(c);
  await assert.rejects(validateV2SourceBundle("publisher", c.command, c.bundle), { code: "INVALID_SOURCE_BUNDLE" });
});

test("unknown, explicit failure, invalid result and BYOK remain distinct existing material judgments", async () => {
  for (const [state, verdict, responsibility] of [["unknown", "passed", "platform"], ["not_sent", "passed", "platform"], ["invalid_response", "passed", "platform"], ["completed", "failed", "platform"], ["completed", "passed", "byok"]]) {
    const { command, bundle } = fixture(state, verdict, responsibility);
    const prepared = await validateV2SourceBundle("publisher", command, bundle);
    assert.equal(prepared.material.pricing?.amount ?? null, responsibility === "byok" ? 0 : null);
  }
  const bad = fixture("not_sent"); bad.bundle.records[3]!.payload = { ...Object(bad.bundle.records[3]!.payload), dispatchAuthorized: true }; reseal(bad);
  await assert.rejects(validateV2SourceBundle("publisher", bad.command, bad.bundle), { code: "INVALID_SOURCE_BUNDLE" });
});

test("unselected second results, duplicate records and hidden pricing cannot disappear behind references", async () => {
  const a = fixture(); const original = a.bundle.records.find(record => record.kind === "result")!;
  a.bundle.records.push({ ...original, id: "second", payload: { ...Object(original.payload), id: "second" } }); reseal(a);
  await assert.rejects(validateV2SourceBundle("publisher", a.command, a.bundle), { code: "INVALID_SOURCE_BUNDLE" });
  const b = fixture(); b.bundle.records.push(structuredClone(b.bundle.records[0]!)); reseal(b);
  await assert.rejects(validateV2SourceBundle("publisher", b.command, b.bundle), { code: "INVALID_SOURCE_BUNDLE" });
  const c = fixture("completed", "failed"); const pricing = fixture().bundle.records.find(record => record.kind === "pricing")!;
  c.bundle.records.push(pricing); reseal(c);
  await assert.rejects(validateV2SourceBundle("publisher", c.command, c.bundle), { code: "INVALID_SOURCE_BUNDLE" });
});

test("closed execution requires a matching closed fence and closure proof, not just a task state", async () => {
  const a = fixture(); a.bundle.records = a.bundle.records.filter(record => record.kind !== "closure"); reseal(a);
  await assert.rejects(validateV2SourceBundle("publisher", a.command, a.bundle), { code: "INVALID_SOURCE_BUNDLE" });
  const b = fixture(); const closure = b.bundle.records.find(record => record.kind === "closure")!;
  closure.payload = { ...Object(closure.payload), dispatchClosed: false }; reseal(b);
  await assert.rejects(validateV2SourceBundle("publisher", b.command, b.bundle), { code: "INVALID_SOURCE_BUNDLE" });
  const c = fixture(); c.bundle.seal.unresolved = true; reseal(c);
  await assert.rejects(validateV2SourceBundle("publisher", c.command, c.bundle), { code: "INVALID_SOURCE_BUNDLE" });
});

test("source binding and payload mismatches are rejected even with recomputed manifest hashes", async () => {
  const a = fixture(); a.bundle.records[0]!.binding = { ...a.bundle.material.binding, workspaceId: "other" }; reseal(a);
  await assert.rejects(validateV2SourceBundle("publisher", a.command, a.bundle), { code: "INVALID_SOURCE_BUNDLE" });
  const b = fixture(); b.bundle.records[1]!.payload = { ...b.bundle.material.snapshot, reserved: 50 }; reseal(b);
  await assert.rejects(validateV2SourceBundle("publisher", b.command, b.bundle), { code: "INVALID_SOURCE_BUNDLE" });
  const c = fixture(); c.command.unitId = "other";
  await assert.rejects(validateV2SourceBundle("publisher", c.command, c.bundle), { code: "INVALID_SOURCE_BUNDLE" });
});

test("missing source records, selected-only manifests and changed seal expectations are refused", async () => {
  const a = fixture(); a.bundle.records.pop();
  await assert.rejects(validateV2SourceBundle("publisher", a.command, a.bundle), { code: "INVALID_SOURCE_BUNDLE" });
  const b = fixture(); b.command.expectedGeneration = 2;
  await assert.rejects(validateV2SourceBundle("publisher", b.command, b.bundle), { code: "INVALID_SOURCE_BUNDLE" });
  const c = fixture(); c.bundle.seal.members.pop();
  await assert.rejects(validateV2SourceBundle("publisher", c.command, c.bundle), { code: "INVALID_SOURCE_BUNDLE" });
});
