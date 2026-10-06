import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceModelSettings, InMemoryModelSettingsRepository } from "../src/model-settings.ts";
import { ModelTaskService, InMemoryModelTaskRepository, type TaskInput } from "../src/model-tasks.ts";

async function fixture(options: { admitted?: boolean; allowed?: boolean } = {}) {
  const actor = { userId: "owner", workspaceId: "studio" };
  let version = 0, job = 0;
  const settings = new WorkspaceModelSettings({ repository: new InMemoryModelSettingsRepository(), encryptionKey: new Uint8Array(32).fill(7),
    access: { read: async () => ({ owner: true, advanced: true }) }, idGenerator: () => `v${++version}`,
    probe: { processingRegion: () => "mainland", test: async () => ({ modelIds: ["m"], processingRegion: "mainland" }) } });
  const configured = await settings.configure(actor, { expectedVersionId: null, providerId: "deepseek", apiKey: "fixture-key" });
  const config = await settings.testConnection(actor, configured.id);
  const context: TaskInput = { stage: "script", resultType: "episodePlan", sourceVersionId: "source-1", upstreamConfirmedVersionIds: ["bible-1"],
    generationParameters: { targetDurationSeconds: 180, aspectRatio: "9:16", narrativeMode: "narration" } };
  const repository = new InMemoryModelTaskRepository(Date.now, () => ({ maxQueued: 10, maxExecuting: 10 }));
  const service = new ModelTaskService({ settings, repository, contextReader: { read: async () => structuredClone(context) },
    generationPolicy: { isAllowed: async () => options.allowed !== false },
    ...(options.admitted ? { episodeAdmission: { workspaceIds: ["studio"], providerIds: ["deepseek"] } } : {}), idGenerator: () => `job-${++job}` });
  const input = { projectId: "p", chapterId: "c", configurationVersionId: config.id, modelId: "m" };
  return { actor, service, input, context, repository, settings };
}

test("拆集任务默认关闭，不能通过 script 阶段绕过工作室准入", async () => {
  const { actor, service, input } = await fixture();
  await assert.rejects(() => service.submit(actor, input), { code: "WORKSPACE_TASK_DISABLED" });
});

test("拆集任务必须通过内容策略，冻结拆集类型与唯一知识版本", async () => {
  const blocked = await fixture({ admitted: true, allowed: false });
  await assert.rejects(() => blocked.service.submit(blocked.actor, blocked.input), { code: "POLICY_RESTRICTED" });
  const accepted = await fixture({ admitted: true });
  const task = await accepted.service.submit(accepted.actor, accepted.input);
  assert.equal(task.input.resultType, "episodePlan");
  assert.deepEqual(task.input.upstreamConfirmedVersionIds, ["bible-1"]);
  accepted.context.upstreamConfirmedVersionIds.push("plan-1");
  await assert.rejects(() => accepted.service.submit(accepted.actor, accepted.input), { code: "INVALID_CONTEXT" });
});

test("同一拆集请求并发提交只创建一个任务，冲突模型请求不能复用", async () => {
  const { actor, service, input } = await fixture({ admitted: true });
  const request = { ...input, requestId: "request-1" };
  const [first, second] = await Promise.all([service.submitEpisodePlan(actor, request), service.submitEpisodePlan(actor, request)]);
  assert.equal(first.id, second.id);
  assert.equal(first.input.resultType, "episodePlan");
  assert.ok(!JSON.stringify(first).includes("fixture-key"));
  await assert.rejects(() => service.submitEpisodePlan(actor, { ...request, modelId: "other" }), { code: "STATE_CONFLICT" });
});

test("已排队拆集任务在执行服务关闭准入后暂停，不调用模型", async () => {
  const f = await fixture({ admitted: true });
  const task = await f.service.submitEpisodePlan(f.actor, { ...f.input, requestId: "request-1" });
  const closed = new ModelTaskService({ settings: f.settings, repository: f.repository, contextReader: { read: async () => f.context },
    generationPolicy: { isAllowed: async () => true }, idGenerator: () => "unused" });
  let calls = 0;
  const result = await closed.run(f.actor, task.id, async () => { calls++; });
  assert.equal(result.state, "paused");
  assert.equal(result.reason, "NOT_READY");
  assert.equal(calls, 0);
});

test("拆集上游或类型变化会暂停，幂等回放仍指向原任务而不冻结新输入", async () => {
  for (const change of ["source", "bible", "kind"] as const) {
    const f = await fixture({ admitted: true });
    const request = { ...f.input, requestId: "request-1" };
    const task = await f.service.submitEpisodePlan(f.actor, request);
    if (change === "source") f.context.sourceVersionId = "source-2";
    if (change === "bible") f.context.upstreamConfirmedVersionIds = ["bible-2"];
    if (change === "kind") delete f.context.resultType;
    let calls = 0;
    const result = await f.service.run(f.actor, task.id, async () => { calls++; });
    assert.equal(result.state, "paused"); assert.equal(result.reason, "UPSTREAM_CHANGED"); assert.equal(calls, 0);
    if (change !== "kind") {
      const replay = await f.service.submitEpisodePlan(f.actor, request);
      assert.equal(replay.id, task.id); assert.equal(replay.input.sourceVersionId, "source-1");
      assert.deepEqual(replay.input.upstreamConfirmedVersionIds, ["bible-1"]);
    }
  }
});

test("旧 script 任务不具备拆集提交入口", async () => {
  const f = await fixture({ admitted: true });
  delete f.context.resultType;
  await assert.rejects(() => f.service.submitEpisodePlan(f.actor, { ...f.input, requestId: "request-1" }), { code: "INVALID_CONTEXT" });
  assert.equal((await f.service.submit(f.actor, f.input)).input.resultType, undefined);
});
