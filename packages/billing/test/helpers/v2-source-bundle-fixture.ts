import { createHash } from "node:crypto";

// Source producer fixture, not an assertion oracle or a production authenticity proof.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`).join(",")}}`;
  return JSON.stringify(value);
}
const fingerprint = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export function fixture(state = "completed", verdict = "passed", responsibility = "platform") {
  const binding = { workspaceId: "studio", taskId: "task", unitId: "unit", projectId: "project", chapterId: "chapter", sourceVersionId: "source", upstreamVersionIds: ["upstream"] };
  const snapshot = { binding, responsibility, quoteId: "quote", priceVersion: "price", reserved: responsibility === "byok" ? 0 : 60 };
  const execution = { binding, id: "execution", state, closed: state !== "unknown" };
  const results = state === "completed" ? [{ binding, id: "result", executionId: "execution", original: true, persisted: true, validation: verdict, ruleVersion: "quality" }] : [];
  const pricing = results.length && verdict === "passed" ? { binding, id: "pricing", resultVersionId: "result", quoteId: "quote", priceVersion: "price", origin: "quote", amount: responsibility === "byok" ? 0 : 40 } : null;
  const material = { id: "source-placeholder", formatVersion: 1, binding, ruleVersion: "quality", snapshot, execution, results, pricing };
  const record = (kind: string, id: string, payload: unknown) => ({ kind, id, version: "1", revision: 1, predecessorVersion: null,
    payloadFingerprint: fingerprint(payload), producerServiceId: "source-producer", ruleVersion: "quality", recordedAt: "2026-10-07T00:00:00.000Z", businessRecordId: `business-${id}`, binding, payload });
  const records = [record("task", "task", { binding, taskRevision: 1, scopeKeys: ["unit"] }), record("snapshot", "snapshot", snapshot), record("execution", "execution", execution),
    record("fence", "fence", { binding, executionId: "execution", generation: 1, state: execution.closed ? "closed" : "open", dispatchAuthorized: state !== "not_sent" })];
  if (results.length) {
    records.push(record("result", "result", results[0]));
    records.push(record("validation", "validation", { binding, resultId: "result", resultVersion: "1", resultFingerprint: fingerprint(results[0]), verdict, ruleVersion: "quality" }));
  }
  if (pricing) records.push(record("pricing", "pricing", pricing));
  if (execution.closed) records.push(record("closure", "closure", { binding, executionId: "execution", fenceId: "fence", fenceVersion: "1", fenceFingerprint: records[3]!.payloadFingerprint,
    predecessorExecutionVersion: null, reason: state, dispatchClosed: true, resultRegistrationClosed: true }));
  const ref = (id: string) => ({ id, version: "1" });
  const references = { task: ref("task"), snapshot: ref("snapshot"), execution: ref("execution"), result: results.length ? ref("result") : null, validation: results.length ? ref("validation") : null, pricing: pricing ? ref("pricing") : null };
  const manifest = { formatVersion: 1, sealId: "seal", binding, generation: 1, kind: state === "unknown" ? "observation" : "final", ruleVersion: "quality", producerServiceId: "sealer",
    sealedAt: "2026-10-07T00:01:00.000Z", references, unresolved: false, members: records.map(({ payload, ...metadata }) => metadata) };
  const seal = { ...manifest, fingerprint: fingerprint(manifest) };
  const command = { protocolVersion: "evidence-publication-v2", workspaceId: "studio", requestId: "request", unitId: "unit", operation: "publish", references,
    expectedSealId: "seal", expectedGeneration: 1, expectedManifestFingerprint: seal.fingerprint, predecessorId: null };
  return { command, bundle: { formatVersion: 1, material, records, seal } };
}
export function reseal(value: ReturnType<typeof fixture>) {
  for (const record of value.bundle.records) record.payloadFingerprint = fingerprint(record.payload);
  value.bundle.seal.members = value.bundle.records.map(({ payload, ...metadata }) => metadata);
  const { fingerprint: old, ...manifest } = value.bundle.seal;
  value.bundle.seal.fingerprint = fingerprint(manifest);
  value.command.expectedManifestFingerprint = value.bundle.seal.fingerprint;
}

