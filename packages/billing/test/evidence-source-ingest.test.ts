import assert from "node:assert/strict";
import test from "node:test";
import { prepareSourceIngestIdentity } from "../src/index.ts";

const initialize = () => ({ protocolVersion: "source-ingest-v1", workspaceId: "studio", unitId: "unit-1", ingestId: "ingest-1",
  taskReference: { id: "task-1", version: "1" }, snapshotReference: { id: "snapshot-1", version: "1" },
  executionReference: { id: "execution-1", version: "1" } });

test("initialization produces a fixed canonical fingerprint and the shared workspace ingest key", () => {
  const result = prepareSourceIngestIdentity("collector", "initialize", initialize());
  assert.equal(result.commandFingerprint, "ebd501128ae55bf1cc1e376560fa0335fb8d12b9ebf99d3e8996e71c0ff1bce5");
  assert.deepEqual(result.ingestKey, { workspaceId: "studio", ingestId: "ingest-1" });
  assert.equal(result.identity.operation, "initialize");
  assert.equal(result.identity.serviceId, "collector");
});

const register = () => ({ protocolVersion: "source-ingest-v1", workspaceId: "studio", unitId: "unit-1", ingestId: "ingest-1",
  expectedHeadRevision: 1, businessReference: { kind: "task", id: "task-1", version: "1" } });

test("IDs retain v2 UTF16 limits and exact Unicode text without silent normalization", () => {
  for (const value of ["", " id", "id ", "id\nprivate", "https://secret", "*", "?", "a".repeat(257), "😀".repeat(129), undefined]) {
    assert.throws(() => prepareSourceIngestIdentity(value as string, "initialize", initialize()), { code: "INVALID_COMMAND" });
    for (const key of ["workspaceId", "unitId", "ingestId"])
      assert.throws(() => prepareSourceIngestIdentity("collector", "initialize", { ...initialize(), [key]: value }), { code: "INVALID_COMMAND" });
    for (const key of ["taskReference", "snapshotReference", "executionReference"])
      for (const field of ["id", "version"])
        assert.throws(() => prepareSourceIngestIdentity("collector", "initialize", { ...initialize(), [key]: { id: "id", version: "1", [field]: value } }), { code: "INVALID_COMMAND" });
  }
  const unicode = { ...initialize(), workspaceId: "工作室", ingestId: "😀".repeat(128) };
  assert.equal(prepareSourceIngestIdentity("collector", "initialize", unicode).ingestKey.ingestId.length, 256);
  assert.notEqual(prepareSourceIngestIdentity("collector", "initialize", { ...initialize(), unitId: "é" }).commandFingerprint,
    prepareSourceIngestIdentity("collector", "initialize", { ...initialize(), unitId: "e\u0301" }).commandFingerprint);
  assert.throws(() => prepareSourceIngestIdentity("collector", "initialize", { ...initialize(), protocolVersion: "other" }), { code: "INVALID_COMMAND" });
});

test("identity and key are isolated copies without mutating the original command", () => {
  const input = initialize();
  const prepared = prepareSourceIngestIdentity("collector", "initialize", input);
  input.taskReference.id = "changed";
  assert.equal("taskReference" in prepared.identity && prepared.identity.taskReference.id, "task-1");
  prepared.identity.workspaceId = "changed";
  assert.equal(prepared.ingestKey.workspaceId, "studio");
  prepared.ingestKey.ingestId = "changed";
  assert.equal(prepared.identity.ingestId, "ingest-1");
  assert.equal(prepareSourceIngestIdentity("collector", "initialize", initialize()).commandFingerprint,
    "ebd501128ae55bf1cc1e376560fa0335fb8d12b9ebf99d3e8996e71c0ff1bce5");
});

test("strict commands reject extra, missing, accessor, symbol and non JSON fields without evaluating getters", () => {
  let reads = 0;
  const accessor = initialize();
  Object.defineProperty(accessor.taskReference, "id", { enumerable: true, get() { reads++; return "task-1"; } });
  for (const candidate of [null, undefined, [], Object.assign(new Date(), initialize()), { ...initialize(), extra: true },
    { ...initialize(), serviceId: "spoof" }, { ...initialize(), operation: "register" }, { ...initialize(), [Symbol()]: 1 },
    { ...initialize(), taskReference: { id: "task-1" } }, { ...initialize(), executionReference: undefined }, accessor])
    assert.throws(() => prepareSourceIngestIdentity("collector", "initialize", candidate), { code: "INVALID_COMMAND", message: "INVALID_COMMAND" });
  assert.equal(reads, 0);
  for (const mutation of [{ expectedHeadRevision: 0 }, { expectedHeadRevision: 1.5 }, { expectedHeadRevision: Number.MAX_SAFE_INTEGER + 1 },
    { expectedHeadRevision: "1" }, { businessReference: { kind: "execution", id: "id", version: "1" } },
    { businessReference: { kind: "task", id: "id", version: "1", payload: {} } }])
    assert.throws(() => prepareSourceIngestIdentity("collector", "register", { ...register(), ...mutation }), { code: "INVALID_COMMAND" });
  assert.throws(() => prepareSourceIngestIdentity("collector", "register", initialize()), { code: "INVALID_COMMAND" });
  assert.throws(() => prepareSourceIngestIdentity("collector", "initialize", register()), { code: "INVALID_COMMAND" });
});

test("registration and initialization share a key but service, operation and all command facts affect the fingerprint", () => {
  const initial = prepareSourceIngestIdentity("collector", "initialize", initialize());
  const registered = prepareSourceIngestIdentity("collector", "register", register());
  assert.deepEqual(registered.ingestKey, initial.ingestKey);
  assert.notEqual(registered.commandFingerprint, initial.commandFingerprint);
  for (const mutation of [{ expectedHeadRevision: 2 }, { unitId: "unit-2" }, { workspaceId: "other" }, { ingestId: "other" },
    { businessReference: { kind: "snapshot", id: "task-1", version: "1" } },
    { businessReference: { kind: "task", id: "other", version: "1" } },
    { businessReference: { kind: "task", id: "task-1", version: "2" } }])
    assert.notEqual(prepareSourceIngestIdentity("collector", "register", { ...register(), ...mutation }).commandFingerprint, registered.commandFingerprint);
  assert.notEqual(prepareSourceIngestIdentity("other", "register", register()).commandFingerprint, registered.commandFingerprint);
  const reversed = Object.fromEntries(Object.entries(register()).reverse());
  reversed.businessReference = { version: "1", id: "task-1", kind: "task" };
  assert.equal(prepareSourceIngestIdentity("collector", "register", reversed).commandFingerprint, registered.commandFingerprint);
});

test("Chinese snapshot registration matches the independent UTF8 SHA256 vector", () => {
  const input = { ...register(), workspaceId: "工作室", businessReference: { kind: "snapshot", id: "任务一", version: "1" } };
  assert.equal(prepareSourceIngestIdentity("collector", "register", input).commandFingerprint,
    "ee5a3720794a4797942b9e5c8fc2fc85427bb5a2a9f8f4f74780a258e9117130");
});
