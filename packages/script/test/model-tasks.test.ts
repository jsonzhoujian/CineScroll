import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { WorkspaceModelSettings, InMemoryModelSettingsRepository } from "../src/model-settings.ts";
import { ModelTaskService, InMemoryModelTaskRepository, type ModelTaskRepository } from "../src/model-tasks.ts";
import { PostgresModelTaskRepository } from "../src/postgres-model-tasks.ts";

async function exercise(repository: ModelTaskRepository) {
  let version = 0, job = 0, calls = 0;
  const actor = { userId: "u", workspaceId: randomUUID() };
  const settings = new WorkspaceModelSettings({ repository: new InMemoryModelSettingsRepository(), encryptionKey: new Uint8Array(32).fill(7),
    access: { read: async () => ({ owner: true, advanced: true }) }, idGenerator: () => `v${++version}`,
    probe: { processingRegion: () => "mainland", test: async () => ({ modelIds: ["m"], processingRegion: "mainland" }) } });
  const config = await settings.configure(actor, { expectedVersionId: null, providerId: "deepseek", apiKey: "fixture-old-key" });
  const tested = await settings.testConnection(actor, config.id);
  let context = { stage: "script" as const, sourceVersionId: "source1", upstreamConfirmedVersionIds: ["knowledge1", "plan1"],
    generationParameters: { targetDurationSeconds: 180 as const, aspectRatio: "9:16" as const, narrativeMode: "narration" as const } };
  const service = new ModelTaskService({ settings, repository, contextReader: { read: async () => structuredClone(context) }, idGenerator: () => `job${++job}` });
  const original = await service.submit(actor, { projectId: "p", chapterId: "c", configurationVersionId: tested.id, modelId: "m" });
  await assert.rejects(async () => repository.transition(actor.workspaceId, original.id, 0, "paused", null), { code: "STATE_CONFLICT" });
  const changed = await settings.configure(actor, { expectedVersionId: tested.id, providerId: "deepseek", apiKey: "fixture-new-key" });
  const newTested = await settings.testConnection(actor, changed.id);
  const invoke = async () => { calls++; };
  const paused = await service.run(actor, original.id, invoke);
  assert.equal(paused.state, "paused"); assert.equal(paused.reason, "VERSION_CONFLICT"); assert.equal(calls, 0);
  const replacement = await service.resubmit(actor, original.id, { configurationVersionId: newTested.id, modelId: "m" });
  assert.deepEqual(replacement.input, original.input); assert.equal(replacement.parentTaskId, original.id);
  assert.equal(replacement.model.configurationVersionId, newTested.id);
  await assert.rejects(() => service.resubmit(actor, original.id, { configurationVersionId: newTested.id, modelId: "m" }), { code: "STATE_CONFLICT" });
  assert.ok(!JSON.stringify(replacement).includes("fixture-new-key"));
  assert.equal((await service.get(actor, original.id)).state, "paused");
  const runs = await Promise.allSettled([service.run(actor, replacement.id, invoke), service.run(actor, replacement.id, invoke)]);
  assert.equal(runs.filter(r => r.status === "fulfilled").length, 1); assert.equal(calls, 1);
  context = { ...context, sourceVersionId: "source2" };
  await assert.rejects(() => service.resubmit(actor, original.id, { configurationVersionId: newTested.id, modelId: "m" }), { code: "UPSTREAM_CHANGED" });
  await assert.rejects(() => service.get({ ...actor, workspaceId: "other" }, original.id), { code: "TASK_NOT_FOUND" });
  return original;
}

test("旧Key任务暂停，新任务保留原输入；上游变化拒绝重新提交", async () => { await exercise(new InMemoryModelTaskRepository()); });

test("PostgreSQL任务持久化、暂停重提交与并发执行遵守相同契约", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const { Pool } = createRequire(new URL("../../project-import/package.json", import.meta.url))("pg");
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const app = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: "-c role=novel_app" });
  try {
    await admin.query("do $$ begin if not exists(select 1 from pg_roles where rolname='novel_app') then create role novel_app nologin; end if; exception when duplicate_object then null; end $$");
    await admin.query(await readFile(new URL("../migrations/0003_model_tasks.sql", import.meta.url), "utf8"));
    const original = await exercise(new PostgresModelTaskRepository(app));
    const { state, revision, reason, ...payload } = original;
    const constraintId = randomUUID();
    await admin.query("insert into model_tasks(workspace_id,id,payload,state,revision) values($1,$2,$3::jsonb,'queued',0)", [original.workspaceId, constraintId, JSON.stringify({ ...payload, id: constraintId, parentTaskId: null })]);
    await admin.query("update model_tasks set state='running',revision=1 where workspace_id=$1 and id=$2", [original.workspaceId, constraintId]);
    await assert.rejects(() => admin.query("update model_tasks set state='paused',reason=null,revision=2 where workspace_id=$1 and id=$2", [original.workspaceId, constraintId]), { code: "23514" });
    await assert.rejects(() => app.query("delete from model_tasks"));
    await assert.rejects(() => app.query("update model_tasks set payload='{}'::jsonb"));
  } finally { await app.end(); await admin.end(); }
});
