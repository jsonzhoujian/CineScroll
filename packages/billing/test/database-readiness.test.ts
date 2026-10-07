import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { assertCreditLedgerDatabase, createCheckedCreditLedgerRepository } from "../src/database-readiness.ts";
import { createServerCreditLedger } from "../src/server-assembly.ts";

test("账本初始化连接故障拒绝且不泄露数据库信息", async () => {
  const pool = { connect: async () => { throw new Error("private-connection-secret"); } };
  await assert.rejects(() => createCheckedCreditLedgerRepository(pool),{ message: "BILLING_DATABASE_NOT_READY" });
});

test("账本只读预检放行健康受限登录并拒绝迁移/权限漂移，不自行修复", {
  skip: !process.env.TEST_BILLING_READINESS_DATABASE_URL,
}, async () => {
  const admin = new Pool({ connectionString: process.env.TEST_BILLING_READINESS_DATABASE_URL });
  const suffix = randomUUID().replaceAll("-",""),login = `ready_${suffix}`,extra = `extra_${suffix}`;
  const url = new URL(process.env.TEST_BILLING_READINESS_DATABASE_URL!); url.username = login; url.password = "";
  const pool = new Pool({ connectionString: url.toString(),options: "-c role=novel_billing",max: 1 });
  const migration = await readFile(new URL("../migrations/0001_credit_ledger.sql",import.meta.url),"utf8");
  try {
    await admin.query(migration);
    await admin.query(`create role ${login} login nosuperuser nocreatedb nocreaterole nobypassrls`);
    await admin.query(`grant novel_billing to ${login}`);
    await admin.query(`create role ${extra} nologin`);
    const repository = await createCheckedCreditLedgerRepository(pool);
    assert.deepEqual(await repository.read(`unused_${suffix}`),{ revision: 0,entries: [],tasks: [],events: [],evidence: [] });
    const workspace = `assembly_${suffix}`;
    const policy = { serviceId: "assembly", grants: [{ workspaceId: workspace, operations: ["read", "grant", "reserve", "settle"] as const }] };
    const evidenceReader = { read: async () => ({ id: "evidence", workspaceId: workspace, taskId: "task", unitId: "unit", sourceVersionId: "source",
      outcome: "succeeded", amount: 50, resultVersionId: "result", ruleVersion: "v1" }) };
    const hostPool = { connect: async () => {
      policy.serviceId = "changed"; policy.grants[0]!.workspaceId = "changed";
      hostPool.connect = async () => { throw new Error("changed-pool"); };
      evidenceReader.read = async () => { throw new Error("changed-evidence"); };
      return pool.connect();
    } };
    const ledger = await createServerCreditLedger({
      pool: hostPool,
      policy, evidenceReader, clock: () => new Date("2026-10-07T00:00:00Z"),
    });
    const grant = { eventId: "g1", grantId: "g", amount: 100, source: "fixture" };
    await ledger.grant(workspace, grant);
    await ledger.grant(workspace, grant);
    await ledger.reserve(workspace, { eventId: "r1", taskId: "task", projectId: "project", chapterId: "chapter", sourceVersionId: "source",
      quoteId: "quote", priceVersion: "v1", responsibility: "platform", units: [{ id: "unit", reserved: 60 }] });
    assert.deepEqual(await ledger.balance(workspace), { available: 40, reserved: 60, consumed: 0, granted: 100 });
    assert.equal((await ledger.task(workspace, "task")).units[0]!.state, "reserved");
    assert.deepEqual((await ledger.entries(workspace)).map(entry => entry.serviceId), ["assembly", "assembly"]);
    await assert.rejects(() => ledger.grant("changed", grant), { code: "FORBIDDEN" });
    await assert.rejects(() => ledger.settle("changed", { eventId: "s1", taskId: "task", unitId: "unit", evidenceId: "evidence" }), { code: "FORBIDDEN" });
    assert.deepEqual(await ledger.balance(workspace), { available: 40, reserved: 60, consumed: 0, granted: 100 });
    await ledger.settle(workspace, { eventId: "s1", taskId: "task", unitId: "unit", evidenceId: "evidence" });
    assert.deepEqual(await ledger.balance(workspace), { available: 50, reserved: 0, consumed: 50, granted: 100 });
    assert.equal(Object.isFrozen(ledger), true);
    await assert.rejects(() => assertCreditLedgerDatabase(admin),{ message: "BILLING_DATABASE_NOT_READY" });
    const broken = async (change: string,restore: string) => {
      await admin.query(change);
      try {
        await assert.rejects(() => createCheckedCreditLedgerRepository(pool),{ message: "BILLING_DATABASE_NOT_READY" });
        await assert.rejects(() => assertCreditLedgerDatabase(pool),{ message: "BILLING_DATABASE_NOT_READY" });
      } finally { await admin.query(restore); }
      await assertCreditLedgerDatabase(pool);
    };
    await broken("alter table public.credit_ledger_heads rename to readiness_missing_heads","alter table public.readiness_missing_heads rename to credit_ledger_heads");
    await broken("alter table public.credit_ledger_heads no force row level security","alter table public.credit_ledger_heads force row level security");
    await broken("alter table public.credit_ledger_versions drop constraint credit_ledger_versions_revision_check; alter table public.credit_ledger_versions add constraint credit_ledger_versions_revision_check check(revision>0)","alter table public.credit_ledger_versions drop constraint credit_ledger_versions_revision_check; alter table public.credit_ledger_versions add constraint credit_ledger_versions_revision_check check(revision>=1 and revision<=9007199254740991)");
    await broken("alter table public.credit_ledger_heads disable trigger credit_ledger_head_transition","alter table public.credit_ledger_heads enable trigger credit_ledger_head_transition");
    await broken("grant update(state_json) on public.credit_ledger_versions to novel_billing","revoke update(state_json) on public.credit_ledger_versions from novel_billing");
    await broken(`grant ${extra} to ${login}`,`revoke ${extra} from ${login}`);
    await broken("alter policy credit_ledger_heads_scope on public.credit_ledger_heads using(true) with check(true)",migration);
    await broken("create or replace function public.guard_credit_ledger_head() returns trigger language plpgsql as $$ begin return new; end $$",migration);
    await broken("alter table public.credit_ledger_versions drop constraint credit_ledger_versions_pkey","alter table public.credit_ledger_versions add constraint credit_ledger_versions_pkey primary key(workspace_id,revision)");
  } finally {
    await pool.end();
    try { await admin.query(`drop role if exists ${login}`); await admin.query(`drop role if exists ${extra}`); }
    finally { await admin.end(); }
  }
});
