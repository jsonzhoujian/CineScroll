import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { CreditLedgerService } from "../src/index.ts";
import { PostgresCreditLedgerRepository } from "../src/postgres-ledger.ts";

test("PostgreSQL账本原子结算后可重建服务读取，重复事件不双扣", { skip: !process.env.TEST_BILLING_DATABASE_URL }, async () => {
  const admin = new Pool({ connectionString: process.env.TEST_BILLING_DATABASE_URL });
  let pool = new Pool({ connectionString: process.env.TEST_BILLING_DATABASE_URL,options: "-c role=novel_billing" });
  const actor = { workspaceId: `w_${randomUUID()}`,serviceId: "ledger-fixture" };
  const evidence = { id: "ev",workspaceId: actor.workspaceId,taskId: "t",unitId: "u",sourceVersionId: "s",outcome: "succeeded",amount: 50,resultVersionId: "result",ruleVersion: "r" };
  const service = () => new CreditLedgerService({ repository: new PostgresCreditLedgerRepository(pool),
    access: { authorize: async () => true },clock: () => new Date("2026-10-07"),evidenceReader: { read: async () => evidence } });
  try {
    await admin.query(await readFile(new URL("../migrations/0001_credit_ledger.sql",import.meta.url),"utf8"));
    const ledger = service();
    await ledger.grant(actor,{ eventId: "g",grantId: "g",amount: 100,source: "fixture" });
    await ledger.reserve(actor,{ eventId: "r",taskId: "t",projectId: "p",chapterId: "c",sourceVersionId: "s",quoteId: "q",priceVersion: "v",responsibility: "platform",units: [{ id: "u",reserved: 60 }] });
    const command = { eventId: "settle",taskId: "t",unitId: "u",evidenceId: "ev" };
    const receipt = await ledger.settle(actor,command);
    await pool.end();
    pool = new Pool({ connectionString: process.env.TEST_BILLING_DATABASE_URL,options: "-c role=novel_billing" });
    const restarted = service();
    assert.deepEqual(await restarted.balance(actor),{ available: 50,reserved: 0,consumed: 50,granted: 100 });
    assert.deepEqual(await restarted.settle(actor,command),receipt);
    assert.equal((await restarted.entries(actor)).length,4);
  } finally { await pool.end(); await admin.end(); }
});
test("数据库拒绝删除/改写历史和回退指针，失败提交不改变账本", { skip: !process.env.TEST_BILLING_DATABASE_URL }, async () => {
  const admin = new Pool({ connectionString: process.env.TEST_BILLING_DATABASE_URL });
  const pool = new Pool({ connectionString: process.env.TEST_BILLING_DATABASE_URL,options: "-c role=novel_billing" });
  const actor = { workspaceId: `w_${randomUUID()}`,serviceId: "fixture" },repository = new PostgresCreditLedgerRepository(pool);
  const ledger = new CreditLedgerService({ repository,access: { authorize: async () => true },clock: () => new Date("2026-10-07") });
  try {
    await admin.query(await readFile(new URL("../migrations/0001_credit_ledger.sql",import.meta.url),"utf8"));
    await ledger.grant(actor,{ eventId: "g",grantId: "g",amount: 100,source: "fixture" });
    const corrupt = await repository.read(actor.workspaceId);
    corrupt.revision++;
    corrupt.entries = [{ ...corrupt.entries[0]!,amount: 1000 }];
    corrupt.events.push({ eventId: "bad",fingerprint: "bad",receipt: { eventId: "bad",taskId: null,unitId: null,status: "applied" } });
    await assert.rejects(() => repository.compareAndSwap(actor.workspaceId,1,corrupt),{ code: "STORAGE_UNAVAILABLE" });
    assert.deepEqual(await ledger.balance(actor),{ available: 100,reserved: 0,consumed: 0,granted: 100 });
    assert.equal((await repository.read(actor.workspaceId)).revision,1);
    await assert.rejects(() => pool.query("delete from public.credit_ledger_versions"));
    await assert.rejects(() => pool.query("update public.credit_ledger_versions set state_json='{}'::jsonb"));
    const client = await pool.connect();
    try {
      await client.query("begin"); await client.query("select set_config('app.billing_workspace_id',$1,true)",[actor.workspaceId]);
      await assert.rejects(() => client.query("update public.credit_ledger_heads set active_revision=null where workspace_id=$1",[actor.workspaceId]));
    } finally { await client.query("rollback"); client.release(); }
  } finally { await pool.end(); await admin.end(); }
});
test("两个受限登录连接池共享余额和幂等结算，强制RLS隔离工作室", { skip: !process.env.TEST_BILLING_DATABASE_URL }, async () => {
  const admin = new Pool({ connectionString: process.env.TEST_BILLING_DATABASE_URL });
  const login = `billing_${randomUUID().replaceAll("-","")}`;
  const url = new URL(process.env.TEST_BILLING_DATABASE_URL!); url.username = login; url.password = "";
  const aPool = new Pool({ connectionString: url.toString(),options: "-c role=novel_billing",max: 1 });
  const bPool = new Pool({ connectionString: url.toString(),options: "-c role=novel_billing",max: 1 });
  const actor = { workspaceId: `w_${randomUUID()}`,serviceId: "fixture" };
  const evidence = new Map<string,unknown>();
  const service = (pool: Pool) => new CreditLedgerService({ repository: new PostgresCreditLedgerRepository(pool),
    access: { authorize: async a => a.serviceId === "fixture" },clock: () => new Date("2026-10-07"),
    evidenceReader: { read: async (_a,id) => evidence.get(id) } });
  try {
    await admin.query(await readFile(new URL("../migrations/0001_credit_ledger.sql",import.meta.url),"utf8"));
    await admin.query(`create role ${login} login nosuperuser nocreatedb nocreaterole nobypassrls`);
    await admin.query(`grant novel_billing to ${login}`);
    const a = service(aPool),b = service(bPool);
    await a.grant(actor,{ eventId: "g",grantId: "g",amount: 100,source: "fixture" });
    const reserve = { eventId: "r1",taskId: "t1",projectId: "p",chapterId: "c",sourceVersionId: "s",quoteId: "q",priceVersion: "v",responsibility: "platform" as const,units: [{ id: "u",reserved: 70 }] };
    const results = await Promise.allSettled([a.reserve(actor,reserve),b.reserve(actor,{ ...reserve,eventId: "r2",taskId: "t2" })]);
    assert.equal(results.filter(r => r.status === "fulfilled").length,1);
    const failed = results.find(r => r.status === "rejected")!;
    assert.equal(failed.status === "rejected" && failed.reason.code,"INSUFFICIENT_CREDITS");
    assert.deepEqual(await b.balance(actor),{ available: 30,reserved: 70,consumed: 0,granted: 100 });
    const taskId = results[0]!.status === "fulfilled" ? "t1" : "t2";
    evidence.set("ev",{ id: "ev",workspaceId: actor.workspaceId,taskId,unitId: "u",sourceVersionId: "s",outcome: "succeeded",amount: 50,resultVersionId: "result",ruleVersion: "r" });
    const command = { eventId: "settle",taskId,unitId: "u",evidenceId: "ev" };
    const receipts = await Promise.all([a.settle(actor,command),b.settle(actor,command)]);
    assert.deepEqual(receipts[0],receipts[1]);
    assert.deepEqual(await service(bPool).balance(actor),{ available: 50,reserved: 0,consumed: 50,granted: 100 });
    assert.equal((await b.entries(actor)).length,4);
    const other = { ...actor,workspaceId: `other_${randomUUID()}` };
    assert.deepEqual(await b.entries(other),[]);
    await assert.rejects(() => b.task(other,taskId),{ code: "TASK_NOT_FOUND" });
    const client = await aPool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.billing_workspace_id',$1,true)",[other.workspaceId]);
      assert.equal((await client.query("select * from public.credit_ledger_versions where workspace_id=$1",[actor.workspaceId])).rows.length,0);
      await assert.rejects(() => client.query("insert into public.credit_ledger_heads(workspace_id) values($1)",[`${actor.workspaceId}-forged`]));
    } finally { await client.query("rollback"); client.release(); }
    await assert.rejects(() => aPool.query("delete from public.credit_ledger_heads"));
    await assert.rejects(() => aPool.query("alter table public.credit_ledger_heads disable row level security"));
    assert.equal((await aPool.query("select * from public.credit_ledger_heads")).rows.length,0);
  } finally {
    await Promise.all([aPool.end(),bPool.end()]);
    try { await admin.query(`drop role if exists ${login}`); } finally { await admin.end(); }
  }
});
test("持久化部分结算保留未知冻结，超报价不扣费，BYOK仍零流水", { skip: !process.env.TEST_BILLING_DATABASE_URL }, async () => {
  const admin = new Pool({ connectionString: process.env.TEST_BILLING_DATABASE_URL });
  const pool = new Pool({ connectionString: process.env.TEST_BILLING_DATABASE_URL,options: "-c role=novel_billing" });
  const actor = { workspaceId: `w_${randomUUID()}`,serviceId: "fixture" },evidence = new Map<string,unknown>();
  const repository = new PostgresCreditLedgerRepository(pool);
  const service = () => new CreditLedgerService({ repository,access: { authorize: async () => true },clock: () => new Date("2026-10-07"),
    evidenceReader: { read: async (_a,id) => evidence.get(id) } });
  const reserve = { eventId: "r",taskId: "t",projectId: "p",chapterId: "c",sourceVersionId: "s",quoteId: "q",priceVersion: "v",responsibility: "platform" as const,
    units: [{ id: "a",reserved: 30 },{ id: "b",reserved: 40 },{ id: "c",reserved: 30 }] };
  try {
    await admin.query(await readFile(new URL("../migrations/0001_credit_ledger.sql",import.meta.url),"utf8"));
    const ledger = service();
    await ledger.grant(actor,{ eventId: "g",grantId: "g",amount: 100,source: "fixture" });
    await ledger.reserve(actor,reserve);
    for (const [unitId,outcome,amount] of [["a","succeeded",30],["b","failed",null],["c","unknown",null]] as const) {
      evidence.set(unitId,{ id: unitId,workspaceId: actor.workspaceId,taskId: "t",unitId,sourceVersionId: "s",outcome,amount,resultVersionId: outcome === "succeeded" ? "result" : null,ruleVersion: "r" });
      await ledger.settle(actor,{ eventId: `ev-${unitId}`,taskId: "t",unitId,evidenceId: unitId });
    }
    assert.deepEqual(await service().balance(actor),{ available: 40,reserved: 30,consumed: 30,granted: 100 });
    evidence.set("over",{ id: "over",workspaceId: actor.workspaceId,taskId: "t",unitId: "c",sourceVersionId: "s",outcome: "succeeded",amount: 31,resultVersionId: "result",ruleVersion: "r" });
    assert.equal((await ledger.settle(actor,{ eventId: "over",taskId: "t",unitId: "c",evidenceId: "over" })).reason,"QUOTE_EXCEEDED");
    assert.equal((await service().task(actor,"t")).units.find(u => u.id === "c")!.state,"reconciling");
    const previousEntries = await ledger.entries(actor);
    await ledger.reserve(actor,{ ...reserve,eventId: "byok",taskId: "byok",responsibility: "byok",units: [{ id: "u",reserved: 0 }] });
    assert.equal((await service().task(actor,"byok")).units[0]!.state,"exempt");
    assert.deepEqual(await ledger.entries(actor),previousEntries);
    evidence.set("later",{ id: "later",workspaceId: actor.workspaceId,taskId: "t",unitId: "c",sourceVersionId: "s",outcome: "failed",amount: null,resultVersionId: null,ruleVersion: "r" });
    await ledger.settle(actor,{ eventId: "later",taskId: "t",unitId: "c",evidenceId: "later" });
    assert.deepEqual(await service().balance(actor),{ available: 70,reserved: 0,consumed: 30,granted: 100 });
  } finally { await pool.end(); await admin.end(); }
});
test("SQL拒绝新增或现有单元的小数、非法初始状态和报价错配", { skip: !process.env.TEST_BILLING_DATABASE_URL }, async () => {
  const admin = new Pool({ connectionString: process.env.TEST_BILLING_DATABASE_URL });
  const pool = new Pool({ connectionString: process.env.TEST_BILLING_DATABASE_URL,options: "-c role=novel_billing" });
  const actor = { workspaceId: `w_${randomUUID()}`,serviceId: "fixture" },repository = new PostgresCreditLedgerRepository(pool);
  const ledger = new CreditLedgerService({ repository,access: { authorize: async () => true },clock: () => new Date("2026-10-07") });
  try {
    await admin.query(await readFile(new URL("../migrations/0001_credit_ledger.sql",import.meta.url),"utf8"));
    await ledger.grant(actor,{ eventId: "g",grantId: "g",amount: 100,source: "fixture" });
    const snapshot = { eventId: "r",taskId: "t",projectId: "p",chapterId: "c",sourceVersionId: "s",quoteId: "q",priceVersion: "v",responsibility: "platform" as const,units: [{ id: "u",reserved: 60 }] };
    for (const unit of [
      { id: "u",reserved: 60,consumed: 0.5,released: 0,state: "reserved" as const },
      { id: "u",reserved: 60,consumed: 0,released: 0,state: "exempt" as const },
      { id: "u",reserved: 61,consumed: 0,released: 0,state: "reserved" as const },
    ]) {
      const next = await repository.read(actor.workspaceId); next.revision++;
      next.tasks.push({ snapshot,units: [unit] });
      next.entries.push({ workspaceId: actor.workspaceId,eventId: "r",operation: "reserve",amount: 60,taskId: "t",unitId: "u",grantId: null,evidenceId: null,serviceId: "fixture",createdAt: "2026-10-07" });
      next.events.push({ eventId: "r",fingerprint: "r",receipt: { eventId: "r",taskId: "t",unitId: null,status: "applied" } });
      await assert.rejects(() => repository.compareAndSwap(actor.workspaceId,1,next),{ code: "STORAGE_UNAVAILABLE" });
    }
    await ledger.reserve(actor,snapshot);
    const next = await repository.read(actor.workspaceId); next.revision++;
    next.tasks[0]!.units[0]!.consumed = 0.5;
    next.events.push({ eventId: "bad",fingerprint: "bad",receipt: { eventId: "bad",taskId: "t",unitId: "u",status: "reconciling" } });
    await assert.rejects(() => repository.compareAndSwap(actor.workspaceId,2,next),{ code: "STORAGE_UNAVAILABLE" });
    assert.deepEqual(await ledger.balance(actor),{ available: 40,reserved: 60,consumed: 0,granted: 100 });
  } finally { await pool.end(); await admin.end(); }
});
