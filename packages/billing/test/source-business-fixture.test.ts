import assert from "node:assert/strict";
import test from "node:test";
import { prepareSourceBusinessFixture, type SourceBusinessFixture, type FixtureTaskRevision } from "../src/index.ts";

function fixture(): SourceBusinessFixture & { tasks: [FixtureTaskRevision, ...FixtureTaskRevision[]] } {
  const binding = { workspaceId: "studio", taskId: "task", unitId: "unit", projectId: "project", chapterId: "chapter", sourceVersionId: "source", upstreamVersionIds: ["knowledge", "outline"] };
  const common = { version: "v1", binding, producerServiceId: "producer", recordedAt: "2026-10-08T00:00:00.000Z" };
  const taskAnchorReference = { id: "task", version: "v1" }, snapshotReference = { id: "snapshot", version: "v1" }, executionReference = { id: "execution", version: "v1" };
  const pricing = { responsibility: "platform" as const, quoteId: "quote", priceVersion: "price-v1", reserved: 7 };
  return {
    tasks: [{ ...common, id: "task", revision: 1, predecessorVersion: null, scopeKeys: ["unit"], snapshotReference, executionReference }],
    snapshot: { ...common, id: "snapshot", ...pricing, quoteReference: { id: "quote-record", version: "v1" }, taskAnchorReference, executionReference },
    execution: { ...common, id: "execution", taskAnchorReference, snapshotReference },
    quote: { ...common, id: "quote-record", ...pricing, pricingRuleVersion: "rule-v1", taskAnchorReference, executionReference },
  };
}

test("four consistent business records produce independent documents without granting storage authority", () => {
  const input = fixture(), result = prepareSourceBusinessFixture(input);
  assert.equal(result.records.length, 4);
  assert.deepEqual(result.records.map(row => row.kind), ["task", "snapshot", "execution", "quote"]);
  assert.equal(result.records[0]!.workspaceId, "studio");
  assert.deepEqual(result.records[0]!.document, input.tasks[0]);
  input.tasks[0].binding.upstreamVersionIds.reverse();
  assert.deepEqual(result.records[0]!.document.binding.upstreamVersionIds, ["knowledge", "outline"]);
  result.records[0]!.document.binding.workspaceId = "changed";
  assert.equal(result.records[1]!.document.binding.workspaceId, "studio");
});

test("the execution document has a fixed reviewed UTF8 canonical and SHA256 vector", () => {
  const execution = prepareSourceBusinessFixture(fixture()).records[2]!;
  assert.equal(execution.canonical, '{"binding":{"chapterId":"chapter","projectId":"project","sourceVersionId":"source","taskId":"task","unitId":"unit","upstreamVersionIds":["knowledge","outline"],"workspaceId":"studio"},"id":"execution","producerServiceId":"producer","recordedAt":"2026-10-08T00:00:00.000Z","snapshotReference":{"id":"snapshot","version":"v1"},"taskAnchorReference":{"id":"task","version":"v1"},"version":"v1"}');
  assert.equal(execution.byteLength, 391);
  assert.equal(execution.businessFingerprint, "b8caea6b437005e18d0566157eeeb48723a372fae527de1b4236884a5950b9da");
});

test("preparation rejects empty or excessive chains and bounds ordered IDs and traversal work", () => {
  const empty = fixture(); empty.tasks.length = 0;
  assert.throws(() => prepareSourceBusinessFixture(empty), { code: "INVALID_BUSINESS_FIXTURE" });
  const excessive: SourceBusinessFixture = fixture(); excessive.tasks = Array.from({ length: 4094 }, () => structuredClone(excessive.tasks[0]!));
  assert.throws(() => prepareSourceBusinessFixture(excessive), { code: "INVALID_BUSINESS_FIXTURE" });
  const valid = fixture(); valid.tasks[0].binding.upstreamVersionIds = Array.from({ length: 100 }, (_, index) => `upstream-${index}`);
  assert.equal(prepareSourceBusinessFixture(valid).records.length, 4);
  valid.tasks[0].binding.upstreamVersionIds.push("upstream-100");
  assert.throws(() => prepareSourceBusinessFixture(valid), { code: "INVALID_BUSINESS_FIXTURE" });
  const manyNodes: SourceBusinessFixture = fixture();
  const first = manyNodes.tasks[0]!;
  first.binding.upstreamVersionIds = Array.from({ length: 100 }, (_, n) => `up-${n}`);
  manyNodes.tasks = Array.from({ length: 1000 }, (_, index) => ({ ...structuredClone(first), revision: index + 1,
    version: `v${index + 1}`, predecessorVersion: index === 0 ? null : `v${index}`,
    binding: structuredClone(first.binding) }));
  assert.throws(() => prepareSourceBusinessFixture(manyNodes), { code: "INVALID_BUSINESS_FIXTURE" });
});

test("strict data inspection never invokes getters and rejects cycles, hidden fields and unsupported text", () => {
  let calls = 0;
  const getter = fixture(); Object.defineProperty(getter.execution, "id", { enumerable: true, get() { calls++; return "execution"; } });
  const hidden = fixture(); Object.defineProperty(hidden.quote, "secret", { value: "secret", enumerable: false });
  const cyclic = fixture(); Object.assign(cyclic.quote, { loop: cyclic });
  const symbol = fixture(); Object.assign(symbol.quote, { [Symbol("extra")]: true });
  const sparse = fixture(); sparse.tasks[0].scopeKeys = new Array(1);
  for (const input of [getter, hidden, cyclic, symbol, sparse, undefined, null])
    assert.throws(() => prepareSourceBusinessFixture(input), { code: "INVALID_BUSINESS_FIXTURE" });
  assert.equal(calls, 0);
  for (const value of ["bad\u0000id", "bad\ud800id", "x".repeat(257), " padded ", "*", "?"]) {
    const input = fixture(); input.quote.pricingRuleVersion = value;
    assert.throws(() => prepareSourceBusinessFixture(input), { code: "INVALID_BUSINESS_FIXTURE" });
  }
});

test("BYOK accepts zero fixed reserve and canonical records do not depend on object key insertion order", () => {
  const input = fixture();
  input.quote.responsibility = input.snapshot.responsibility = "byok";
  input.quote.reserved = input.snapshot.reserved = 0;
  const first = prepareSourceBusinessFixture(input);
  const reordered = { quote: input.quote, execution: input.execution, snapshot: input.snapshot, tasks: input.tasks.map(task => Object.fromEntries(Object.entries(task).reverse())) };
  assert.deepEqual(prepareSourceBusinessFixture(reordered), first);
  input.quote.reserved = input.snapshot.reserved = 1;
  assert.throws(() => prepareSourceBusinessFixture(input), { code: "INVALID_BUSINESS_FIXTURE" });
});

test("task chain starts at revision one and preserves identity, producer and chronological order", () => {
  const input = fixture();
  const next = { ...structuredClone(input.tasks[0]), version: "v2", revision: 2, predecessorVersion: "v1", recordedAt: "2026-10-08T00:00:01.000Z" };
  input.tasks.push(next);
  assert.equal(prepareSourceBusinessFixture(input).records.length, 5);
  for (const patch of [
    { revision: 3 }, { predecessorVersion: "missing" }, { version: "v1" },
    { producerServiceId: "other" }, { recordedAt: "2026-10-07T00:00:00.000Z" },
    { executionReference: { id: "other", version: "v1" } },
  ]) {
    const changed = structuredClone(input); Object.assign(changed.tasks[1]!, patch);
    assert.throws(() => prepareSourceBusinessFixture(changed), { code: "INVALID_BUSINESS_FIXTURE" });
  }
  const changed = fixture(); changed.tasks[0].revision = 2;
  assert.throws(() => prepareSourceBusinessFixture(changed), { code: "INVALID_BUSINESS_FIXTURE" });
});

test("malformed records and self-reported extra authority are rejected with a sanitized error", () => {
  for (const change of [
    (value: ReturnType<typeof fixture>) => { value.tasks[0].revision = 0; },
    (value: ReturnType<typeof fixture>) => { value.quote.reserved = 0; },
    (value: ReturnType<typeof fixture>) => { value.execution.recordedAt = "2026-02-30T00:00:00.000Z"; },
    (value: ReturnType<typeof fixture>) => { Object.assign(value.execution, { closed: true }); },
    (value: ReturnType<typeof fixture>) => { value.tasks[0].binding.workspaceId = "secret://host"; },
  ]) {
    const input = structuredClone(fixture()); change(input);
    assert.throws(() => prepareSourceBusinessFixture(input), { code: "INVALID_BUSINESS_FIXTURE", message: "INVALID_BUSINESS_FIXTURE" });
  }
});

test("cross-record bindings, anchors, fixed references and quote terms must agree", () => {
  for (const change of [
    (value: ReturnType<typeof fixture>) => { value.execution.binding = { ...value.execution.binding, workspaceId: "other" }; },
    (value: ReturnType<typeof fixture>) => { value.quote.binding = { ...value.quote.binding, upstreamVersionIds: ["outline", "knowledge"] }; },
    (value: ReturnType<typeof fixture>) => { value.snapshot.quoteReference = { id: "missing", version: "v1" }; },
    (value: ReturnType<typeof fixture>) => { value.quote.reserved = 8; },
    (value: ReturnType<typeof fixture>) => { value.execution.taskAnchorReference = { id: "task", version: "v2" }; },
    (value: ReturnType<typeof fixture>) => { value.tasks[0].id = "wrong-task"; },
    (value: ReturnType<typeof fixture>) => { value.tasks[0].scopeKeys = ["other-unit"]; },
  ]) {
    const input = fixture(); change(input);
    assert.throws(() => prepareSourceBusinessFixture(input), { code: "INVALID_BUSINESS_FIXTURE" });
  }
});
