import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryEvidenceSourceSealRepository } from "../src/evidence-source-seal.ts";

const binding = { workspaceId: "studio", unitId: "unit", task: { id: "task", version: "1" }, snapshot: { id: "snapshot", version: "1" } };
const source = (kind: "task" | "snapshot" | "execution" | "result" | "validation" | "pricing", id: string = kind, state: string | null = null, resultId: string | null = null) =>
  ({ kind, id, version: "1", payloadFingerprint: "a".repeat(64), state, resultId });
const target = { workspaceId: "studio", unitId: "unit" };

test("observation seals every registered source and remains readable as history", async () => {
  const repository = new InMemoryEvidenceSourceSealRepository([binding]);
  await repository.registerSource(target, source("task"));
  await repository.registerSource(target, source("snapshot"));
  await repository.registerSource(target, source("execution", "execution", "unknown"));
  const seal = await repository.sealCollection(target, "observation");
  assert.equal(seal.generation, 1);
  assert.equal(seal.sources.length, 3);
  assert.deepEqual(await repository.readSeal("studio", seal.sealId), seal);
});

test("contradictory closed execution versions cannot be consumed as final", async () => {
  const repository = new InMemoryEvidenceSourceSealRepository([binding]);
  for (const record of [source("task"), source("snapshot"), source("execution", "execution", "closed-success")]) await repository.registerSource(target, record);
  await repository.registerSource(target, { ...source("execution", "execution", "closed-failure"), version: "2" });
  await assert.rejects(repository.sealCollection(target, "final"), { code: "INCOMPLETE" });
});

test("concurrent registration and sealing are ordered without omitting registered candidates", async () => {
  const repository = new InMemoryEvidenceSourceSealRepository([binding]);
  for (const record of [source("task"), source("snapshot"), source("execution", "execution", "unknown")]) await repository.registerSource(target, record);
  const [registered, seal] = await Promise.all([repository.registerSource(target, source("result")), repository.sealCollection(target, "observation")]);
  assert.equal(registered.generation, seal.generation);
  assert.equal(seal.sources.filter(record => record.kind === "result").length, 1);
  const [old, late] = await Promise.all([repository.sealCollection(target, "observation"), repository.registerSource(target, source("result", "second"))]);
  assert.equal(late.generation, old.generation + 1);
  await assert.rejects(repository.requireCurrentSeal(target, old), { code: "CONFLICT" });
  assert.equal((await repository.readSeal("studio", old.sealId))!.sources.length, 4);
});

test("bounded collections reject overflow without truncating existing manifests", async () => {
  const repository = new InMemoryEvidenceSourceSealRepository([binding]);
  for (const record of [source("task"), source("snapshot"), source("execution", "execution", "unknown")]) await repository.registerSource(target, record);
  for (let n = 0; n < 253; n++) await repository.registerSource(target, source("result", `candidate-${n}`));
  const seal = await repository.sealCollection(target, "observation");
  await assert.rejects(repository.registerSource(target, source("result", "overflow")), { code: "CAPACITY" });
  assert.equal((await repository.requireCurrentSeal(target, seal)).sources.length, 256);
});

test("quarantined facts replay and conflict without changing final generation", async () => {
  const repository = new InMemoryEvidenceSourceSealRepository([binding]);
  for (const record of [source("task"), source("snapshot"), source("execution", "execution", "closed-failure")]) await repository.registerSource(target, record);
  const seal = await repository.sealCollection(target, "final");
  const late = source("result", "late");
  await repository.registerSource(target, late);
  assert.deepEqual(await repository.registerSource(target, late), { status: "quarantined", generation: 1 });
  assert.deepEqual(await repository.registerSource(target, { ...late, payloadFingerprint: "b".repeat(64) }), { status: "quarantined", generation: 1 });
  assert.deepEqual(await repository.requireCurrentSeal(target, seal), seal);
});

test("invalid sources, fixed binding changes and missing collections fail without altering a seal", async () => {
  const repository = new InMemoryEvidenceSourceSealRepository([binding]);
  await assert.rejects(repository.registerSource(target, { ...source("task"), payloadFingerprint: "private-error" }), { code: "INVALID_SOURCE" });
  await assert.rejects(repository.registerSource(target, source("task", "other-task")), { code: "CONFLICT" });
  await assert.rejects(repository.sealCollection(target, "observation"), { code: "INCOMPLETE" });
  await assert.rejects(repository.registerSource({ workspaceId: "other", unitId: "unit" }, source("task")), { code: "NOT_FOUND" });
  for (const record of [source("task"), source("snapshot"), source("execution", "execution", "unknown")]) await repository.registerSource(target, record);
  const seal = await repository.sealCollection(target, "observation");
  await assert.rejects(repository.sealCollection(target, "bad" as never), { code: "INVALID_SOURCE" });
  assert.equal(await repository.readSeal("other", seal.sealId), null);
  seal.sources.length = 0;
  assert.equal((await repository.readSeal("studio", seal.sealId))!.sources.length, 3);
});

test("success final needs one result with matching validation and pricing; second candidates block final", async () => {
  const repository = new InMemoryEvidenceSourceSealRepository([binding]);
  for (const record of [source("task"), source("snapshot"), source("execution", "execution", "closed-success"), source("result")]) await repository.registerSource(target, record);
  await assert.rejects(repository.sealCollection(target, "final"), { code: "INCOMPLETE" });
  await repository.registerSource(target, source("validation", "validation", "valid", "result"));
  await repository.registerSource(target, source("pricing", "pricing", null, "result"));
  const seal = await repository.sealCollection(target, "final");
  assert.equal(seal.sources.length, 6);
  const duplicate = new InMemoryEvidenceSourceSealRepository([binding]);
  for (const record of [...seal.sources, source("result", "second")]) await duplicate.registerSource(target, record);
  await assert.rejects(duplicate.sealCollection(target, "final"), { code: "INCOMPLETE" });
});

test("version replays do not reopen observation and conflicting fingerprints cannot change history", async () => {
  const repository = new InMemoryEvidenceSourceSealRepository([binding]);
  const execution = source("execution", "execution", "unknown");
  for (const record of [source("task"), source("snapshot"), execution]) await repository.registerSource(target, record);
  const seal = await repository.sealCollection(target, "observation");
  assert.deepEqual(await repository.registerSource(target, execution), { status: "replayed", generation: 1 });
  await assert.rejects(repository.registerSource(target, { ...execution, payloadFingerprint: "b".repeat(64) }), { code: "CONFLICT" });
  assert.deepEqual(await repository.requireCurrentSeal(target, seal), seal);
});

test("final requires closed execution and retains late facts outside its immutable manifest", async () => {
  const repository = new InMemoryEvidenceSourceSealRepository([binding]);
  for (const record of [source("task"), source("snapshot"), source("execution", "execution", "unknown")]) await repository.registerSource(target, record);
  await assert.rejects(repository.sealCollection(target, "final"), { code: "INCOMPLETE" });
  await repository.registerSource(target, { ...source("execution", "execution", "closed-failure"), version: "2" });
  const final = await repository.sealCollection(target, "final");
  assert.deepEqual(await repository.registerSource(target, source("result", "late")), { status: "quarantined", generation: 1 });
  assert.deepEqual(await repository.requireCurrentSeal(target, final), final);
  assert.deepEqual(await repository.readSeal("studio", final.sealId), final);
});

test("late observation results advance generation and reject old seals for new publication without losing history", async () => {
  const repository = new InMemoryEvidenceSourceSealRepository([binding]);
  for (const record of [source("task"), source("snapshot"), source("execution", "execution", "unknown")]) await repository.registerSource(target, record);
  const old = await repository.sealCollection(target, "observation");
  assert.deepEqual(await repository.registerSource(target, source("result")), { status: "registered", generation: 2 });
  await assert.rejects(repository.requireCurrentSeal(target, old), { code: "CONFLICT" });
  assert.deepEqual(await repository.readSeal("studio", old.sealId), old);
  const next = await repository.sealCollection(target, "observation");
  assert.equal(next.sources.length, 4);
  assert.equal(next.generation, 2);
});
