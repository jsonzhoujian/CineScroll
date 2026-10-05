import assert from "node:assert/strict";
import test from "node:test";
import { PostgresWorkspaceModelAccess } from "../src/workspace-model-access.ts";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { WorkspaceModelSettings, InMemoryModelSettingsRepository } from "../src/model-settings.ts";

test("工作室权限读取无权威记录时拒绝，数据库故障不泄露细节", async () => {
  const access = new PostgresWorkspaceModelAccess({ connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) });
  assert.equal(await access.read({ userId: "u", workspaceId: "w" }), null);
  const unavailable = new PostgresWorkspaceModelAccess({ connect: async () => { throw new Error("private-database-url"); } });
  await assert.rejects(() => unavailable.read({ userId: "u", workspaceId: "w" }), { code: "STORAGE_UNAVAILABLE", message: "STORAGE_UNAVAILABLE" });
});

test("PostgreSQL 权威成员、到期订阅与撤销控制共享Key权限，应用不可自提权", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const { Pool } = createRequire(new URL("../../project-import/package.json", import.meta.url))("pg");
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const app = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: "-c role=novel_app" });
  const workspaceId = `access_${randomUUID()}`;
  try {
    await admin.query(`do $$ begin if not exists(select 1 from pg_roles where rolname='novel_app') then create role novel_app nologin; end if; exception when duplicate_object then null; end $$`);
    await admin.query(await readFile(new URL("../migrations/0002_workspace_model_access.sql", import.meta.url), "utf8"));
    await admin.query("insert into workspace_model_members(workspace_id,user_id,role) values($1,'owner','owner'),($1,'editor','editor')", [workspaceId]);
    const access = new PostgresWorkspaceModelAccess(app);
    const owner = { workspaceId, userId: "owner" }; const editor = { workspaceId, userId: "editor" };
    assert.deepEqual(await access.read(owner), { owner: true, advanced: false });
    await admin.query("insert into workspace_model_entitlements(workspace_id,plan,enabled,starts_at,expires_at) values($1,'advanced',true,now()-interval '1 hour',now()+interval '1 hour')", [workspaceId]);
    assert.deepEqual(await access.read(owner), { owner: true, advanced: true });
    assert.deepEqual(await access.read(editor), { owner: false, advanced: true });
    await admin.query("update workspace_model_entitlements set enabled=false where workspace_id=$1", [workspaceId]);
    assert.deepEqual(await access.read(owner), { owner: true, advanced: false });
    await admin.query("update workspace_model_entitlements set enabled=true,plan='studio' where workspace_id=$1", [workspaceId]);
    assert.deepEqual(await access.read(owner), { owner: true, advanced: false });
    await admin.query("update workspace_model_entitlements set plan='advanced' where workspace_id=$1", [workspaceId]);
    await admin.query("insert into workspace_model_members(workspace_id,user_id,role) values($1,'reviewer','reviewer')", [workspaceId]);
    assert.deepEqual(await access.read({ workspaceId, userId: "reviewer" }), { owner: false, advanced: true });
    assert.equal(await access.read({ workspaceId, userId: "outsider" }), null);
    assert.equal(await access.read({ workspaceId: `${workspaceId}_other`, userId: "owner" }), null);
    let id = 0;
    const settings = new WorkspaceModelSettings({ access, repository: new InMemoryModelSettingsRepository(), encryptionKey: new Uint8Array(32).fill(1), idGenerator: () => `v${++id}` });
    await settings.configure(owner, { expectedVersionId: null, providerId: "deepseek", apiKey: "fixture-key" });
    assert.ok(await settings.get(editor));
    await assert.rejects(() => settings.configure(editor, { expectedVersionId: "v1", providerId: "deepseek", apiKey: "key" }), { code: "FORBIDDEN" });
    await admin.query("update workspace_model_entitlements set starts_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' where workspace_id=$1", [workspaceId]);
    assert.deepEqual(await access.read(owner), { owner: true, advanced: false });
    await assert.rejects(() => settings.get(owner), { code: "FORBIDDEN" });
    await admin.query("update workspace_model_entitlements set starts_at=now()+interval '1 hour',expires_at=now()+interval '2 hours' where workspace_id=$1", [workspaceId]);
    assert.deepEqual(await access.read(owner), { owner: true, advanced: false });
    await admin.query("update workspace_model_members set active=false where workspace_id=$1 and user_id='owner'", [workspaceId]);
    assert.equal(await access.read(owner), null);
    await assert.rejects(() => app.query("update workspace_model_entitlements set enabled=true where workspace_id=$1", [workspaceId]));
    await assert.rejects(() => app.query("insert into workspace_model_members(workspace_id,user_id,role) values($1,'attacker','owner')", [workspaceId]));
    await assert.rejects(() => app.query("delete from workspace_model_members where workspace_id=$1", [workspaceId]));
  } finally { await app.end(); await admin.end(); }
});
