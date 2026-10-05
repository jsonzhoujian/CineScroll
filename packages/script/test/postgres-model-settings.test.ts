import assert from "node:assert/strict";
import test from "node:test";
import { PostgresModelSettingsRepository, type ModelSettingsPool } from "../src/postgres-model-settings.ts";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { ModelConfiguration } from "../src/model-settings.ts";

const config: ModelConfiguration = { id: "v", parentVersionId: null, workspaceId: "w", providerId: "deepseek", ciphertext: "encrypted", nonce: "nonce", tag: "tag", createdBy: "owner", tested: false, availableModelIds: [], processingRegion: "unknown" };

test("配置父版本不匹配在数据库调用前拒绝", async () => {
  const pool: ModelSettingsPool = { connect: async () => { throw new Error("must not connect"); } };
  const repository = new PostgresModelSettingsRepository(pool);
  await assert.rejects(() => repository.save({ id: "v", parentVersionId: "wrong", workspaceId: "w", providerId: "deepseek", ciphertext: "encrypted", nonce: "nonce", tag: "tag", createdBy: "owner", tested: false, availableModelIds: [], processingRegion: "unknown" }, null), { code: "INVALID_CONFIGURATION" });
});

test("数据库故障回滚并释放连接，错误不泄露配置密文", async () => {
  let released = false; let rolledBack = false;
  const repository = new PostgresModelSettingsRepository({ connect: async () => ({
    query: async (sql) => {
      if (sql === "rollback") { rolledBack = true; return { rows: [] }; }
      if (sql.startsWith("insert into model_settings_heads")) throw new Error("encrypted-secret");
      return { rows: [] };
    }, release: () => { released = true; },
  }) });
  await assert.rejects(() => repository.save(config, null), { code: "STORAGE_UNAVAILABLE", message: "STORAGE_UNAVAILABLE" });
  assert.equal(released, true); assert.equal(rolledBack, true);
});

test("PostgreSQL 配置重启可读、并发CAS与审计原子性及租户隔离", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  // Reuse the existing project's installed pg driver only in the opt-in database harness.
  const { Pool } = createRequire(new URL("../../project-import/package.json", import.meta.url))("pg");
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
  const appPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4, options: "-c role=novel_app" });
  const workspaceId = `model_test_${crypto.randomUUID()}`;
  try {
    await pool.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname='novel_app') then create role novel_app nologin; end if;
      exception when duplicate_object then null;
    end $$`);
    await pool.query(await readFile(new URL("../migrations/0001_model_settings.sql", import.meta.url), "utf8"));
    const scoped = { ...config, workspaceId };
    const repository = new PostgresModelSettingsRepository(appPool);
    await repository.save(scoped, null);
    assert.deepEqual(await new PostgresModelSettingsRepository(appPool).find(workspaceId), scoped);
    assert.equal(await repository.find(`${workspaceId}_other`), null);
    const outcomes = await Promise.allSettled([repository.save({ ...scoped, id: "v2", parentVersionId: "v" }, "v"), repository.save({ ...scoped, id: "v3", parentVersionId: "v" }, "v")]);
    assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
    const active = await repository.find(workspaceId); assert.ok(active);
    // A reused version ID must roll back without changing the active head/audit.
    await assert.rejects(() => repository.save({ ...scoped, id: "v", parentVersionId: active.id }, active.id), { code: "VERSION_CONFLICT" });
    assert.deepEqual(await repository.find(workspaceId), active);
    const audit = await pool.query("select actor_id,operation from model_settings_audit where workspace_id=$1", [workspaceId]);
    assert.equal(audit.rows.length, 2);
    // Non-owner database role cannot bypass the workspace RLS context.
    const client = await pool.connect();
    try {
      await client.query("begin"); await client.query("set local role novel_app");
      await client.query("select set_config('app.model_workspace_id',$1,true)", [`${workspaceId}_other`]);
      const rows = await client.query("select * from model_settings_versions where workspace_id=$1", [workspaceId]); assert.equal(rows.rows.length, 0);
      await client.query("rollback");
      for (const table of ["model_settings_versions", "model_settings_audit"]) {
        await client.query("begin");
        await client.query("select set_config('app.model_workspace_id',$1,true)", [workspaceId]);
        await assert.rejects(() => client.query(`delete from ${table} where workspace_id=$1`, [workspaceId]));
        await client.query("rollback");
      }
    } finally { client.release(); }
  } finally { await appPool.end(); await pool.end(); }
});
