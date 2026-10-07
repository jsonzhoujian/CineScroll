import assert from "node:assert/strict";
import test from "node:test";
import { CreditLedgerService, InMemoryCreditLedgerRepository } from "../src/index.ts";

const actor = { workspaceId: "w", serviceId: "billing-fixture" };
function fixture(repository = new InMemoryCreditLedgerRepository()) {
  return new CreditLedgerService({ repository,
    access: { authorize: async (a) => a.serviceId === "billing-fixture" },
    clock: () => new Date("2026-10-07T00:00:00Z") });
}
function evidenceFixture() {
  const evidence = new Map<string, { id: string; workspaceId: string; taskId: string; unitId: string; sourceVersionId: string;
    outcome: "succeeded" | "failed" | "unknown"; amount: number | null; resultVersionId: string | null; ruleVersion: string }>();
  const ledger = new CreditLedgerService({ repository: new InMemoryCreditLedgerRepository(),
    access: { authorize: async a => a.serviceId === "billing-fixture" },clock: () => new Date("2026-10-07T00:00:00Z"),
    evidenceReader: { read: async (_actor,id) => structuredClone(evidence.get(id) ?? null) } });
  return { ledger,evidence };
}
const reservation = { eventId: "reserve-1",taskId: "t",projectId: "p",chapterId: "c",sourceVersionId: "s",
  quoteId: "q",priceVersion: "v1",responsibility: "platform" as const,units: [{ id: "u",reserved: 60 }] };

test("C01授予100后冻结60，可用40且尚未消耗", async () => {
  const ledger = fixture();
  await ledger.grant(actor,{ eventId: "grant-1",grantId: "g",amount: 100,source: "fixture" });
  await ledger.reserve(actor,reservation);
  assert.deepEqual(await ledger.balance(actor),{ available: 40,reserved: 60,consumed: 0,granted: 100 });
  assert.deepEqual((await ledger.entries(actor)).map(e => [e.operation,e.amount]),[["grant",100],["reserve",60]]);
});
test("授予与冻结按固定事件和业务身份幂等，不同内容拒绝且不重复占用", async () => {
  const ledger = fixture(),grant = { eventId: "g1",grantId: "g",amount: 100,source: "fixture" };
  const original = await ledger.grant(actor,grant);
  assert.deepEqual(await ledger.grant(actor,{ source: "fixture",amount: 100,grantId: "g",eventId: "g1" }),original);
  await assert.rejects(() => ledger.grant(actor,{ ...grant,amount: 101 }),{ code: "EVENT_CONFLICT" });
  await assert.rejects(() => ledger.grant(actor,{ ...grant,eventId: "g2" }),{ code: "STATE_CONFLICT" });
  const reserved = await ledger.reserve(actor,reservation);
  assert.deepEqual(await ledger.reserve(actor,reservation),reserved);
  await assert.rejects(() => ledger.reserve(actor,{ ...reservation,eventId: "r2" }),{ code: "STATE_CONFLICT" });
  assert.equal((await ledger.entries(actor)).length,2);
});
test("C02可信成功50结算冻结60，差额10释放且重复证据不双扣", async () => {
  const { ledger,evidence } = evidenceFixture();
  await ledger.grant(actor,{ eventId: "g1",grantId: "g",amount: 100,source: "fixture" });
  await ledger.reserve(actor,reservation);
  evidence.set("ev",{ id: "ev",workspaceId: "w",taskId: "t",unitId: "u",sourceVersionId: "s",
    outcome: "succeeded",amount: 50,resultVersionId: "result",ruleVersion: "rule1" });
  const command = { eventId: "settle1",taskId: "t",unitId: "u",evidenceId: "ev" };
  const receipt = await ledger.settle(actor,command);
  assert.deepEqual(await ledger.balance(actor),{ available: 50,reserved: 0,consumed: 50,granted: 100 });
  assert.deepEqual((await ledger.entries(actor)).map(e => [e.operation,e.amount]),[["grant",100],["reserve",60],["consume",50],["release",10]]);
  assert.deepEqual(await ledger.settle(actor,command),receipt);
  await assert.rejects(() => ledger.settle(actor,{ ...command,eventId: "another" }),{ code: "STATE_CONFLICT" });
});
test("C04明确失败释放、未知保留冻结，后续可信证据只结算未知单元", async () => {
  const { ledger,evidence } = evidenceFixture();
  await ledger.grant(actor,{ eventId: "g1",grantId: "g",amount: 100,source: "fixture" });
  await ledger.reserve(actor,{ ...reservation,units: [{ id: "a",reserved: 30 },{ id: "b",reserved: 40 },{ id: "c",reserved: 30 }] });
  for (const [unitId,outcome,amount] of [["a","succeeded",30],["b","failed",null],["c","unknown",null]] as const) {
    const id = `ev-${unitId}`;
    evidence.set(id,{ id,workspaceId: "w",taskId: "t",unitId,sourceVersionId: "s",outcome,amount,
      resultVersionId: outcome === "succeeded" ? "result" : null,ruleVersion: "rule1" });
    await ledger.settle(actor,{ eventId: `settle-${unitId}`,taskId: "t",unitId,evidenceId: id });
  }
  assert.deepEqual(await ledger.balance(actor),{ available: 40,reserved: 30,consumed: 30,granted: 100 });
  assert.equal((await ledger.task(actor,"t")).units.find(u => u.id === "c")!.state,"reconciling");
  evidence.set("later",{ id: "later",workspaceId: "w",taskId: "t",unitId: "c",sourceVersionId: "s",outcome: "succeeded",amount: 20,resultVersionId: "later-result",ruleVersion: "rule1" });
  await ledger.settle(actor,{ eventId: "settle-later",taskId: "t",unitId: "c",evidenceId: "later" });
  assert.deepEqual(await ledger.balance(actor),{ available: 50,reserved: 0,consumed: 50,granted: 100 });
});
test("BYOK固定责任为exempt，成功失败未知均不记录冻结或扣费流水", async () => {
  const { ledger,evidence } = evidenceFixture();
  await ledger.reserve(actor,{ ...reservation,responsibility: "byok",units: [{ id: "u",reserved: 0 }] });
  assert.equal((await ledger.task(actor,"t")).units[0]!.state,"exempt");
  for (const outcome of ["succeeded","failed","unknown"] as const) {
    evidence.set(outcome,{ id: outcome,workspaceId: "w",taskId: "t",unitId: "u",sourceVersionId: "s",outcome,
      amount: outcome === "succeeded" ? 0 : null,resultVersionId: outcome === "succeeded" ? "result" : null,ruleVersion: "r" });
    assert.equal((await ledger.settle(actor,{ eventId: outcome,taskId: "t",unitId: "u",evidenceId: outcome })).status,"exempt");
  }
  assert.deepEqual(await ledger.entries(actor),[]);
  assert.deepEqual(await ledger.balance(actor),{ available: 0,reserved: 0,consumed: 0,granted: 0 });
});
test("超出预留报价不透支，保持冻结并返回QUOTE_EXCEEDED待对账", async () => {
  const { ledger,evidence } = evidenceFixture();
  await ledger.grant(actor,{ eventId: "g",grantId: "g",amount: 100,source: "fixture" });
  await ledger.reserve(actor,reservation);
  evidence.set("over",{ id: "over",workspaceId: "w",taskId: "t",unitId: "u",sourceVersionId: "s",outcome: "succeeded",amount: 70,resultVersionId: "result",ruleVersion: "r" });
  assert.deepEqual(await ledger.settle(actor,{ eventId: "over",taskId: "t",unitId: "u",evidenceId: "over" }),
    { eventId: "over",taskId: "t",unitId: "u",status: "reconciling",reason: "QUOTE_EXCEEDED" });
  assert.deepEqual(await ledger.balance(actor),{ available: 40,reserved: 60,consumed: 0,granted: 100 });
});
test("非法命令与重复单元拒绝，整个冻结原子失败且账本不变", async () => {
  const ledger = fixture();
  for (const amount of [0,-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) {
    await assert.rejects(() => ledger.grant(actor,{ eventId: "g",grantId: "g",amount,source: "fixture" }),{ code: "INVALID_COMMAND" });
  }
  await ledger.grant(actor,{ eventId: "g",grantId: "g",amount: 100,source: "fixture" });
  for (const command of [
    { ...reservation,units: [] },{ ...reservation,units: [{ id: "u",reserved: 20 },{ id: "u",reserved: 20 }] },
    { ...reservation,units: [{ id: "u",reserved: 0 }] },{ ...reservation,responsibility: "byok" as const },
    { ...reservation,taskId: "" },{ ...reservation,quoteId: "bad\nid" },{ ...reservation,units: [{ id: "u",reserved: 0.5 }] },
    { ...reservation,apiKey: "forbidden-extra" },
  ]) await assert.rejects(() => ledger.reserve(actor,command),{ code: "INVALID_COMMAND" });
  await assert.rejects(() => ledger.reserve(actor,{ ...reservation,units: [{ id: "a",reserved: 70 },{ id: "b",reserved: 40 }] }),{ code: "INSUFFICIENT_CREDITS" });
  assert.deepEqual(await ledger.balance(actor),{ available: 100,reserved: 0,consumed: 0,granted: 100 });
  assert.equal((await ledger.entries(actor)).length,1);
  await assert.rejects(() => ledger.task(actor,"t"),{ code: "TASK_NOT_FOUND" });
});
test("结算只接受严格匹配的可信证据，拒绝伪造范围与附加字段", async () => {
  const { ledger,evidence } = evidenceFixture();
  await ledger.grant(actor,{ eventId: "g",grantId: "g",amount: 100,source: "fixture" });
  await ledger.reserve(actor,reservation);
  const good = { id: "ev",workspaceId: "w",taskId: "t",unitId: "u",sourceVersionId: "s",outcome: "succeeded" as const,amount: 50,resultVersionId: "result",ruleVersion: "r" };
  for (const bad of [{ ...good,workspaceId: "other" },{ ...good,taskId: "other" },{ ...good,unitId: "other" },
    { ...good,sourceVersionId: "other" },{ ...good,resultVersionId: null },{ ...good,amount: 1.5 },{ ...good,apiKey: "should-not-retain" }]) {
    evidence.set("ev",bad);
    await assert.rejects(() => ledger.settle(actor,{ eventId: "settle",taskId: "t",unitId: "u",evidenceId: "ev" }),{ code: "INVALID_EVIDENCE" });
  }
  const forged = { eventId: "forged",taskId: "t",unitId: "u",evidenceId: "ev",amount: 1 };
  await assert.rejects(() => ledger.settle(actor,forged),{ code: "INVALID_COMMAND" });
  assert.deepEqual(await ledger.balance(actor),{ available: 40,reserved: 60,consumed: 0,granted: 100 });
});
test("同证据ID不得改写内容或改用新事件ID绕过证据去重", async () => {
  const { ledger,evidence } = evidenceFixture();
  await ledger.grant(actor,{ eventId: "g",grantId: "g",amount: 100,source: "fixture" });
  await ledger.reserve(actor,reservation);
  const original = { id: "ev",workspaceId: "w",taskId: "t",unitId: "u",sourceVersionId: "s",outcome: "unknown" as const,amount: null,resultVersionId: null,ruleVersion: "r" };
  evidence.set("ev",original);
  await ledger.settle(actor,{ eventId: "unknown",taskId: "t",unitId: "u",evidenceId: "ev" });
  await assert.rejects(() => ledger.settle(actor,{ eventId: "duplicate",taskId: "t",unitId: "u",evidenceId: "ev" }),{ code: "STATE_CONFLICT" });
  evidence.set("ev",{ ...original,outcome: "succeeded",amount: 50,resultVersionId: "result" });
  await assert.rejects(() => ledger.settle(actor,{ eventId: "changed",taskId: "t",unitId: "u",evidenceId: "ev" }),{ code: "EVENT_CONFLICT" });
  assert.equal((await ledger.balance(actor)).reserved,60);
});
test("C05共享仓储的两个服务并发冻结不透支，结算并发只产生一组流水", async () => {
  const repository = new InMemoryCreditLedgerRepository(),a = fixture(repository),b = fixture(repository);
  await a.grant(actor,{ eventId: "g",grantId: "g",amount: 100,source: "fixture" });
  const results = await Promise.allSettled([a.reserve(actor,reservation),b.reserve(actor,{ ...reservation,eventId: "r2",taskId: "t2" })]);
  assert.equal(results.filter(r => r.status === "fulfilled").length,1);
  const failure = results.find(r => r.status === "rejected")!;
  assert.equal(failure.status === "rejected" && failure.reason.code,"INSUFFICIENT_CREDITS");
  assert.deepEqual(await b.balance(actor),{ available: 40,reserved: 60,consumed: 0,granted: 100 });
  const { ledger,evidence } = evidenceFixture();
  await ledger.grant(actor,{ eventId: "g",grantId: "g",amount: 100,source: "fixture" });
  await ledger.reserve(actor,reservation);
  evidence.set("ev",{ id: "ev",workspaceId: "w",taskId: "t",unitId: "u",sourceVersionId: "s",outcome: "succeeded",amount: 50,resultVersionId: "result",ruleVersion: "r" });
  const command = { eventId: "settle",taskId: "t",unitId: "u",evidenceId: "ev" };
  const receipts = await Promise.all([ledger.settle(actor,command),ledger.settle(actor,command),ledger.settle(actor,command)]);
  assert.deepEqual(receipts[0],receipts[2]);
  assert.equal((await ledger.entries(actor)).length,4);
  assert.equal((await ledger.balance(actor)).consumed,50);
});
test("可信服务授权按动作执行，租户隔离且查询副本不能改写账本", async () => {
  const ledger = fixture();
  await ledger.grant(actor,{ eventId: "g",grantId: "g",amount: 100,source: "fixture" });
  await ledger.reserve(actor,reservation);
  const outsider = { ...actor,serviceId: "member" };
  await assert.rejects(() => ledger.balance(outsider),{ code: "FORBIDDEN" });
  await assert.rejects(() => ledger.grant(outsider,{ eventId: "g2",grantId: "g2",amount: 100,source: "fixture" }),{ code: "FORBIDDEN" });
  const other = { ...actor,workspaceId: "other" };
  assert.deepEqual(await ledger.entries(other),[]);
  await assert.rejects(() => ledger.task(other,"t"),{ code: "TASK_NOT_FOUND" });
  const entries = await ledger.entries(actor),task = await ledger.task(actor,"t");
  entries.splice(0);
  task.units[0]!.consumed = 999;
  assert.equal((await ledger.entries(actor)).length,2);
  assert.equal((await ledger.task(actor,"t")).units[0]!.consumed,0);
  const closed = new CreditLedgerService({ repository: new InMemoryCreditLedgerRepository(),clock: () => new Date(),
    access: { authorize: async (_a,operation) => operation === "read" } });
  await assert.rejects(() => closed.reserve(actor,reservation),{ code: "FORBIDDEN" });
});
test("请求进入授权等待前固定快照，外部修改不能改变工作室或报价", async () => {
  let enter!: () => void,release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }),gate = new Promise<void>(resolve => { release = resolve; });
  let delay = false;
  const ledger = new CreditLedgerService({ repository: new InMemoryCreditLedgerRepository(),clock: () => new Date("2026-10-07"),
    access: { authorize: async () => { if (delay) { enter(); await gate; } return true; } } });
  await ledger.grant(actor,{ eventId: "g",grantId: "g",amount: 100,source: "fixture" });
  delay = true;
  const mutableActor = { ...actor },command = { ...reservation,units: [{ id: "u",reserved: 60 }] };
  const pending = ledger.reserve(mutableActor,command); await entered;
  mutableActor.workspaceId = "other"; command.units[0]!.reserved = 1;
  release(); await pending; delay = false;
  assert.deepEqual(await ledger.balance(actor),{ available: 40,reserved: 60,consumed: 0,granted: 100 });
  assert.equal((await ledger.task(actor,"t")).snapshot.units[0]!.reserved,60);
});
test("异常授权返回值与不可克隆身份均拒绝，错误不泄露私密输入", async () => {
  const ledger = new CreditLedgerService({ repository: new InMemoryCreditLedgerRepository(),clock: () => new Date(),
    access: { authorize: async () => JSON.parse('"yes"') } });
  await assert.rejects(() => ledger.balance(actor),{ code: "FORBIDDEN",message: "FORBIDDEN" });
  const uncloneable = { ...actor,privateValue: () => "private-input" };
  await assert.rejects(() => fixture().balance(uncloneable),{ code: "FORBIDDEN",message: "FORBIDDEN" });
});
