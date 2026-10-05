import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { WorkspaceModelSettings, InMemoryModelSettingsRepository } from "../src/model-settings.ts";
import { ModelTaskService, InMemoryModelTaskRepository, TaskExecutionError, type ModelTaskRepository } from "../src/model-tasks.ts";
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
  const invoke = async () => { calls++; return { candidateVersionId: "candidate1", extractionStatus: "partially_succeeded" as const }; };
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
  assert.deepEqual((await service.get(actor, replacement.id)).result, { candidateVersionId: "candidate1", extractionStatus: "partially_succeeded" });
  for (const code of ["INVALID_RESPONSE", "CANDIDATE_EXISTS", "UPSTREAM_CHANGED"] as const) {
    const queued = await service.submit(actor, { projectId: "p", chapterId: "c", configurationVersionId: newTested.id, modelId: "m" });
    const failed = await service.run(actor, queued.id, async () => { throw new TaskExecutionError(code); });
    assert.equal(failed.reason, code); assert.equal(failed.state, code === "UPSTREAM_CHANGED" ? "paused" : "failed");
    assert.equal((await service.get(actor, queued.id)).result, null);
  }
  context = { ...context, sourceVersionId: "source2" };
  await assert.rejects(() => service.resubmit(actor, original.id, { configurationVersionId: newTested.id, modelId: "m" }), { code: "UPSTREAM_CHANGED" });
  await assert.rejects(() => service.get({ ...actor, workspaceId: "other" }, original.id), { code: "TASK_NOT_FOUND" });
  return original;
}

test("旧Key任务暂停，新任务保留原输入；上游变化拒绝重新提交", async () => { await exercise(new InMemoryModelTaskRepository()); });

test("过期执行只恢复结果或转待人工处理，不再次调用模型", async () => {
  let now = Date.parse("2026-10-05T00:00:00Z");
  const repository = new InMemoryModelTaskRepository(() => now);
  const original = await exercise(repository);
  const fixture = { ...original, id: "crashed", parentTaskId: null, model: original.model, state: "queued" as const, revision: 0, reason: null, result: null };
  await repository.insert(fixture);
  await repository.transition(original.workspaceId, fixture.id, 0, "running", null);
  await assert.rejects(() => repository.recover(original.workspaceId, fixture.id, 1, null), { code: "STATE_CONFLICT" });
  now += 600_001;
  const uncertain = await repository.recover(original.workspaceId, fixture.id, 1, null);
  assert.equal(uncertain.reason, "EXECUTION_UNCERTAIN"); assert.equal(uncertain.state, "paused");
  const result = { candidateVersionId: "saved-before-crash", extractionStatus: "partially_succeeded" as const };
  const recoveries = await Promise.allSettled([repository.recover(original.workspaceId, fixture.id, 2, result), repository.recover(original.workspaceId, fixture.id, 2, result)]);
  assert.equal(recoveries.filter(value => value.status === "fulfilled").length, 1);
  assert.deepEqual((await repository.find(original.workspaceId, fixture.id))?.result, result);
  await assert.rejects(() => repository.transition(original.workspaceId, fixture.id, 1, "succeeded", null, result), { code: "STATE_CONFLICT" });
});

test("PostgreSQL任务持久化、暂停重提交与并发执行遵守相同契约", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const { Pool } = createRequire(new URL("../../project-import/package.json", import.meta.url))("pg");
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const app = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: "-c role=novel_app" });
  try {
    await admin.query("do $$ begin if not exists(select 1 from pg_roles where rolname='novel_app') then create role novel_app nologin; end if; exception when duplicate_object then null; end $$");
    if (!(await admin.query("select to_regclass('model_tasks') as name")).rows[0].name) {
      await admin.query(await readFile(new URL("../migrations/0003_model_tasks.sql", import.meta.url), "utf8"));
    }
    if (!(await admin.query("select exists(select 1 from information_schema.columns where table_name='model_tasks' and column_name='result_json') as present")).rows[0].present) {
      await admin.query(await readFile(new URL("../migrations/0004_model_task_results.sql", import.meta.url), "utf8"));
    }
    await admin.query(await readFile(new URL("../migrations/0005_model_task_recovery.sql", import.meta.url), "utf8"));
    const original = await exercise(new PostgresModelTaskRepository(app));
    const { state, revision, reason, ...payload } = original;
    const constraintId = randomUUID();
    await admin.query("insert into model_tasks(workspace_id,id,payload,state,revision) values($1,$2,$3::jsonb,'queued',0)", [original.workspaceId, constraintId, JSON.stringify({ ...payload, id: constraintId, parentTaskId: null })]);
    await admin.query("update model_tasks set state='running',revision=1,lease_expires_at=clock_timestamp()+interval '10 minutes' where workspace_id=$1 and id=$2", [original.workspaceId, constraintId]);
    await assert.rejects(() => admin.query("update model_tasks set state='paused',reason=null,revision=2,lease_expires_at=null where workspace_id=$1 and id=$2", [original.workspaceId, constraintId]), { code: "23514" });
    await assert.rejects(() => admin.query("update model_tasks set state='succeeded',revision=2,lease_expires_at=null,result_json=$3::jsonb where workspace_id=$1 and id=$2",
      [original.workspaceId, constraintId, JSON.stringify({ candidateVersionId: "candidate", extractionStatus: null })]), { code: "23514" });
    const durable = new PostgresModelTaskRepository(app);
    await assert.rejects(() => durable.recover(original.workspaceId, constraintId, 1, null), { code: "STATE_CONFLICT" });
    const crashedId = randomUUID();
    await admin.query("insert into model_tasks(workspace_id,id,payload,state,revision,lease_expires_at) values($1,$2,$3::jsonb,'running',1,clock_timestamp()-interval '1 second')",
      [original.workspaceId, crashedId, JSON.stringify({ ...payload, id: crashedId, parentTaskId: null })]);
    assert.equal((await durable.recover(original.workspaceId, crashedId, 1, null)).reason, "EXECUTION_UNCERTAIN");
    const result = { candidateVersionId: "persisted-candidate", extractionStatus: "partially_succeeded" as const };
    const repaired = await Promise.allSettled([durable.recover(original.workspaceId, crashedId, 2, result), durable.recover(original.workspaceId, crashedId, 2, result)]);
    assert.equal(repaired.filter(item => item.status === "fulfilled").length, 1);
    assert.deepEqual((await durable.find(original.workspaceId, crashedId))?.result, result);
    await assert.rejects(() => durable.transition(original.workspaceId, crashedId, 1, "succeeded", null, result), { code: "STATE_CONFLICT" });
    await assert.rejects(() => app.query("delete from model_tasks"));
    await assert.rejects(() => app.query("update model_tasks set payload='{}'::jsonb"));
  } finally { await app.end(); await admin.end(); }
});
