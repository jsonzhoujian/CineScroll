import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresEvidenceMaterialRepository } from "../src/postgres-evidence.ts";
import { createVerifiedSettlementEvidenceReader } from "../src/verified-evidence.ts";

test("证据数据库连接错误净化且不泄露内部信息", async () => {
  const repository = new PostgresEvidenceMaterialRepository({ connect: async () => { throw new Error("secret"); } });
  await assert.rejects(() => repository.get("studio", "evidence"), { message: "STORAGE_UNAVAILABLE" });
});

test("受限PG证据仓储持久化、并发幂等、补证回滚及RLS投影", { skip: !process.env.TEST_EVIDENCE_DATABASE_URL }, async () => {
  const admin = new Pool({ connectionString: process.env.TEST_EVIDENCE_DATABASE_URL });
  const suffix = randomUUID().replaceAll("-", ""), login = `evidence_${suffix}`, workspace = `studio_${suffix}`;
  const url = new URL(process.env.TEST_EVIDENCE_DATABASE_URL!); url.username = login; url.password = "";
  let pool = new Pool({ connectionString: url.toString(), options: "-c role=novel_evidence" });
  const second = new Pool({ connectionString: url.toString(), options: "-c role=novel_evidence" });
  const binding = { workspaceId: workspace, taskId: "task", unitId: "unit", projectId: "project", chapterId: "chapter", sourceVersionId: "source", upstreamVersionIds: [] };
  const data = { id: "evidence", formatVersion: 1, binding, ruleVersion: "v1", snapshot: { binding, responsibility: "platform", quoteId: "quote", priceVersion: "price", reserved: 60 },
    execution: { binding, id: "execution", state: "unknown", closed: false }, results: [], pricing: null };
  try {
    await admin.query(await readFile(new URL("../migrations/0002_evidence_material.sql", import.meta.url), "utf8"));
    await admin.query(`create role ${login} login nosuperuser nocreatedb nocreaterole nobypassrls`);
    await admin.query(`grant novel_evidence to ${login}`);
    const repository = new PostgresEvidenceMaterialRepository(pool), other = new PostgresEvidenceMaterialRepository(second);
    const [first, duplicate] = await Promise.all([repository.append(workspace, data), other.append(workspace, data)]);
    assert.deepEqual(first, duplicate);
    await assert.rejects(() => other.append(workspace, { ...data, ruleVersion: "changed" }), { code: "CONFLICT" });
    await assert.rejects(() => repository.append(workspace, { ...data, id: "bad" }, "missing"), { code: "PREDECESSOR_NOT_FOUND" });
    assert.equal(await repository.read(workspace, "bad"), null);
    await repository.append(workspace, { ...data, id: "next" }, "evidence");
    assert.equal((await repository.get(workspace, "next"))!.predecessorId, "evidence");
    await assert.rejects(() => repository.append(workspace, { ...data, id: "mismatch", snapshot: { ...data.snapshot, quoteId: "other" } }, "evidence"), { code: "CONFLICT" });
    assert.equal(await repository.read(workspace, "mismatch"), null);
    await pool.end(); pool = new Pool({ connectionString: url.toString(), options: "-c role=novel_evidence" });
    const restarted = new PostgresEvidenceMaterialRepository(pool);
    assert.deepEqual(await restarted.get(workspace, "evidence"), first);
    assert.equal(await restarted.read("other", "evidence"), null);
    const reader = createVerifiedSettlementEvidenceReader({ source: restarted, access: { authorize: async () => true } });
    assert.equal((await reader.read({ workspaceId: workspace, serviceId: "fixture" }, "evidence") as { outcome: string }).outcome, "unknown");
    await assert.rejects(() => pool.query("update public.evidence_material set fingerprint='bad'"));
    await assert.rejects(() => pool.query("delete from public.evidence_material"));
    await assert.rejects(() => pool.query("truncate public.evidence_material"));
    const client = await pool.connect();
    try {
      await client.query("begin"); await client.query("select set_config('app.evidence_workspace_id',$1,true)", ["other"]);
      assert.equal((await client.query("select * from public.evidence_material where workspace_id=$1", [workspace])).rows.length, 0);
      await assert.rejects(() => client.query("insert into public.evidence_material(workspace_id,evidence_id,material,fingerprint) values($1,$2,$3,$4)", [workspace, "rls", JSON.stringify(data), first.fingerprint]));
    } finally { await client.query("rollback"); client.release(); }
    // Isolated admin temporarily grants writes to prove the trigger is a second defense.
    await admin.query("grant update,delete on public.evidence_material to novel_evidence");
    try {
      for (const sql of ["update public.evidence_material set fingerprint=repeat('a',64) where workspace_id=$1", "delete from public.evidence_material where workspace_id=$1"]) {
        const connection = await pool.connect();
        try {
          await connection.query("begin"); await connection.query("select set_config('app.evidence_workspace_id',$1,true)", [workspace]);
          await assert.rejects(() => connection.query(sql, [workspace]), { code: "P0001" });
        } finally { await connection.query("rollback"); connection.release(); }
      }
    } finally { await admin.query("revoke update,delete on public.evidence_material from novel_evidence"); }
    assert.deepEqual(await restarted.get(workspace, "evidence"), first);
  } finally { await pool.end(); await second.end(); await admin.query(`drop role if exists ${login}`); await admin.end(); }
});
