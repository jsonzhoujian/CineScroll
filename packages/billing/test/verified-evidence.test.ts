import assert from "node:assert/strict";
import test from "node:test";
import { createVerifiedSettlementEvidenceReader } from "../src/verified-evidence.ts";
import { CreditLedgerService, InMemoryCreditLedgerRepository } from "../src/index.ts";

const actor = { workspaceId: "studio", serviceId: "settler" };
const binding = { workspaceId: "studio", taskId: "task", unitId: "unit", projectId: "project", chapterId: "chapter", sourceVersionId: "source", upstreamVersionIds: ["upstream"] };
function material() {
  return { id: "evidence", formatVersion: 1, binding, ruleVersion: "quality-v1",
    snapshot: { binding, responsibility: "platform", quoteId: "quote", priceVersion: "price-v1", reserved: 60 },
    execution: { binding, id: "execution", state: "completed", closed: true },
    results: [{ binding, id: "result", executionId: "execution", original: true, persisted: true, validation: "passed", ruleVersion: "quality-v1" }],
    pricing: { binding, id: "pricing", resultVersionId: "result", quoteId: "quote", priceVersion: "price-v1", origin: "quote", amount: 50 } };
}
test("可信资料匹配后仅投影九字段，不暴露审计元数据", async () => {
  const reader = createVerifiedSettlementEvidenceReader({ access: { authorize: async () => true }, source: { read: async () => material() } });
  assert.deepEqual(await reader.read(actor, "evidence"), { id: "evidence", workspaceId: "studio", taskId: "task", unitId: "unit", sourceVersionId: "source", outcome: "succeeded", amount: 50, resultVersionId: "result", ruleVersion: "quality-v1" });
});

test("错配、重复结果、无计价、伪造来源及非法金额均拒绝", async () => {
  const edits: Array<(data: ReturnType<typeof material>) => void> = [
    data => { data.snapshot.binding = { ...binding, workspaceId: "other" }; },
    data => { data.execution.binding = { ...binding, unitId: "other" }; },
    data => { data.results.push(structuredClone(data.results[0]!)); },
    data => { data.results[0]!.original = false; },
    data => { data.results[0]!.persisted = false; },
    data => { data.results[0]!.binding = { ...binding, upstreamVersionIds: ["other"] }; },
    data => { data.pricing.priceVersion = "new-price"; },
    data => { data.pricing.origin = "provider-cost"; },
    data => { data.pricing.amount = 0.5; },
    data => { data.pricing.amount = -1; },
    data => { data.pricing.amount = Number.MAX_SAFE_INTEGER + 1; },
    data => { data.execution.closed = false; },
  ];
  for (const edit of edits) {
    const data = material(); edit(data);
    const reader = createVerifiedSettlementEvidenceReader({ access: { authorize: async () => true }, source: { read: async () => data } });
    await assert.rejects(() => reader.read(actor, "evidence"), { code: "CONFLICT", message: "CONFLICT" });
  }
  const malformed = { ...material(), snapshot: { ...material().snapshot, responsibility: ["platform"] } };
  const reader = createVerifiedSettlementEvidenceReader({ access: { authorize: async () => true }, source: { read: async () => malformed } });
  await assert.rejects(() => reader.read(actor, "evidence"), { code: "CONFLICT" });
});

test("明确失败与未知各自投影，未关闭发送路径不得释放", async () => {
  for (const [state, closed, outcome] of [["not_sent", true, "failed"], ["invalid_response", true, "failed"], ["unknown", false, "unknown"]] as const) {
    const data = { ...material(), execution: { ...material().execution, state, closed }, results: [], pricing: null };
    const reader = createVerifiedSettlementEvidenceReader({ access: { authorize: async () => true }, source: { read: async () => data } });
    assert.deepEqual(await reader.read(actor, "evidence"), { id: "evidence", workspaceId: "studio", taskId: "task", unitId: "unit", sourceVersionId: "source", outcome, amount: null, resultVersionId: null, ruleVersion: "quality-v1" });
  }
  const data = { ...material(), execution: { ...material().execution, state: "not_sent", closed: false }, results: [], pricing: null };
  const reader = createVerifiedSettlementEvidenceReader({ access: { authorize: async () => true }, source: { read: async () => data } });
  await assert.rejects(() => reader.read(actor, "evidence"), { code: "CONFLICT" });
});

test("缺失、暂不可读和授权失败区分且不泄露源错误", async () => {
  for (const [read, code] of [[async () => null, "NOT_FOUND"], [async () => { throw new Error("private-key"); }, "UNAVAILABLE"], [async () => ({ secret: "private" }), "CONFLICT"]] as const) {
    const reader = createVerifiedSettlementEvidenceReader({ access: { authorize: async () => true }, source: { read } });
    await assert.rejects(() => reader.read(actor, "evidence"), { code, message: code });
  }
  const reader = createVerifiedSettlementEvidenceReader({ access: { authorize: async () => false }, source: { read: async () => { throw new Error("must-not-read"); } } });
  await assert.rejects(() => reader.read(actor, "evidence"), { code: "FORBIDDEN" });
});

test("授权期间修改调用身份或源方法不能改变已绑定读取，输出互相隔离", async () => {
  const caller = { ...actor };
  const source = { read: async (workspaceId: string) => { assert.equal(workspaceId, "studio"); return material(); } };
  const reader = createVerifiedSettlementEvidenceReader({ source, access: { authorize: async input => {
    // @ts-expect-error hostile authorization dependency mutates its runtime input
    input.workspaceId = "attacker";
    caller.workspaceId = "attacker";
    source.read = async () => { throw new Error("changed-source"); };
    return true;
  } } });
  const first = await reader.read(caller, "evidence") as { amount: number };
  first.amount = 999;
  assert.equal((await reader.read(actor, "evidence") as { amount: number }).amount, 50);
});

test("证据适配账本重放不双扣，超报价不截断，拒绝资料不改余额", async () => {
  const data = material();
  const access = { authorize: async () => true };
  const reader = createVerifiedSettlementEvidenceReader({ access, source: { read: async () => data } });
  const ledger = new CreditLedgerService({ access, evidenceReader: reader, repository: new InMemoryCreditLedgerRepository(), clock: () => new Date("2026-10-07") });
  await ledger.grant(actor, { eventId: "g", grantId: "grant", amount: 100, source: "fixture" });
  await ledger.reserve(actor, { eventId: "r", taskId: "task", projectId: "project", chapterId: "chapter", sourceVersionId: "source", quoteId: "quote", priceVersion: "price-v1", responsibility: "platform", units: [{ id: "unit", reserved: 60 }] });
  data.pricing.priceVersion = "wrong";
  const command = { eventId: "s", taskId: "task", unitId: "unit", evidenceId: "evidence" };
  await assert.rejects(() => ledger.settle(actor, command), { code: "INVALID_EVIDENCE" });
  assert.deepEqual(await ledger.balance(actor), { available: 40, reserved: 60, consumed: 0, granted: 100 });
  data.pricing.priceVersion = "price-v1"; data.pricing.amount = 70;
  assert.equal((await reader.read(actor, "evidence") as { amount: number }).amount, 70);
  assert.equal((await ledger.settle(actor, command)).reason, "QUOTE_EXCEEDED");
  assert.deepEqual(await ledger.balance(actor), { available: 40, reserved: 60, consumed: 0, granted: 100 });
  // New immutable evidence/event is required for a subsequent conclusion.
  data.id = "evidence-2"; data.pricing.amount = 50;
  const next = { ...command, eventId: "s2", evidenceId: "evidence-2" };
  await ledger.settle(actor, next); await ledger.settle(actor, next);
  assert.deepEqual(await ledger.balance(actor), { available: 50, reserved: 0, consumed: 50, granted: 100 });
});
