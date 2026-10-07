import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { assertEvidenceMaterialDatabase, createCheckedEvidenceMaterialRepository } from "../src/evidence-database-readiness.ts";
import { createServerSettlementEvidenceReader } from "../src/evidence-reader-assembly.ts";

test("证据数据库初始化故障脱敏且不返回仓储", async () => {
  await assert.rejects(() => createCheckedEvidenceMaterialRepository({ connect: async () => { throw new Error("private-secret"); } }), { message: "EVIDENCE_DATABASE_NOT_READY" });
});

test("证据只读预检放行受限登录并拒绝漂移且不自行修复", { skip: !process.env.TEST_EVIDENCE_READINESS_DATABASE_URL }, async () => {
  const admin = new Pool({ connectionString: process.env.TEST_EVIDENCE_READINESS_DATABASE_URL });
  const suffix = randomUUID().replaceAll("-", ""), login = `eready_${suffix}`, extra = `extra_${suffix}`;
  const url = new URL(process.env.TEST_EVIDENCE_READINESS_DATABASE_URL!); url.username = login; url.password = "";
  const pool = new Pool({ connectionString: url.toString(), options: "-c role=novel_evidence", max: 1 });
  const migration = await readFile(new URL("../migrations/0002_evidence_material.sql", import.meta.url), "utf8");
  try {
    await admin.query(migration);
    await admin.query(`create role ${login} login nosuperuser nocreatedb nocreaterole nobypassrls`);
    await admin.query(`grant novel_evidence to ${login}`); await admin.query(`create role ${extra} nologin`);
    const hostPool = { connect: async () => {
      hostPool.connect = async () => { throw new Error("changed-connection"); };
      return pool.connect();
    } };
    const repository = await createCheckedEvidenceMaterialRepository(hostPool);
    assert.equal(await repository.read(`unused_${suffix}`, "evidence"), null);
    const workspace = `assembly_${suffix}`;
    const binding = { workspaceId: workspace, taskId: "task", unitId: "unit", projectId: "project", chapterId: "chapter", sourceVersionId: "source", upstreamVersionIds: [] };
    await repository.append(workspace, { id: "evidence", formatVersion: 1, binding, ruleVersion: "v1",
      snapshot: { binding, responsibility: "platform", quoteId: "quote", priceVersion: "price", reserved: 60 },
      execution: { binding, id: "execution", state: "unknown", closed: false }, results: [], pricing: null });
    const policy = { serviceId: "reader", grants: [{ workspaceId: workspace, operations: ["settle"] as const }] };
    const readerPool = { connect: async () => {
      policy.serviceId = "changed"; policy.grants[0]!.workspaceId = "changed";
      readerPool.connect = async () => { throw new Error("changed-pool"); };
      return pool.connect();
    } };
    const service = await createServerSettlementEvidenceReader({ pool: readerPool, policy });
    const expected = { id: "evidence", workspaceId: workspace, taskId: "task", unitId: "unit", sourceVersionId: "source", outcome: "unknown", amount: null, resultVersionId: null, ruleVersion: "v1" };
    assert.deepEqual(await service.read(workspace, "evidence"), expected);
    const result = await service.read(workspace, "evidence") as { ruleVersion: string };
    result.ruleVersion = "tampered";
    assert.deepEqual(await service.read(workspace, "evidence"), expected);
    await assert.rejects(() => service.read("changed", "evidence"), { code: "FORBIDDEN" });
    await assert.rejects(() => service.read(workspace, "missing"), { code: "NOT_FOUND" });
    assert.deepEqual(Object.keys(service), ["read"]); assert.equal(Object.isFrozen(service), true);
    const readOnlyPolicy = { serviceId: "reader", grants: [{ workspaceId: workspace, operations: ["read"] as const }] };
    const unauthorized = await createServerSettlementEvidenceReader({ pool, policy: readOnlyPolicy });
    await assert.rejects(() => unauthorized.read(workspace, "evidence"), { code: "FORBIDDEN" });
    await assert.rejects(() => assertEvidenceMaterialDatabase(admin), { message: "EVIDENCE_DATABASE_NOT_READY" });
    const broken = async (change: string, restore: string) => {
      await admin.query(change);
      try {
        await assert.rejects(() => createCheckedEvidenceMaterialRepository(pool), { message: "EVIDENCE_DATABASE_NOT_READY" });
        await assert.rejects(() => assertEvidenceMaterialDatabase(pool), { message: "EVIDENCE_DATABASE_NOT_READY" });
      } finally { await admin.query(restore); }
      await assertEvidenceMaterialDatabase(pool);
    };
    await broken("alter table public.evidence_material rename to readiness_missing_evidence", "alter table public.readiness_missing_evidence rename to evidence_material");
    await broken("alter table public.evidence_material no force row level security", "alter table public.evidence_material force row level security");
    await broken("alter table public.evidence_material disable trigger evidence_material_guard", "alter table public.evidence_material enable trigger evidence_material_guard");
    await broken("grant update(material) on public.evidence_material to novel_evidence", "revoke update(material) on public.evidence_material from novel_evidence");
    await broken(`grant update(material) on public.evidence_material to ${login}`, `revoke update(material) on public.evidence_material from ${login}`);
    await broken(`grant ${extra} to ${login}`, `revoke ${extra} from ${login}`);
    await broken(`alter role ${login} bypassrls`, `alter role ${login} nobypassrls`);
    await broken(`grant create on schema public to ${login}`, `revoke create on schema public from ${login}`);
    await broken("create policy evidence_extra on public.evidence_material to novel_evidence using(true)", "drop policy evidence_extra on public.evidence_material");
    await broken("alter policy evidence_material_scope on public.evidence_material using(true) with check(true)", migration);
    await broken("create or replace function public.guard_evidence_material() returns trigger language plpgsql set search_path=pg_catalog as $$ begin return new; end $$", migration);
    await broken("alter function public.guard_evidence_material() set search_path=public", "alter function public.guard_evidence_material() set search_path=pg_catalog");
    await broken("alter index public.evidence_material_pkey rename to readiness_missing_evidence_index", "alter index public.readiness_missing_evidence_index rename to evidence_material_pkey");
    await broken("alter table public.evidence_material drop constraint evidence_material_fingerprint_check; alter table public.evidence_material add constraint evidence_material_fingerprint_check check(length(fingerprint)>0)", "alter table public.evidence_material drop constraint evidence_material_fingerprint_check; alter table public.evidence_material add constraint evidence_material_fingerprint_check check(fingerprint ~ '^[a-f0-9]{64}$')");
    await broken("alter table public.evidence_material drop constraint evidence_material_workspace_id_predecessor_id_fkey", "alter table public.evidence_material add constraint evidence_material_workspace_id_predecessor_id_fkey foreign key(workspace_id,predecessor_id) references public.evidence_material(workspace_id,evidence_id)");
    await broken("alter table public.evidence_material add column unexpected text", "alter table public.evidence_material drop column unexpected");
  } finally { await pool.end(); try { await admin.query(`drop role if exists ${login}`); await admin.query(`drop role if exists ${extra}`); } finally { await admin.end(); } }
});
