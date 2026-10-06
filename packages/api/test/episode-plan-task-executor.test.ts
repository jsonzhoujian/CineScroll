import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryProjectImportRepository } from "@novel-adaptation/project-import";
import { InMemoryStoryKnowledgeRepository, StoryKnowledgeService } from "@novel-adaptation/story-knowledge";
import { InMemoryScriptRepository, ScriptService, ScriptUpstreamChangedError, type ScriptRepository } from "@novel-adaptation/script";
import { WorkspaceModelSettings, InMemoryModelSettingsRepository } from "@novel-adaptation/script/model-settings";
import { InMemoryModelTaskRepository, ModelTaskService } from "@novel-adaptation/script/model-tasks";
import { EpisodePlanRunner, type EpisodePlanGenerationRequest } from "@novel-adaptation/script/episode-plan-runner";
import { EpisodePlanUpstreamReader } from "../src/episode-plan-api.ts";
import { EpisodePlanTaskContext, EpisodePlanTaskExecutor } from "../src/episode-plan-task-executor.ts";
import { EpisodePlanTaskDispatcher, EpisodePlanTaskWorker } from "../src/episode-plan-task-dispatcher.ts";

async function fixture(planRepository: ScriptRepository = new InMemoryScriptRepository()) {
  const actor = { userId: "owner", workspaceId: "w" }, projects = new InMemoryProjectImportRepository();
  const project = { id: "p", workspaceId: "w", ownerUserId: "owner", title: "雨落", aspectRatio: "9:16" as const, targetDurationSeconds: 60 as const, narrativeMode: "dialogue" as const, dataRegion: "CN" as const, createdAt: "2026-10-06",
    members: [{ userId: "owner", role: "owner" as const }], chapters: [{ id: "c", title: "雨落", activeSourceVersionId: "s", versions: [{ id: "s", ordinal: 1, createdBy: "owner", createdAt: "2026-10-06", characterCount: 2, text: "雨落", fragments: [{ id: "f", ordinal: 1, startOffset: 0, endOffset: 2, text: "雨落", contentHash: "h" }] }] }] };
  await projects.saveProject(actor, project);
  let id = 0, now = 0, allowed = true;
  const knowledge = new StoryKnowledgeService({ repository: new InMemoryStoryKnowledgeRepository(), projectAccessReader: projects, idGenerator: () => `k${++id}`, clock: () => new Date("2026-10-06"),
    sourceReader: { async findSourceVersion(a,p,c,s) { const v = (await projects.findChapter(a,p,c))?.versions.find(v => v.id === s); return v ? { id: v.id, fragmentIds: v.fragments.map(f => f.id) } : null; } } });
  const script = new ScriptService({ repository: planRepository, accessReader: projects, upstreamReader: new EpisodePlanUpstreamReader(projects, knowledge), idGenerator: () => `plan${++id}`, clock: () => new Date("2026-10-06") });
  const context = new EpisodePlanTaskContext(projects, knowledge);
  const settings = new WorkspaceModelSettings({ repository: new InMemoryModelSettingsRepository(), encryptionKey: new Uint8Array(32).fill(7), access: { read: async () => ({ owner: true, advanced: true }) }, idGenerator: () => `config${++id}`,
    probe: { processingRegion: () => "mainland", test: async () => ({ modelIds: ["m"], processingRegion: "mainland" }) } });
  const config = await settings.testConnection(actor, (await settings.configure(actor, { expectedVersionId: null, providerId: "deepseek", apiKey: "fixture-key" })).id);
  const repository = new InMemoryModelTaskRepository(() => now, () => ({ maxQueued: 10, maxExecuting: 10 }));
  const tasks = new ModelTaskService({ settings, repository, contextReader: context, episodeAdmission: { workspaceIds: ["w"], providerIds: ["deepseek"] }, generationPolicy: { isAllowed: async () => allowed }, idGenerator: () => `task${++id}` });
  const confirm = async () => {
    const extracted = await knowledge.recordExtraction(actor, { contractVersion: "0.1.0", jobId: `job${++id}`, stage: "storyKnowledge", projectId: "p", chapterId: "c", sourceVersionId: "s", status: "succeeded", items: [{ scopeKey: "events", status: "succeeded", value: { id: "event", factType: "event", statement: "开始下雨", assertionKind: "explicit", resolutionStatus: "resolved", resolutionGroupId: null, evidence: [{ sourceVersionId: "s", fragmentId: "f" }] } }] });
    const reviewed = await knowledge.reviewFact(actor,"p","c",{ expectedActiveVersionId: extracted.id, factId: "event", outcome: "accepted", reason: "符合原文" });
    return knowledge.confirmStage(actor,"p","c",{ expectedActiveVersionId: reviewed.id, reason: "完成" });
  };
  const submit = () => tasks.submitEpisodePlan(actor, { projectId: "p", chapterId: "c", configurationVersionId: config.id, modelId: "m", requestId: `request${++id}` });
  return { actor, projects, project, knowledge, script, context, tasks, repository, confirm, submit, expire: () => { now += 600_001; }, block: () => { allowed = false; } };
}
function response(r: EpisodePlanGenerationRequest) {
  return { contractVersion: "0.1.0", jobId: r.jobId, stage: "script", resultType: "episodePlan", projectId: "p", chapterId: "c", sourceVersionId: "s", upstreamConfirmedVersionIds: [...r.upstreamConfirmedVersionIds], status: "succeeded", recommendationRationale: "保留事件", episodes: [{ id: "e", ordinal: 1, title: "雨落", sourceFragmentIds: ["f"], coreEventFactIds: ["event"] }], majorAdaptationProposals: [] };
}
test("拆集执行从已确认知识和原文生成可信请求，保存可读取候选但不确认", async () => {
  const f = await fixture();
  assert.equal(await f.context.read(f.actor,"p","c"), null);
  const confirmed = await f.confirm();
  const task = await f.submit();
  const executor = new EpisodePlanTaskExecutor({ tasks: f.tasks, projects: f.projects, knowledge: f.knowledge, script: f.script, model: { async generate(r, credentials) {
    assert.equal(credentials.apiKey, "fixture-key"); assert.equal(r.input.sourceFragments[0]?.text, "雨落");
    assert.deepEqual(r.input.confirmedUpstreamContent, [{ id: "event", factType: "event", statement: "开始下雨", isCoreEvent: true }]);
    assert.deepEqual(r.upstreamConfirmedVersionIds, [confirmed.version.id]); return response(r);
  } } });
  const done = await executor.run(f.actor, task.id);
  assert.equal(done.state,"succeeded");
  const plan = await f.script.getEpisodePlan(f.actor,"p","c");
  assert.equal(done.result?.candidateVersionId,plan.id); assert.equal(plan.status,"candidate"); assert.equal(plan.generationJobId,task.id);
});

test("新原文未确认知识时旧拆集任务仍可读取并暂停，非成员不可读取", async () => {
  const f = await fixture(); await f.confirm(); const task = await f.submit();
  f.project.chapters[0]!.activeSourceVersionId = "new-source"; await f.projects.saveProject(f.actor,f.project);
  assert.equal((await f.tasks.get(f.actor,task.id)).id,task.id);
  await assert.rejects(() => f.tasks.get({ ...f.actor,userId: "outsider" },task.id),{ code: "TASK_NOT_FOUND" });
  const executor = new EpisodePlanTaskExecutor({ tasks: f.tasks, projects: f.projects, knowledge: f.knowledge, script: f.script, model: { async generate() { assert.fail("不得调用模型"); } } });
  const paused = await executor.run(f.actor,task.id);
  assert.equal(paused.state,"paused"); assert.equal(paused.reason,"UPSTREAM_CHANGED");
});

test("拆集恢复只对账任务对应的已保存版本，不读取最新候选或再次调用模型", async () => {
  const f = await fixture(); const confirmed = await f.confirm(); const task = await f.submit();
  await f.repository.transition(f.actor.workspaceId,task.id,0,"running",null);
  const r: EpisodePlanGenerationRequest = { contractVersion: "0.1.0", jobId: task.id, stage: "script", projectId: "p", chapterId: "c", sourceVersionId: "s", upstreamConfirmedVersionIds: [confirmed.version.id], scopeKeys: ["episode-plan"], generationParameters: task.input.generationParameters,
    input: { sourceFragments: [{ id: "f",text: "雨落" }],confirmedUpstreamContent: [{ id: "event",factType: "event",statement: "开始下雨",isCoreEvent: true }],approvedAdditionIds: [],lockedItemIds: [] } };
  const saved = await new EpisodePlanRunner({ script: f.script, model: { async generate(r) { return response(r); } } }).run(f.actor,r,null);
  const formal = await f.script.confirmEpisodePlan(f.actor,"p","c",{ expectedActiveVersionId: saved.id });
  assert.notEqual(formal.id,saved.id);
  f.project.chapters[0]!.activeSourceVersionId = "new-source"; await f.projects.saveProject(f.actor,f.project); f.expire();
  const executor = new EpisodePlanTaskExecutor({ tasks: f.tasks, projects: f.projects, knowledge: f.knowledge, script: f.script, model: { async generate() { assert.fail("恢复不得调用模型"); } } });
  const recovered = await executor.recover(f.actor,task.id);
  assert.equal(recovered.state,"succeeded"); assert.equal(recovered.result?.candidateVersionId,saved.id);
});

test("没有匹配拆集结果时恢复为执行不确定，不可自动重新提交", async () => {
  const f = await fixture(); await f.confirm(); const task = await f.submit();
  await f.repository.transition(f.actor.workspaceId,task.id,0,"running",null); f.expire();
  const executor = new EpisodePlanTaskExecutor({ tasks: f.tasks, projects: f.projects, knowledge: f.knowledge, script: f.script, model: { async generate() { assert.fail("不得重投"); } } });
  const paused = await executor.recover(f.actor,task.id);
  assert.equal(paused.state,"paused"); assert.equal(paused.reason,"EXECUTION_UNCERTAIN");
  await assert.rejects(() => f.tasks.resubmit(f.actor,task.id,{ configurationVersionId: task.model.configurationVersionId,modelId: "m" }),{ code: "STATE_CONFLICT" });
});

for (const change of ["source","parameters","policy"] as const) test(`模型等待期间${change}变化不保存候选，保留暂停原因`, async () => {
  const f = await fixture(); await f.confirm(); const task = await f.submit();
  const executor = new EpisodePlanTaskExecutor({ tasks: f.tasks, projects: f.projects, knowledge: f.knowledge, script: f.script, model: { async generate(r) {
    if (change === "source") f.project.chapters[0]!.activeSourceVersionId = "new-source";
    if (change === "parameters") Object.assign(f.project,{ targetDurationSeconds: 180 });
    if (change === "policy") f.block();
    await f.projects.saveProject(f.actor,f.project); return response(r);
  } } });
  const paused = await executor.run(f.actor,task.id);
  assert.equal(paused.state,"paused"); assert.equal(paused.reason,change === "policy" ? "POLICY_RESTRICTED" : "UPSTREAM_CHANGED");
  await assert.rejects(() => f.script.getEpisodePlan(f.actor,"p","c"),{ code: "EPISODE_PLAN_NOT_FOUND" });
});

test("已有拆集候选时拒绝执行新任务，不覆盖旧版本", async () => {
  const f = await fixture(); await f.confirm(); const first = await f.submit();
  let calls = 0;
  const executor = new EpisodePlanTaskExecutor({ tasks: f.tasks, projects: f.projects, knowledge: f.knowledge, script: f.script, model: { async generate(r) { calls++; return response(r); } } });
  const done = await executor.run(f.actor,first.id); const second = await f.submit();
  const failed = await executor.run(f.actor,second.id);
  assert.equal(failed.state,"failed"); assert.equal(failed.reason,"CANDIDATE_EXISTS"); assert.equal(calls,1);
  assert.equal((await f.script.getEpisodePlan(f.actor,"p","c")).id,done.result?.candidateVersionId);
});

for (const mode of ["invalid","provider"] as const) test(`拆集${mode}错误脱敏且不产生候选`, async () => {
  const f = await fixture(); await f.confirm(); const task = await f.submit();
  const executor = new EpisodePlanTaskExecutor({ tasks: f.tasks, projects: f.projects, knowledge: f.knowledge, script: f.script, model: { async generate(r) {
    if (mode === "provider") throw new Error("secret fixture-key private provider details");
    return { ...response(r),sourceVersionId: "forged" };
  } } });
  const failed = await executor.run(f.actor,task.id);
  assert.equal(failed.state,"failed"); assert.equal(failed.reason,mode === "invalid" ? "INVALID_RESPONSE" : "PROVIDER_UNAVAILABLE");
  assert.ok(!JSON.stringify(failed).includes("fixture-key"));
  await assert.rejects(() => f.script.getEpisodePlan(f.actor,"p","c"),{ code: "EPISODE_PLAN_NOT_FOUND" });
});

test("数据库最终上游门禁冲突保存为暂停，而不是已有候选失败", async () => {
  // Fault injection at the persistence boundary: PostgreSQL separately verifies this typed error.
  const stored = new InMemoryScriptRepository();
  const database: ScriptRepository = {
    findEpisodePlanVersion: stored.findEpisodePlanVersion.bind(stored), findActiveEpisodePlan: stored.findActiveEpisodePlan.bind(stored),
    findConfirmedEpisodePlan: stored.findConfirmedEpisodePlan.bind(stored), findOperationResult: stored.findOperationResult.bind(stored),
    async saveEpisodePlan() { throw new ScriptUpstreamChangedError(); },
  };
  const f = await fixture(database); await f.confirm(); const task = await f.submit();
  const executor = new EpisodePlanTaskExecutor({ tasks: f.tasks, projects: f.projects, knowledge: f.knowledge, script: f.script, model: { async generate(r) { return response(r); } } });
  const paused = await executor.run(f.actor,task.id);
  assert.equal(paused.state,"paused"); assert.equal(paused.reason,"UPSTREAM_CHANGED");
  await assert.rejects(() => f.script.getEpisodePlan(f.actor,"p","c"),{ code: "EPISODE_PLAN_NOT_FOUND" });
});

test("并发拆集调度只执行一次，过期任务仅恢复且普通剧本任务不会被扫描", async () => {
  const f = await fixture(); await f.confirm(); const task = await f.submit(); let calls = 0;
  const legacyInput = structuredClone(task.input); delete legacyInput.resultType;
  await f.repository.insert({ ...task,id: "legacy-script",input: legacyInput });
  const executor = new EpisodePlanTaskExecutor({ tasks: f.tasks, projects: f.projects, knowledge: f.knowledge, script: f.script, model: { async generate(r) { calls++; return response(r); } } });
  const dispatcher = new EpisodePlanTaskDispatcher({ repository: f.repository,executor });
  await Promise.all([dispatcher.tick("w","run"),dispatcher.tick("w","run")]);
  assert.equal(calls,1); assert.equal((await f.tasks.get(f.actor,task.id)).state,"succeeded");
  assert.equal((await f.repository.find("w","legacy-script"))?.state,"queued");
  const abandoned = await f.submit(); await f.repository.transition("w",abandoned.id,0,"running",null); f.expire();
  const recovered = await dispatcher.tick("w","recover");
  assert.equal(recovered.items[0]?.reason,"EXECUTION_UNCERTAIN"); assert.equal(calls,1);
  assert.deepEqual((await dispatcher.tick("w","run")).items,[]);
});

test("拆集 Worker 默认关闭，显式开启后处理任务且可安全停止", { timeout: 5000 }, async () => {
  const f = await fixture(); await f.confirm(); const task = await f.submit(); let calls = 0;
  const executor = new EpisodePlanTaskExecutor({ tasks: f.tasks, projects: f.projects, knowledge: f.knowledge, script: f.script, model: { async generate(r) { calls++; return response(r); } } });
  const dispatcher = new EpisodePlanTaskDispatcher({ repository: f.repository,executor });
  const disabled = new EpisodePlanTaskWorker({ dispatcher,workspaceIds: ["w"] });
  await disabled.start(); assert.equal(disabled.status().state,"stopped"); assert.equal(calls,0);
  let waiting!: () => void;
  const ready = new Promise<void>(resolve => { waiting = resolve; });
  const worker = new EpisodePlanTaskWorker({ dispatcher,enabled: true,workspaceIds: ["w"],wait: async (_ms,signal) => {
    waiting(); await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort",() => resolve(),{ once: true }); });
  } });
  const running = worker.start(); await ready;
  assert.equal((await f.tasks.get(f.actor,task.id)).state,"succeeded"); assert.equal(calls,1);
  await worker.stop(); await running; assert.equal(worker.status().state,"stopped");
});
