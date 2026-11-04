import { SettingsRegenerationTaskDispatcher } from "../src/settings-regeneration-task-dispatcher.ts";
import assert from "node:assert/strict";
import test from "node:test";
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { HmacSessionManager } from "@novel-adaptation/identity";
import { EpisodePlanTaskApiModule } from "../src/episode-plan-task-api.ts";
import { DeepSeekEpisodePlanModel } from "../src/deepseek-episode-model.ts";
import { InMemoryProjectImportRepository } from "@novel-adaptation/project-import";
import { InMemoryStoryKnowledgeRepository, StoryKnowledgeService } from "@novel-adaptation/story-knowledge";
import { InMemoryScriptRepository, ScriptService, ScriptUpstreamChangedError, type ScriptRepository } from "@novel-adaptation/script";
import { WorkspaceModelSettings, InMemoryModelSettingsRepository } from "@novel-adaptation/script/model-settings";
import { InMemoryModelTaskRepository, ModelTaskService } from "@novel-adaptation/script/model-tasks";
import { EpisodePlanRunner, type EpisodePlanGenerationRequest } from "@novel-adaptation/script/episode-plan-runner";
import { EpisodePlanUpstreamReader } from "../src/episode-plan-api.ts";
import { EpisodePlanTaskContext, EpisodePlanTaskExecutor } from "../src/episode-plan-task-executor.ts";
import { EpisodePlanTaskDispatcher, EpisodePlanTaskWorker } from "../src/episode-plan-task-dispatcher.ts";
import { PostgresModelRateLimiter } from "../src/model-rate-limit.ts";
import { availableRateLimiter } from "./rate-limit-fixture.ts";
import { StoryKnowledgeTaskApiModule } from "../src/story-knowledge-task-api.ts";
import { StoryKnowledgeTaskContext } from "../src/story-knowledge-task-context.ts";

async function episodeFixture(planRepository: ScriptRepository = new InMemoryScriptRepository(), providerIds: readonly string[] = ["deepseek"]) {
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
  const tasks = new ModelTaskService({ settings, repository, contextReader: context, episodeAdmission: { workspaceIds: ["w"], providerIds }, generationPolicy: { isAllowed: async () => allowed }, idGenerator: () => `task${++id}` });
  const confirm = async () => {
    const extracted = await knowledge.recordExtraction(actor, { contractVersion: "0.1.0", jobId: `job${++id}`, stage: "storyKnowledge", projectId: "p", chapterId: "c", sourceVersionId: "s", status: "succeeded", items: [{ scopeKey: "events", status: "succeeded", value: { id: "event", factType: "event", statement: "开始下雨", assertionKind: "explicit", resolutionStatus: "resolved", resolutionGroupId: null, evidence: [{ sourceVersionId: "s", fragmentId: "f" }] } }] });
    const reviewed = await knowledge.reviewFact(actor,"p","c",{ expectedActiveVersionId: extracted.id, factId: "event", outcome: "accepted", reason: "符合原文" });
    return knowledge.confirmStage(actor,"p","c",{ expectedActiveVersionId: reviewed.id, reason: "完成" });
  };
  const submit = () => tasks.submitEpisodePlan(actor, { projectId: "p", chapterId: "c", configurationVersionId: config.id, modelId: "m", requestId: `request${++id}` });
  return { actor, projects, project, knowledge, script, context, tasks, repository, confirm, submit,settings,
    settingsSelection: async () => ({ configurationVersionId: config.id,modelId: "m" }),
    expire: () => { now += 600_001; }, block: () => { allowed = false; } };
}
import { ScriptContentContext } from "../src/script-content-context.ts";
import { ScriptContentTaskExecutor } from "../src/script-content-task-executor.ts";
import { ScriptContentTaskApiModule } from "../src/script-content-task-api.ts";
import { ScriptContentApiModule } from "../src/script-content-api.ts";
import { InMemoryScriptContentRepository, ScriptContentService, ScriptContentError } from "@novel-adaptation/script/script-content";

async function fixture() {
  const f = await episodeFixture(); await f.confirm();
  const task = await f.submit();
  await new EpisodePlanTaskExecutor({ tasks: f.tasks,projects: f.projects,knowledge: f.knowledge,script: f.script,model: { async generate(r) { return {
    contractVersion: "0.1.0",jobId: r.jobId,stage: "script",resultType: "episodePlan",projectId: "p",chapterId: "c",sourceVersionId: "s",
    upstreamConfirmedVersionIds: r.upstreamConfirmedVersionIds,status: "succeeded",recommendationRationale: "one episode",episodes: [{ id: "e",ordinal: 1,title: "rain",sourceFragmentIds: ["f"],coreEventFactIds: ["event"] }],majorAdaptationProposals: []
  }; } } }).run(f.actor,task.id);
  const candidate = await f.script.getEpisodePlan(f.actor,"p","c");
  await f.script.confirmEpisodePlan(f.actor,"p","c",{ expectedActiveVersionId: candidate.id });
  const repository = new InMemoryScriptContentRepository(),context = new ScriptContentContext(f.projects,f.knowledge,f.script,repository);
  let id = 0;
  const service = new ScriptContentService({ repository,contextReader: context,idGenerator: () => `content${++id}`,clock: () => new Date("2026-10-29") });
  const tasks = new ModelTaskService({ settings: f.settings,repository: f.repository,contextReader: context,scriptAdmission: { workspaceIds: ["w"],providerIds: ["deepseek"] },generationPolicy: { isAllowed: async () => true },idGenerator: () => `script-task${++id}` });
  return { ...f,tasks,context,contentRepository: repository,service };
}
function scriptResponse(r: Parameters<import("../src/script-content-task-executor.ts").CredentialedScriptContentModel["generate"]>[0]) {
  return { contractVersion: "0.1.0",jobId: r.jobId,stage: "script",projectId: "p",chapterId: "c",sourceVersionId: "s",upstreamConfirmedVersionIds: r.upstreamConfirmedVersionIds,
    status: "succeeded",scenes: [{ id: "scene",episodeId: "e",ordinal: 1,title: "rain",environment: "outside",characters: [] }],items: [{ scopeKey: "action",status: "succeeded",value: {
      id: "action",sceneId: "scene",elementType: "action",ordinal: 1,text: "雨落",provenance: [{ type: "source_fragment",sourceVersionId: "s",fragmentId: "f",transformation: "retained" }]
    } }] };
}
test("confirmed episode plan produces task-bound script candidate and evidence through authenticated APIs",async () => {
  const f = await fixture();
  const sessions = new HmacSessionManager({ secret: "0123456789abcdef0123456789abcdef",resolveActor: async userId => ({ userId,workspaceId: "w" }) });
  const ref = await Test.createTestingModule({ imports: [ScriptContentTaskApiModule.register({ sessionVerifier: sessions,tasks: f.tasks,rateLimiter: availableRateLimiter() }),ScriptContentApiModule.register({ sessionVerifier: sessions,repository: f.contentRepository,context: f.context })] }).compile();
  const app = ref.createNestApplication(); await app.listen(0,"127.0.0.1");
  try {
    const http = request(app.getHttpServer()),auth = { authorization: `Bearer ${await sessions.issue("owner","w")}` },base = "/projects/p/chapters/c/script-content-tasks";
    const input = { ...await f.settingsSelection(),requestId: "r" };
    await http.post(base).send(input).expect(401);
    await http.post(base).set(auth).send({ ...input,sourceVersionId: "forged" }).expect(400);
    const created = await http.post(base).set(auth).send(input).expect(201);
    assert.equal((await http.post(base).set(auth).send(input).expect(201)).body.id,created.body.id);
    const executor = new ScriptContentTaskExecutor({ tasks: f.tasks,context: f.context,repository: f.contentRepository,service: f.service,model: { async generate(r) { return scriptResponse(r); } } });
    const outcome = await executor.run(f.actor,created.body.id);
    assert.equal(outcome.state,"succeeded");
    const view = await http.get("/projects/p/chapters/c/script-content").set(auth).expect(200);
    assert.equal(view.body.version.id,outcome.result?.candidateVersionId); assert.equal(view.body.current,true);
    assert.equal(view.body.sourceFragments[0].text,"雨落");
    await http.get("/projects/p/chapters/c/script-content").set({ authorization: `Bearer ${await sessions.issue("outsider","w")}` }).expect(404);
    assert.equal((await http.get(base).set(auth).expect(200)).body.tasks.length,1);
    await http.post(`/script-content-tasks/${created.body.id}/run`).set(auth).expect(404);
  } finally { await app.close(); }
});
test("script response after source changes pauses without saving stale content",async () => {
  const f = await fixture();
  const task = await f.tasks.submitScriptContent(f.actor,{ projectId: "p",chapterId: "c",...await f.settingsSelection(),requestId: "stale" });
  const executor = new ScriptContentTaskExecutor({ tasks: f.tasks,context: f.context,repository: f.contentRepository,service: f.service,model: { async generate(r) {
    f.project.chapters[0]!.activeSourceVersionId = "changed"; await f.projects.saveProject(f.actor,f.project); return scriptResponse(r);
  } } });
  const outcome = await executor.run(f.actor,task.id);
  assert.equal(outcome.reason,"UPSTREAM_CHANGED");
  assert.equal(await f.contentRepository.findActive(f.actor,"p","c"),null);
});

test("lost candidate commit response remains reconcilable without invoking the model again",async () => {
  const f = await fixture();
  const backing = f.contentRepository;
  const uncertainRepository = {
    findActive: backing.findActive.bind(backing),findGeneration: backing.findGeneration.bind(backing),
    async save(...args: Parameters<typeof backing.save>) { await backing.save(...args); throw new (await import("@novel-adaptation/script/script-content")).ScriptContentError("STORAGE_UNAVAILABLE","lost commit response"); },
  };
  const service = new ScriptContentService({ repository: uncertainRepository,contextReader: f.context,idGenerator: () => "lost-candidate",clock: () => new Date("2026-10-29") });
  const task = await f.tasks.submitScriptContent(f.actor,{ projectId: "p",chapterId: "c",...await f.settingsSelection(),requestId: "lost" });
  let calls = 0;
  const executor = new ScriptContentTaskExecutor({ tasks: f.tasks,context: f.context,repository: uncertainRepository,service,model: { async generate(r) { calls++; return scriptResponse(r); } } });
  const unknown = await executor.run(f.actor,task.id);
  assert.equal(unknown.state,"paused"); assert.equal(unknown.reason,"EXECUTION_UNCERTAIN");
  assert.equal((await executor.recover(f.actor,task.id)).result?.candidateVersionId,"lost-candidate");
  assert.equal(calls,1);
});

test("native malformed model output is INVALID_RESPONSE and historical submission survives source changes",async () => {
  const f = await fixture();
  const input = { projectId: "p",chapterId: "c",...await f.settingsSelection(),requestId: "invalid" };
  const task = await f.tasks.submitScriptContent(f.actor,input);
  const { DeepSeekScriptContentModel } = await import("../src/deepseek-script-content-model.ts");
  const model = new DeepSeekScriptContentModel({ fetch: async () => Response.json({ object: "chat.completion",model: "m",choices: [{ index: 0,finish_reason: "stop",message: { role: "assistant",content: "not json" } }] }) });
  const executor = new ScriptContentTaskExecutor({ tasks: f.tasks,context: f.context,repository: f.contentRepository,service: f.service,model });
  assert.equal((await executor.run(f.actor,task.id)).reason,"INVALID_RESPONSE");
  f.project.chapters[0]!.activeSourceVersionId = "changed"; await f.projects.saveProject(f.actor,f.project);
  assert.equal((await f.tasks.submitScriptContent(f.actor,input)).id,task.id);
  await assert.rejects(() => f.tasks.submitScriptContent(f.actor,{ ...input,requestId: "new" }),{ code: "TASK_NOT_FOUND" });
});

test("post-model storage outage preserves unknown execution rather than allowing regeneration",async () => {
  const f = await fixture();
  const task = await f.tasks.submitScriptContent(f.actor,{ projectId: "p",chapterId: "c",...await f.settingsSelection(),requestId: "post-model-outage" });
  const executor = new ScriptContentTaskExecutor({ tasks: f.tasks,context: f.context,repository: f.contentRepository,service: f.service,model: { async generate(r) {
    f.projects.findChapter = async () => { throw new Error("simulated persistence outage"); };
    return scriptResponse(r);
  } } });
  const result = await executor.run(f.actor,task.id);
  assert.equal(result.state,"paused"); assert.equal(result.reason,"EXECUTION_UNCERTAIN");
  assert.equal(await f.contentRepository.findActive(f.actor,"p","c"),null);
});

test("candidate review API enforces roles, persists suggestions, replays decisions and rejects stale edits",async () => {
  const f = await fixture();
  await f.projects.saveProject(f.actor,{ ...f.project,members: [{ userId: "owner",role: "owner" },{ userId: "editor",role: "editor" },{ userId: "reviewer",role: "reviewer" }] });
  const task = await f.tasks.submitScriptContent(f.actor,{ projectId: "p",chapterId: "c",...await f.settingsSelection(),requestId: "review-fixture" });
  await new ScriptContentTaskExecutor({ tasks: f.tasks,context: f.context,repository: f.contentRepository,service: f.service,model: { async generate(r) { return scriptResponse(r); } } }).run(f.actor,task.id);
  let sequence = 0;
  const review = new ScriptContentService({ repository: f.contentRepository,contextReader: f.context,accessReader: f.projects,idGenerator: () => `review-${++sequence}`,clock: () => new Date("2026-10-29") });
  const sessions = new HmacSessionManager({ secret: "0123456789abcdef0123456789abcdef",resolveActor: async userId => ({ userId,workspaceId: "w" }) });
  const ref = await Test.createTestingModule({ imports: [ScriptContentApiModule.register({ sessionVerifier: sessions,repository: f.contentRepository,context: f.context,review })] }).compile();
  const app = ref.createNestApplication(); await app.listen(0,"127.0.0.1");
  try {
    const http = request(app.getHttpServer()),path = "/projects/p/chapters/c/script-content";
    const owner = { authorization: `Bearer ${await sessions.issue("owner","w")}` },editor = { authorization: `Bearer ${await sessions.issue("editor","w")}` },reviewer = { authorization: `Bearer ${await sessions.issue("reviewer","w")}` };
    const original = await http.get(path).set(owner).expect(200);
    const command = { kind: "edit",requestId: "edit",expectedActiveVersionId: original.body.version.id,elementId: "action",text: "雨打庭院",reason: "视觉表达" };
    await http.post(`${path}/review`).set(editor).send(command).expect(403);
    await http.post(`${path}/review`).set(owner).send({ ...command,actor: "forged" }).expect(400);
    const suggestion = await http.post(`${path}/review`).set(editor).send({ ...command,kind: "suggest",requestId: "suggest" }).expect(201);
    assert.equal(suggestion.body.elements[0].text,"雨落");
    const decision = { kind: "decide",requestId: "decision",expectedActiveVersionId: suggestion.body.id,suggestionId: suggestion.body.suggestions[0].id,decision: "accepted",reason: "符合原文" };
    await http.post(`${path}/review`).set(editor).send(decision).expect(403);
    const accepted = await http.post(`${path}/review`).set(reviewer).send(decision).expect(201);
    const replay = await http.post(`${path}/review`).set(reviewer).send(decision).expect(201);
    assert.equal(replay.body.id,accepted.body.id); assert.equal(accepted.body.elements[0].text,"雨打庭院");
    const noEffect = await http.post(`${path}/review`).set(reviewer).send({ ...decision,requestId: "noop",expectedActiveVersionId: accepted.body.id }).expect(201);
    assert.equal(noEffect.body.reviewOperation.requestId,"noop");
    await http.post(`${path}/review`).set(reviewer).send({ ...command,requestId: "noop",expectedActiveVersionId: noEffect.body.id }).expect(409);
    await http.post(`${path}/review`).set(owner).send(command).expect(409);
    const saved = await http.get(path).set(owner).expect(200);
    assert.equal(saved.body.version.id,noEffect.body.id); assert.equal(saved.body.permissions.canEdit,true);
    assert.deepEqual(saved.body.version.elements[0].provenance,original.body.version.elements[0].provenance);
  } finally { await app.close(); }
});

async function partialScriptFixture() {
  const f = await fixture();
  const task = await f.tasks.submitScriptContent(f.actor,{ projectId: "p",chapterId: "c",...await f.settingsSelection(),requestId: "partial-script" });
  await new ScriptContentTaskExecutor({ tasks: f.tasks,context: f.context,repository: f.contentRepository,service: f.service,model: { async generate(r) {
    const response = scriptResponse(r);
    return { ...response,status: "partially_succeeded",items: [...response.items,{ scopeKey: "dialogue",status: "failed",error: { code: "INVALID_ELEMENT",message: "missing",retryable: true } },{ scopeKey: "sound",status: "failed",error: { code: "INVALID_ELEMENT",message: "needs manual decision",retryable: false } }] };
  } } }).run(f.actor,task.id);
  return { ...f,base: (await f.contentRepository.findActive(f.actor,"p","c"))! };
}
function retriedResponse(r: Parameters<import("../src/script-content-task-executor.ts").CredentialedScriptContentModel["generate"]>[0]) {
  const full = scriptResponse(r);
  return { ...full,scenes: [],items: [{ scopeKey: "dialogue",status: "succeeded",value: { ...full.items[0]!.value,id: "recovered-dialogue",elementType: "dialogue",ordinal: 2,text: "下雨了" } }] };
}
test("script retry API freezes only eligible failure scopes and worker preserves successful content",async () => {
  const f = await partialScriptFixture();
  const sessions = new HmacSessionManager({ secret: "0123456789abcdef0123456789abcdef",resolveActor: async userId => ({ userId,workspaceId: "w" }) });
  const ref = await Test.createTestingModule({ imports: [ScriptContentTaskApiModule.register({ sessionVerifier: sessions,tasks: f.tasks,rateLimiter: availableRateLimiter() })] }).compile();
  const app = ref.createNestApplication(); await app.listen(0,"127.0.0.1");
  try {
    const http = request(app.getHttpServer()),path = "/projects/p/chapters/c/script-content-tasks/retries",auth = { authorization: `Bearer ${await sessions.issue("owner","w")}` };
    const input = { ...await f.settingsSelection(),requestId: "retry",expectedActiveVersionId: f.base.id,scopeKeys: ["dialogue"] };
    await http.post(path).send(input).expect(401);
    await http.post(path).set(auth).send({ ...input,sourceVersionId: "forged" }).expect(400);
    for (const scopeKeys of [["action"],["sound"],["dialogue","dialogue"],[]]) await http.post(path).set(auth).send({ ...input,scopeKeys }).expect(400);
    await http.post(path).set({ authorization: `Bearer ${await sessions.issue("outsider","w")}` }).send(input).expect(404);
    const submitted = await http.post(path).set(auth).send(input).expect(201);
    assert.equal((await http.post(path).set(auth).send(input).expect(201)).body.id,submitted.body.id);
    await http.post(path).set(auth).send({ ...input,scopeKeys: ["sound"] }).expect(409);
    await http.post(path).set(auth).send({ ...input,requestId: "duplicate-active" }).expect(409);
    const executor = new ScriptContentTaskExecutor({ tasks: f.tasks,context: f.context,repository: f.contentRepository,service: f.service,model: { async generate(r) {
      assert.deepEqual(r.scopeKeys,["dialogue"]); assert.equal(r.input.retry?.expectedActiveVersionId,f.base.id);
      assert.equal("elements" in r.input,false); assert.deepEqual(r.input.retry?.sceneReferences,[{ id: "scene",episodeId: "e",ordinal: 1 }]);
      return retriedResponse(r);
    } } });
    const result = await executor.run(f.actor,submitted.body.id);
    assert.equal(result.state,"succeeded");
    const merged = (await f.contentRepository.findActive(f.actor,"p","c"))!;
    assert.deepEqual(merged.elements[0],f.base.elements[0]); assert.equal(merged.elements[1]?.id,"recovered-dialogue");
    assert.deepEqual(merged.failures.map(f => f.scopeKey),["sound"]); assert.equal(merged.retry?.retryOfJobId,f.base.jobId);
    assert.equal((await http.post(path).set(auth).send(input).expect(201)).body.id,submitted.body.id);
    await http.post(path).set(auth).send({ ...input,requestId: "new-stale" }).expect(409);
  } finally { await app.close(); }
});
test("a user edit during retry pauses the stale task without overwriting successful content",async () => {
  const f = await partialScriptFixture();
  const task = await f.tasks.submitScriptContentRetry(f.actor,{ projectId: "p",chapterId: "c",...await f.settingsSelection(),requestId: "raced-retry",expectedActiveVersionId: f.base.id,scopeKeys: ["dialogue"] });
  const review = new ScriptContentService({ repository: f.contentRepository,contextReader: f.context,accessReader: f.projects,idGenerator: () => "edited-during-retry",clock: () => new Date("2026-10-29") });
  const executor = new ScriptContentTaskExecutor({ tasks: f.tasks,context: f.context,repository: f.contentRepository,service: f.service,model: { async generate(r) {
    await review.reviewCandidate(f.actor,"p","c",{ kind: "edit",requestId: "edit-during-retry",expectedActiveVersionId: f.base.id,elementId: "action",text: "已人工修改",reason: "保留人工表达" });
    return retriedResponse(r);
  } } });
  assert.equal((await executor.run(f.actor,task.id)).reason,"UPSTREAM_CHANGED");
  const active = (await f.contentRepository.findActive(f.actor,"p","c"))!;
  assert.equal(active.elements[0]?.text,"已人工修改"); assert.deepEqual(active.failures,f.base.failures);
});
test("lost retry commit response recovers the exact merged snapshot without another model call",async () => {
  const f = await partialScriptFixture(),backing = f.contentRepository;
  const repository = { findActive: backing.findActive.bind(backing),findGeneration: backing.findGeneration.bind(backing),async save(...args: Parameters<typeof backing.save>) { await backing.save(...args); throw new (await import("@novel-adaptation/script/script-content")).ScriptContentError("STORAGE_UNAVAILABLE","lost response"); } };
  const service = new ScriptContentService({ repository,contextReader: f.context,idGenerator: () => "persisted-retry",clock: () => new Date("2026-10-29") });
  const task = await f.tasks.submitScriptContentRetry(f.actor,{ projectId: "p",chapterId: "c",...await f.settingsSelection(),requestId: "unknown-retry",expectedActiveVersionId: f.base.id,scopeKeys: ["dialogue"] });
  let calls = 0;
  const executor = new ScriptContentTaskExecutor({ tasks: f.tasks,context: f.context,repository,service,model: { async generate(r) { calls++; return retriedResponse(r); } } });
  const unknown = await executor.run(f.actor,task.id); assert.equal(unknown.reason,"EXECUTION_UNCERTAIN");
  assert.equal((await executor.recover(f.actor,task.id)).result?.candidateVersionId,"persisted-retry"); assert.equal(calls,1);
  assert.deepEqual((await backing.findActive(f.actor,"p","c"))?.elements[0],f.base.elements[0]);
});

test("storage failure in retry validation after the response remains execution-uncertain",async () => {
  const f = await partialScriptFixture();
  const task = await f.tasks.submitScriptContentRetry(f.actor,{ projectId: "p",chapterId: "c",...await f.settingsSelection(),requestId: "late-read-outage",expectedActiveVersionId: f.base.id,scopeKeys: ["dialogue"] });
  const original = f.context.findGenerationContext.bind(f.context);
  const executor = new ScriptContentTaskExecutor({ tasks: f.tasks,context: f.context,repository: f.contentRepository,service: f.service,model: { async generate(r) {
    let reads = 0;
    f.context.findGenerationContext = async (...args) => { if (++reads === 2) throw new Error("late persistence outage"); return original(...args); };
    return retriedResponse(r);
  } } });
  assert.equal((await executor.run(f.actor,task.id)).reason,"EXECUTION_UNCERTAIN");
  assert.equal((await f.contentRepository.findActive(f.actor,"p","c"))?.id,f.base.id);
});
test("successive retries retain each unselected failure's real origin task",async () => {
  const f = await partialScriptFixture();
  const prepared = { ...f.base,id: "all-retryable",parentVersionId: f.base.id,failures: f.base.failures.map(f => ({ ...f,retryable: true })) };
  await f.contentRepository.save(f.actor,prepared,f.base.id);
  const first = await f.tasks.submitScriptContentRetry(f.actor,{ projectId: "p",chapterId: "c",...await f.settingsSelection(),requestId: "origin-a",expectedActiveVersionId: prepared.id,scopeKeys: ["dialogue"] });
  await new ScriptContentTaskExecutor({ tasks: f.tasks,context: f.context,repository: f.contentRepository,service: f.service,model: { async generate(r) { return { ...retriedResponse(r),status: "failed",items: [{ scopeKey: "dialogue",status: "failed",error: { code: "INVALID_ELEMENT",message: "still missing",retryable: true } }] }; } } }).run(f.actor,first.id);
  const partial = (await f.contentRepository.findActive(f.actor,"p","c"))!;
  const second = await f.tasks.submitScriptContentRetry(f.actor,{ projectId: "p",chapterId: "c",...await f.settingsSelection(),requestId: "origin-b",expectedActiveVersionId: partial.id,scopeKeys: ["sound"] });
  assert.equal(second.input.retry?.retryOfJobId,first.id);
  assert.deepEqual(second.input.retry?.failureOrigins,[{ scopeKey: "sound",jobId: f.base.jobId }]);
  await new ScriptContentTaskExecutor({ tasks: f.tasks,context: f.context,repository: f.contentRepository,service: f.service,model: { async generate(r) { const response = retriedResponse(r); return { ...response,items: response.items.map(i => ({ ...i,scopeKey: "sound" })) }; } } }).run(f.actor,second.id);
  const final = (await f.contentRepository.findActive(f.actor,"p","c"))!;
  assert.deepEqual(final.retry?.failureOrigins,[{ scopeKey: "sound",jobId: f.base.jobId }]);
  assert.equal(final.failures.find(f => f.scopeKey === "dialogue")?.originJobId,first.id);
});

import { qualityBinding,ScriptPublicationService } from "@novel-adaptation/script/script-publication";
import { ScriptQualityTaskContext,ScriptQualityTaskExecutor,ScriptQualityTaskDispatcher } from "../src/script-quality-tasks.ts";
test("quality task API, worker, persisted report and owner publication form one authenticated loop",async () => {
  const f = await fixture();
  const generation = await f.tasks.submitScriptContent(f.actor,{ projectId: "p",chapterId: "c",...await f.settingsSelection(),requestId: "generation" });
  await new ScriptContentTaskExecutor({ tasks: f.tasks,context: f.context,repository: f.contentRepository,service: f.service,model: { async generate(r) { return scriptResponse(r); } } }).run(f.actor,generation.id);
  await f.projects.saveProject(f.actor,{ ...f.project,members: [...f.project.members,{ userId: "editor",role: "editor" }] });
  const candidate = (await f.contentRepository.findActive(f.actor,"p","c"))!;
  const content = new ScriptContentService({ repository: f.contentRepository,contextReader: f.context,accessReader: f.projects,idGenerator: () => `publication-${Math.random()}`,clock: () => new Date("2026-11-02") });
  const publication = new ScriptPublicationService({ repository: f.contentRepository,contextReader: f.context,accessReader: f.projects,content });
  const tasks = new ModelTaskService({ settings: f.settings,repository: f.repository,contextReader: new ScriptQualityTaskContext(f.context,publication),scriptAdmission: { workspaceIds: ["w"],providerIds: ["deepseek"] },generationPolicy: { isAllowed: async () => true },idGenerator: () => "unused" });
  let calls = 0;
  const executor = new ScriptQualityTaskExecutor({ tasks,publication,fetch: async (_url,init) => {
    calls++; const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    return Response.json({ object: "chat.completion",model: "m",choices: [{ index: 0,finish_reason: "stop",message: { role: "assistant",content: JSON.stringify({ versionId: input.version.id,events: [{ factId: "event",elementIds: ["action"],verdict: "covered" }],facts: [{ factId: "event",verdict: "consistent" }],episodes: [{ episodeId: "e",estimatedSeconds: 60 }],unsupportedCoreFactElementIds: [] }) } }] });
  } });
  const sessions = new HmacSessionManager({ secret: "0123456789abcdef0123456789abcdef",resolveActor: async userId => ({ userId,workspaceId: "w" }) });
  const ref = await Test.createTestingModule({ imports: [ScriptContentApiModule.register({ sessionVerifier: sessions,repository: f.contentRepository,context: f.context,review: content,publication,qualityTasks: tasks,rateLimiter: availableRateLimiter() })] }).compile();
  const app = ref.createNestApplication(); await app.listen(0,"127.0.0.1");
  try {
    const http = request(app.getHttpServer()),auth = { authorization: `Bearer ${await sessions.issue("owner","w")}` },base = "/projects/p/chapters/c/script-content";
    const editorAuth = { authorization: `Bearer ${await sessions.issue("editor","w")}` };
    const input = { ...await f.settingsSelection(),requestId: "quality",expectedActiveVersionId: candidate.id };
    await http.post(`${base}/quality`).send(input).expect(401);
    await http.post(`${base}/quality`).set(auth).send({ ...input,passed: true }).expect(400);
    await http.post(`${base}/quality`).set(editorAuth).send(input).expect(403);
    const task = (await http.post(`${base}/quality`).set(auth).send(input).expect(201)).body;
    assert.equal((await http.post(`${base}/quality`).set(auth).send(input).expect(201)).body.id,task.id);
    await assert.rejects(() => tasks.submitScriptQuality(f.actor,{ projectId: "p",chapterId: "c",...input,requestId: "another" }),{ code: "STATE_CONFLICT" });
    const dispatcher = new ScriptQualityTaskDispatcher(f.repository,executor);
    assert.equal((await dispatcher.tick("w","run")).items[0]?.state,"succeeded");
    const report = (await http.get(`${base}/quality/${task.id}`).set(auth).expect(200)).body.report;
    assert.equal(report.passed,true,JSON.stringify(report)); assert.equal(report.assessment.episodes[0].estimatedSeconds,60);
    const cmd = { kind: "confirm",reason: "已核对",requestId: "confirm",expectedActiveVersionId: candidate.id,reportId: task.id };
    await http.post(`${base}/publication`).set(editorAuth).send(cmd).expect(403);
    assert.equal((await http.get(`${base}/quality`).set(auth).expect(200)).body.tasks.length,1);
    const formal = (await http.post(`${base}/publication`).set(auth).send(cmd).expect(201)).body;
    assert.equal(formal.status,"confirmed");
    await http.post(`${base}/publication`).set(editorAuth).send({ kind: "lock",requestId: "editor-lock",reason: "冻结",expectedActiveVersionId: formal.id,elementIds: ["action"] }).expect(403);
    const locked = (await http.post(`${base}/publication`).set(auth).send({ kind: "lock",reason: "冻结",requestId: "lock",expectedActiveVersionId: formal.id,elementIds: ["action"] }).expect(201)).body;
    assert.equal(locked.elements[0].lockedBy,"owner");
    assert.equal((await http.post(`${base}/publication`).set(auth).send(cmd).expect(201)).body.id,formal.id);
    assert.equal((await http.get(base).set(auth).expect(200)).body.version.id,locked.id);
    assert.equal(calls,1);
    await http.get(`${base}/quality/${task.id}`).set({ authorization: `Bearer ${await sessions.issue("outsider","w")}` }).expect(404);
  } finally { await app.close(); }
});

test("quality worker recovers a committed report after response loss without another model call",async () => {
  const f = await fixture();
  const generation = await f.tasks.submitScriptContent(f.actor,{ projectId: "p",chapterId: "c",...await f.settingsSelection(),requestId: "generate" });
  await new ScriptContentTaskExecutor({ tasks: f.tasks,context: f.context,repository: f.contentRepository,service: f.service,model: { async generate(r) { return scriptResponse(r); } } }).run(f.actor,generation.id);
  let calls = 0,lost = false;
  const saveReport = f.contentRepository.saveQualityReport.bind(f.contentRepository);
  f.contentRepository.saveQualityReport = async (...args) => { const report = await saveReport(...args);if (!lost) { lost = true;throw new ScriptContentError("STORAGE_UNAVAILABLE","commit response lost"); }return report; };
  const content = new ScriptContentService({ repository: f.contentRepository,contextReader: f.context,accessReader: f.projects,idGenerator: () => "formal",clock: () => new Date("2026-11-02") });
  const publication = new ScriptPublicationService({ repository: f.contentRepository,contextReader: f.context,accessReader: f.projects,content });
  const tasks = new ModelTaskService({ settings: f.settings,repository: f.repository,contextReader: new ScriptQualityTaskContext(f.context,publication),scriptAdmission: { workspaceIds: ["w"],providerIds: ["deepseek"] },generationPolicy: { isAllowed: async () => true },idGenerator: () => "unused" });
  const candidate = (await f.contentRepository.findActive(f.actor,"p","c"))!;
  const task = await tasks.submitScriptQuality(f.actor,{ projectId: "p",chapterId: "c",...await f.settingsSelection(),requestId: "quality",expectedActiveVersionId: candidate.id });
  const executor = new ScriptQualityTaskExecutor({ tasks,publication,fetch: async () => {
    calls++;return Response.json({ object: "chat.completion",model: "m",choices: [{ index: 0,finish_reason: "stop",message: { role: "assistant",content: JSON.stringify({ versionId: candidate.id,events: [{ factId: "event",elementIds: ["action"],verdict: "covered" }],facts: [{ factId: "event",verdict: "consistent" }],episodes: [{ episodeId: "e",estimatedSeconds: 60 }],unsupportedCoreFactElementIds: [] }) } }] });
  } });
  const result = await executor.run(f.actor,task.id);assert.equal(result.reason,"EXECUTION_UNCERTAIN");
  await assert.rejects(async () => tasks.submitScriptQuality(f.actor,{ projectId: "p",chapterId: "c",...await f.settingsSelection(),requestId: "another",expectedActiveVersionId: candidate.id }),{ code: "STATE_CONFLICT" });
  const recovered = await executor.recover(f.actor,task.id);assert.equal(recovered.state,"succeeded");assert.equal(recovered.result?.candidateVersionId,task.id);assert.equal(calls,1);
});

import { ConfirmedScriptHandoff } from "@novel-adaptation/script/script-handoff";
import { InMemorySettingsCandidateRepository } from "@novel-adaptation/script/settings-runner";
import { SettingsTaskDispatcher } from "../src/settings-task-dispatcher.ts";
import { SettingsTaskContext,SettingsTaskExecutor } from "../src/settings-task-executor.ts";
async function settingsFixture() {
  const f = await fixture();
  const task = await f.tasks.submitScriptContent(f.actor,{ projectId: "p",chapterId: "c",...await f.settingsSelection(),requestId: "settings-upstream" });
  await new ScriptContentTaskExecutor({ tasks: f.tasks,context: f.context,repository: f.contentRepository,service: f.service,model: { async generate(r) { return scriptResponse(r); } } }).run(f.actor,task.id);
  const candidate = (await f.contentRepository.findActive(f.actor,"p","c"))!;
  const content = new ScriptContentService({ repository: f.contentRepository,contextReader: f.context,accessReader: f.projects,idGenerator: () => "settings-formal",clock: () => new Date("2026-11-03") });
  const publication = new ScriptPublicationService({ repository: f.contentRepository,contextReader: f.context,accessReader: f.projects,content });
  const report = await publication.assess(f.actor,"p","c",{ jobId: "settings-report",binding: qualityBinding(candidate,(await f.context.findGenerationContext(f.actor,"p","c"))!),model: { async assess() { return { versionId: candidate.id,events: [{ factId: "event",elementIds: ["action"],verdict: "covered" }],facts: [{ factId: "event",verdict: "consistent" }],episodes: [{ episodeId: "e",estimatedSeconds: 60 }],unsupportedCoreFactElementIds: [] }; } } });
  await publication.execute(f.actor,"p","c",{ kind: "confirm",requestId: "settings-formal",reason: "verified",expectedActiveVersionId: candidate.id,reportId: report.id });
  const handoff = new ConfirmedScriptHandoff(f.contentRepository,f.context),context = new SettingsTaskContext(f.context,handoff);
  const candidates = new InMemorySettingsCandidateRepository(handoff);
  const tasks = new ModelTaskService({ settings: f.settings,repository: f.repository,contextReader: context,settingsAdmission: { workspaceIds: ["w"],providerIds: ["deepseek"] },generationPolicy: { isAllowed: async () => true },idGenerator: () => "settings-job" });
  return { ...f,handoff,context,candidates,tasks };
}
function settingsResponse(r: import("@novel-adaptation/script/settings-runner").SettingsGenerationRequest) {
  return { contractVersion: r.contractVersion,stage: r.stage,jobId: r.jobId,projectId: r.projectId,chapterId: r.chapterId,sourceVersionId: r.sourceVersionId,upstreamConfirmedVersionIds: r.upstreamConfirmedVersionIds,status: "succeeded",items: [{ scopeKey: "location",status: "succeeded",value: { id: "location",assetType: "location",name: "雨中庭院",visibleDefinition: { weather: "rain" },state: "",stateChanges: [],restrictions: [],provenance: [{ type: "source_fragment",sourceVersionId: "s",fragmentId: "f",transformation: "retained" }] } }] };
}
test("settings worker binds formal script, preserves task replay and recovers saved results without another model call",async () => {
  const f = await settingsFixture();let calls = 0;
  const input = { projectId: "p",chapterId: "c",...await f.settingsSelection(),requestId: "settings" };
  const task = await f.tasks.submitSettings(f.actor,input);
  assert.equal((await f.tasks.submitSettings(f.actor,input)).id,task.id);
  const save = f.candidates.saveGeneration.bind(f.candidates);
  f.candidates.saveGeneration = async (a,v) => { await save(a,v);throw new Error("lost storage acknowledgement"); };
  const executor = new SettingsTaskExecutor({ tasks: f.tasks,context: f.context,handoff: f.handoff,repository: f.candidates,idGenerator: () => "settings-candidate",clock: () => new Date("2026-11-03"),model: { async generate(r) { calls++;return settingsResponse(r); } } });
  const outcome = await executor.run(f.actor,task.id);assert.equal(outcome.reason,"EXECUTION_UNCERTAIN");
  await assert.rejects(() => executor.run(f.actor,task.id),{ code: "STATE_CONFLICT" });
  const dispatcher = new SettingsTaskDispatcher({ repository: f.repository,executor });
  const sweep = await dispatcher.tick("w","recover");assert.equal(sweep.items.length,1);assert.equal(sweep.items[0]?.state,"succeeded");
  const recovered = await f.tasks.get(f.actor,task.id);assert.equal(recovered.state,"succeeded");assert.equal(recovered.result?.candidateVersionId,"settings-candidate");assert.equal(calls,1);
  assert.equal((await dispatcher.tick("other","run")).items.length,0);
  assert.equal((await f.repository.scanSettings("w","run",{ limit: 20,cursor: null })).tasks.length,0);
  await assert.rejects(() => f.tasks.get({ ...f.actor,workspaceId: "other" },task.id),{ code: "TASK_NOT_FOUND" });
});
test("settings worker rejects changed upstream and does not save provider output",async () => {
  const f = await settingsFixture();
  const task = await f.tasks.submitSettings(f.actor,{ projectId: "p",chapterId: "c",...await f.settingsSelection(),requestId: "stale-settings" });
  const executor = new SettingsTaskExecutor({ tasks: f.tasks,context: f.context,handoff: f.handoff,repository: f.candidates,idGenerator: () => "stale-settings",clock: () => new Date("2026-11-03"),model: { async generate(r) {
    const project = (await f.projects.findProject(f.actor,"p"))!;project.chapters[0]!.activeSourceVersionId = "missing-source";await f.projects.saveProject(f.actor,project);return settingsResponse(r);
  } } });
  const outcome = await executor.run(f.actor,task.id);assert.equal(outcome.reason,"UPSTREAM_CHANGED");assert.equal(await f.candidates.findGeneration(f.actor,"p","c",task.id),null);
});
test("settings admission defaults closed and malformed item evidence is quarantined",async () => {
  const f = await settingsFixture();
  const input = { projectId: "p",chapterId: "c",...await f.settingsSelection(),requestId: "settings-validation" };
  const disabled = new ModelTaskService({ settings: f.settings,repository: f.repository,contextReader: f.context,generationPolicy: { isAllowed: async () => true },idGenerator: () => "disabled-settings" });
  await assert.rejects(() => disabled.submitSettings(f.actor,input),{ code: "WORKSPACE_TASK_DISABLED" });
  const task = await f.tasks.submitSettings(f.actor,input);
  const executor = new SettingsTaskExecutor({ tasks: f.tasks,context: f.context,handoff: f.handoff,repository: f.candidates,idGenerator: () => "partial-settings",clock: () => new Date("2026-11-03"),model: { async generate(r) {
    const response = settingsResponse(r);response.items.push({ ...response.items[0]!,scopeKey: "invalid-location",value: { ...response.items[0]!.value,id: "invalid-location",provenance: [{ type: "source_fragment",sourceVersionId: "s",fragmentId: "not-in-source",transformation: "retained" }] } });return response;
  } } });
  const outcome = await executor.run(f.actor,task.id);assert.equal(outcome.state,"succeeded");assert.equal(outcome.result?.extractionStatus,"partially_succeeded");
  const candidate = await f.candidates.findGeneration(f.actor,"p","c",task.id);assert.deepEqual(candidate?.assets.map(a => a.id),["location"]);assert.equal(candidate?.failures[0]?.code,"INVALID_ASSET");
});

import { SettingsTaskApiModule } from "../src/settings-task-api.ts";
import { SettingsApiModule } from "../src/settings-api.ts";
test("settings Session APIs bind task identity and return pinned manuscript and script evidence",async () => {
  const f = await settingsFixture();
  const sessions = new HmacSessionManager({ secret: "0123456789abcdef0123456789abcdef",resolveActor: async userId => ({ userId,workspaceId: "w" }) });
  const ref = await Test.createTestingModule({ imports: [SettingsTaskApiModule.register({ sessionVerifier: sessions,tasks: f.tasks,rateLimiter: availableRateLimiter() }),SettingsApiModule.register({ sessionVerifier: sessions,tasks: f.tasks,repository: f.candidates,context: f.context,handoff: f.handoff,projects: f.projects,scripts: f.contentRepository })] }).compile();
  const app = ref.createNestApplication();await app.listen(0,"127.0.0.1");
  try {
    const http = request(app.getHttpServer()),auth = { authorization: `Bearer ${await sessions.issue("owner","w")}` },outsider = { authorization: `Bearer ${await sessions.issue("outsider","w")}` },base = "/projects/p/chapters/c/settings-tasks";
    const input = { ...await f.settingsSelection(),requestId: "settings-api" };
    await http.post(base).send(input).expect(401);
    await http.post(base).set(auth).send({ ...input,sourceVersionId: "forged" }).expect(400);
    await http.post(base).set(outsider).send(input).expect(404);
    const created = await http.post(base).set(auth).send(input).expect(201);
    assert.equal((await http.post(base).set(auth).send(input).expect(201)).body.id,created.body.id);
    assert.equal((await http.get(base).set(auth).expect(200)).body.tasks.length,1);
    assert.equal((await http.get(`${base}/availability`).set(auth).query(await f.settingsSelection()).expect(200)).body.available,true);
    await http.get(base).set(auth).query({ limit: "51" }).expect(400);
    const executor = new SettingsTaskExecutor({ tasks: f.tasks,context: f.context,handoff: f.handoff,repository: f.candidates,idGenerator: () => "settings-api-candidate",clock: () => new Date("2026-11-03"),model: { async generate(r) { return settingsResponse(r); } } });
    await executor.run(f.actor,created.body.id);
    const path = "/projects/p/chapters/c/settings";
    const view = await http.get(`${path}/generations/${created.body.id}`).set(auth).expect(200);
    assert.equal(view.headers["cache-control"],"no-store");assert.equal(view.body.current,true);assert.equal(view.body.sourceFragments[0].text,"雨落");assert.equal(view.body.scriptVersion.status,"confirmed");
    assert.equal(view.body.version.scriptVersionId,view.body.scriptVersion.id);
    await http.get(path).set(outsider).expect(404);
    await http.get(`/settings-tasks/${created.body.id}`).set(outsider).expect(404);
    await http.get(`/settings-tasks/${created.body.id}`).set(auth).expect(200);
    const scriptTask = (await f.repository.listScriptContent("w","p","c",{ limit: 20,cursor: null })).tasks[0]!;
    await http.get(`/settings-tasks/${scriptTask.id}`).set(auth).expect(404);
    await http.get(`${path}/generations/${scriptTask.id}`).set(auth).expect(404);
    await http.post(`/settings-tasks/${created.body.id}/run`).set(auth).expect(404);
    await http.post(`/settings-tasks/${created.body.id}/recover`).set(auth).expect(404);
    const project = (await f.projects.findProject(f.actor,"p"))!;project.chapters[0]!.activeSourceVersionId = "missing-source";await f.projects.saveProject(f.actor,project);
    const stale = await http.get(path).set(auth).expect(200);
    assert.equal(stale.body.current,false);assert.equal(stale.body.sourceFragments[0].text,"雨落");assert.equal(stale.body.scriptVersion.id,view.body.scriptVersion.id);
    assert.equal((await http.get(base).set(auth).expect(200)).body.tasks.length,1);
  } finally { await app.close(); }
});
test("settings submissions fail closed on rate denial or limiter failure without queuing tasks",async () => {
  const f = await settingsFixture();
  const sessions = new HmacSessionManager({ secret: "0123456789abcdef0123456789abcdef",resolveActor: async userId => ({ userId,workspaceId: "w" }) });
  for (const fail of [false,true]) {
    const ref = await Test.createTestingModule({ imports: [SettingsTaskApiModule.register({ sessionVerifier: sessions,tasks: f.tasks,rateLimiter: { async consume() { if (fail) throw new Error("private-storage-details");return { allowed: false,retryAfterSeconds: 17 }; } } })] }).compile();
    const app = ref.createNestApplication();await app.listen(0,"127.0.0.1");
    try {
      const response = await request(app.getHttpServer()).post("/projects/p/chapters/c/settings-tasks").set("authorization",`Bearer ${await sessions.issue("owner","w")}`).send({ ...await f.settingsSelection(),requestId: "rate-settings" }).expect(fail ? 503 : 429);
      if (!fail) assert.equal(response.headers["retry-after"],"17");
      assert.ok(!JSON.stringify(response.body).includes("private-storage-details"));assert.equal((await f.repository.scanSettings("w","run",{ limit: 20,cursor: null })).tasks.length,0);
    } finally { await app.close(); }
  }
});

import { InMemorySettingsReviewRepository,SettingsReviewService } from "@novel-adaptation/script/settings-review";
import { SettingsReviewApiModule } from "../src/settings-review-api.ts";
test("settings review Session API enforces roles and preserves formal version with auditable request recovery",async () => {
  const f = await settingsFixture();
  const project = (await f.projects.findProject(f.actor,"p"))!;project.members.push({ userId: "editor",role: "editor" },{ userId: "reviewer",role: "reviewer" });await f.projects.saveProject(f.actor,project);
  const task = await f.tasks.submitSettings(f.actor,{ projectId: "p",chapterId: "c",...await f.settingsSelection(),requestId: "review-seed" });
  await new SettingsTaskExecutor({ tasks: f.tasks,context: f.context,handoff: f.handoff,repository: f.candidates,idGenerator: () => "review-seed",clock: () => new Date("2026-11-04"),model: { async generate(r) { return settingsResponse(r); } } }).run(f.actor,task.id);
  const candidate = (await f.candidates.findGeneration(f.actor,"p","c",task.id))!,repository = new InMemorySettingsReviewRepository(f.actor,candidate);
  let sequence = 0;
  const review = new SettingsReviewService({ repository,handoff: f.handoff,access: f.projects,idGenerator: () => `settings-review-${++sequence}`,clock: () => new Date("2026-11-04") });
  const sessions = new HmacSessionManager({ secret: "0123456789abcdef0123456789abcdef",resolveActor: async userId => ({ userId,workspaceId: "w" }) });
  const ref = await Test.createTestingModule({ imports: [SettingsReviewApiModule.register({ sessionVerifier: sessions,repository,review,context: f.context }),SettingsApiModule.register({ sessionVerifier: sessions,tasks: f.tasks,repository: f.candidates,context: f.context,handoff: f.handoff,projects: f.projects,scripts: f.contentRepository,reviews: repository,review })] }).compile();
  const app = ref.createNestApplication();await app.listen(0,"127.0.0.1");
  try {
    const http = request(app.getHttpServer()),base = "/projects/p/chapters/c/settings",auth = { authorization: `Bearer ${await sessions.issue("owner","w")}` },editor = { authorization: `Bearer ${await sessions.issue("editor","w")}` },reviewer = { authorization: `Bearer ${await sessions.issue("reviewer","w")}` };
    const impacts = await http.get(`${base}/versions/${candidate.id}/impacts`).set(auth).expect(200);
    assert.deepEqual(impacts.body,{ versionId: candidate.id,impacts: null });
    const command = { kind: "edit",requestId: "api-edit",expectedActiveVersionId: candidate.id,reason: "visible",assetId: "location",value: { ...candidate.assets[0],name: "new courtyard" } };
    await http.post(`${base}/review`).send(command).expect(401);await http.post(`${base}/review`).set(editor).send(command).expect(403);
    await http.post(`${base}/review`).set(auth).send({ ...command,createdBy: "forged" }).expect(400);
    const saved = repository.save.bind(repository);let dropped = false;
    repository.save = async (a,v,expected) => { const result = await saved(a,v,expected);if (!dropped) { dropped = true;throw new Error("private-storage-ack"); }return result; };
    const unknown = await http.post(`${base}/review`).set(reviewer).send(command).expect(503);assert.ok(!JSON.stringify(unknown.body).includes("private-storage-ack"));
    const recovered = await http.get(`${base}/operations/api-edit`).set(reviewer).expect(200);let version = recovered.body.version;
    assert.equal(recovered.headers["cache-control"],"no-store");assert.equal((await http.post(`${base}/review`).set(reviewer).send(command).expect(201)).body.id,version.id);
    await http.get(`${base}/operations/api-edit`).set(editor).expect(404);
    const view = await http.get(base).set(editor).expect(200);assert.equal(view.body.version.id,version.id);assert.equal(view.body.permissions.canEdit,false);assert.equal(view.body.permissions.canSuggest,true);
    version = (await http.post(`${base}/review`).set(editor).send({ kind: "suggest",requestId: "api-suggest",expectedActiveVersionId: version.id,reason: "detail",assetId: "location",value: candidate.assets[0] }).expect(201)).body;
    await http.post(`${base}/review`).set(auth).send({ kind: "confirm",requestId: "blocked-confirm",expectedActiveVersionId: version.id,reason: "check" }).expect(409);
    version = (await http.post(`${base}/review`).set(auth).send({ kind: "decide",requestId: "api-accept",expectedActiveVersionId: version.id,reason: "checked",suggestionId: version.suggestions[0].id,decision: "accepted" }).expect(201)).body;
    version = (await http.post(`${base}/review`).set(reviewer).send({ kind: "confirm",requestId: "api-confirm",expectedActiveVersionId: version.id,reason: "checked" }).expect(201)).body;
    const formalId = version.id;assert.equal((await http.get(`${base}/versions/confirmed`).set(auth).expect(200)).body.version.id,formalId);
    version = (await http.post(`${base}/review`).set(auth).send({ kind: "lock",requestId: "api-lock",expectedActiveVersionId: version.id,reason: "freeze",assetId: "location" }).expect(201)).body;
    await http.post(`${base}/review`).set(editor).send({ ...command,kind: "suggest",requestId: "locked-suggest",expectedActiveVersionId: version.id }).expect(409);
    version = (await http.post(`${base}/review`).set(auth).send({ kind: "unlock",requestId: "api-unlock",expectedActiveVersionId: version.id,reason: "revision",assetId: "location" }).expect(201)).body;
    const retained = version.id;
    version = (await http.post(`${base}/review`).set(editor).send({ ...command,kind: "suggest",requestId: "formal-suggest",expectedActiveVersionId: version.id }).expect(201)).body;
    const pending = version.suggestions.find((s: { status: string }) => s.status === "pending");const formalWithSuggestion = version.id;
    version = (await http.post(`${base}/review`).set(auth).send({ kind: "decide",requestId: "formal-accept",expectedActiveVersionId: version.id,reason: "checked",suggestionId: pending.id,decision: "accepted" }).expect(201)).body;
    assert.equal(version.status,"candidate");assert.equal((await http.get(`${base}/versions/confirmed`).set(auth).expect(200)).body.version.id,formalWithSuggestion);
    assert.equal((await http.get(`${base}/versions/${retained}`).set(auth).expect(200)).body.version.status,"confirmed");
    await http.get(base).set({ authorization: `Bearer ${await sessions.issue("outsider","w")}` }).expect(404);
    await http.get(`${base}/versions/confirmed`).set({ authorization: `Bearer ${await sessions.issue("outsider","w")}` }).expect(404);
    const original = await http.get(`${base}/generations/${task.id}`).set(auth).expect(200);
    assert.equal(original.body.version.id,candidate.id);assert.equal(original.body.active,false);assert.equal(original.body.permissions.canEdit,false);
  } finally { await app.close(); }
});

import { InMemorySettingsRegenerationRepository,type SettingsRegenerationRequest } from "@novel-adaptation/script/settings-regeneration";
import { SettingsRegenerationTaskContext,SettingsRegenerationTaskExecutor } from "../src/settings-regeneration-task-executor.ts";
async function regenerationTaskFixture() {
  const f = await settingsFixture();
  const initial = await f.tasks.submitSettings(f.actor,{ projectId: "p",chapterId: "c",...await f.settingsSelection(),requestId: "regeneration-base" });
  await new SettingsTaskExecutor({ tasks: f.tasks,context: f.context,handoff: f.handoff,repository: f.candidates,idGenerator: () => "regeneration-base",clock: () => new Date("2026-11-04"),model: { async generate(r) { return settingsResponse(r); } } }).run(f.actor,initial.id);
  const candidate = (await f.candidates.findGeneration(f.actor,"p","c",initial.id))!,reviews = new InMemorySettingsReviewRepository(f.actor,candidate);
  const results = new InMemorySettingsRegenerationRepository(reviews,f.handoff,f.projects),context = new SettingsRegenerationTaskContext(f.context,results,f.projects);
  const tasks = new ModelTaskService({ settings: f.settings,repository: f.repository,contextReader: context,settingsAdmission: { workspaceIds: ["w"],providerIds: ["deepseek"] },generationPolicy: { isAllowed: async () => true },idGenerator: () => "unused" });
  const input = { projectId: "p",chapterId: "c",...await f.settingsSelection(),requestId: "regeneration",selection: { expectedActiveVersionId: candidate.id,assetIds: ["location"],failureScopeKeys: [],reason: "visible" } };
  return { ...f,results,context,tasks,input,reviews };
}
function regenerationResponse(r: SettingsRegenerationRequest) {
  return { ...settingsResponse(r),items: r.regeneration.targets.map(t => ({ scopeKey: t.scopeKey,status: "succeeded",value: { ...t.asset!,name: "regenerated courtyard" } })) };
}
test("settings regeneration task recovers a saved result after lost acknowledgement without another model invocation",async () => {
  const f = await regenerationTaskFixture();let calls = 0;
  const task = await f.tasks.submitSettingsRegeneration(f.actor,f.input);
  assert.equal((await f.tasks.submitSettingsRegeneration(f.actor,f.input)).id,task.id);
  const save = f.results.saveGeneration.bind(f.results);
  f.results.saveGeneration = async (a,v,expected) => { await save(a,v,expected);throw new Error("lost acknowledgement"); };
  const executor = new SettingsRegenerationTaskExecutor({ tasks: f.tasks,context: f.context,handoff: f.handoff,repository: f.results,access: f.projects,idGenerator: () => "regenerated-version",clock: () => new Date("2026-11-04"),model: { async generate(r) { calls++;return regenerationResponse(r); } } });
  const result = await executor.run(f.actor,task.id);assert.equal(result.reason,"EXECUTION_UNCERTAIN");
  await assert.rejects(() => executor.run(f.actor,task.id),{ code: "STATE_CONFLICT" });
  const find = f.results.findGeneration.bind(f.results);
  f.results.findGeneration = async (a,p,c,id) => { const v = await find(a,p,c,id);return v ? { ...v,parentVersionId: "forged-base" } : null; };
  await assert.rejects(() => executor.recover(f.actor,task.id),{ code: "STATE_CONFLICT" });
  f.results.findGeneration = find;
  const recovered = await new SettingsRegenerationTaskDispatcher({ repository: f.repository,executor }).tick("w","recover");
  assert.equal(recovered.items[0]?.state,"succeeded");assert.equal((await f.tasks.get(f.actor,task.id)).result?.candidateVersionId,"regenerated-version");assert.equal(calls,1);
  assert.equal((await f.repository.scanSettingsRegeneration("w","run",{ limit: 20,cursor: null })).tasks.length,0);
});
test("unknown regeneration without a saved result cannot run, resubmit or bypass the guard with a new request",async () => {
  const f = await regenerationTaskFixture();let calls = 0;
  const task = await f.tasks.submitSettingsRegeneration(f.actor,f.input);
  const executor = new SettingsRegenerationTaskExecutor({ tasks: f.tasks,context: f.context,handoff: f.handoff,repository: f.results,access: f.projects,idGenerator: () => "never-saved",clock: () => new Date("2026-11-04"),model: { async generate() { calls++;throw new Error("unknown provider execution"); } } });
  const result = await executor.run(f.actor,task.id);assert.equal(result.state,"paused");assert.equal(result.reason,"EXECUTION_UNCERTAIN");
  await assert.rejects(() => executor.run(f.actor,task.id),{ code: "STATE_CONFLICT" });
  await assert.rejects(async () => f.tasks.resubmit(f.actor,task.id,await f.settingsSelection()),{ code: "STATE_CONFLICT" });
  await assert.rejects(() => f.tasks.submitSettingsRegeneration(f.actor,{ ...f.input,requestId: "bypass" }),{ code: "STATE_CONFLICT" });
  await assert.rejects(() => executor.recover(f.actor,task.id),{ code: "STATE_CONFLICT" });assert.equal(calls,1);
  assert.equal((await f.repository.scanSettingsRegeneration("w","recover",{ limit: 20,cursor: null })).tasks[0]?.id,task.id);
  assert.equal((await f.repository.scanSettings("w","recover",{ limit: 20,cursor: null })).tasks.length,0);
});
test("regeneration task admission stays closed by default and changed project parameters discard generated output",async () => {
  const f = await regenerationTaskFixture();
  const disabled = new ModelTaskService({ settings: f.settings,repository: f.repository,contextReader: f.context,generationPolicy: { isAllowed: async () => true },idGenerator: () => "disabled" });
  await assert.rejects(() => disabled.submitSettingsRegeneration(f.actor,f.input),{ code: "WORKSPACE_TASK_DISABLED" });
  const task = await f.tasks.submitSettingsRegeneration(f.actor,f.input);let calls = 0;
  const executor = new SettingsRegenerationTaskExecutor({ tasks: f.tasks,context: f.context,handoff: f.handoff,repository: f.results,access: f.projects,idGenerator: () => "stale-regeneration",clock: () => new Date("2026-11-04"),model: { async generate(r) {
    calls++;const project = (await f.projects.findProject(f.actor,"p"))!;project.targetDurationSeconds = 180;await f.projects.saveProject(f.actor,project);return regenerationResponse(r);
  } } });
  const result = await executor.run(f.actor,task.id);assert.equal(result.reason,"UPSTREAM_CHANGED");assert.equal(calls,1);assert.equal(await f.results.findGeneration(f.actor,"p","c",task.id),null);
});

import { SettingsRegenerationTaskApiModule } from "../src/settings-regeneration-task-api.ts";
test("settings regeneration Session API submits exact targets and reconciles original requests without execution endpoints",async () => {
  const f = await regenerationTaskFixture();let calls = 0;
  const project = (await f.projects.findProject(f.actor,"p"))!;project.members.push({ userId: "editor",role: "editor" });await f.projects.saveProject(f.actor,project);
  const sessions = new HmacSessionManager({ secret: "0123456789abcdef0123456789abcdef",resolveActor: async userId => ({ userId,workspaceId: "w" }) });
  const ref = await Test.createTestingModule({ imports: [SettingsRegenerationTaskApiModule.register({ sessionVerifier: sessions,tasks: f.tasks,rateLimiter: availableRateLimiter() }),SettingsApiModule.register({ sessionVerifier: sessions,tasks: f.tasks,repository: f.candidates,reviews: f.reviews,context: f.context,handoff: f.handoff,projects: f.projects,scripts: f.contentRepository,regeneration: { tasks: f.tasks,repository: f.results } })] }).compile();
  const app = ref.createNestApplication();await app.listen(0,"127.0.0.1");
  try {
    const http = request(app.getHttpServer()),auth = { authorization: `Bearer ${await sessions.issue("owner","w")}` },outsider = { authorization: `Bearer ${await sessions.issue("outsider","w")}` },editor = { authorization: `Bearer ${await sessions.issue("editor","w")}` },base = "/projects/p/chapters/c/settings-regeneration-tasks";
    const body = { configurationVersionId: f.input.configurationVersionId,modelId: f.input.modelId,requestId: f.input.requestId,selection: f.input.selection };
    await http.post(base).send(body).expect(401);
    await http.post(base).set(auth).send({ ...body,sourceVersionId: "forged" }).expect(400);
    await http.post(base).set(auth).send({ ...body,selection: { ...body.selection,assetIds: [] } }).expect(400);
    await http.post(base).set(outsider).send(body).expect(404);
    await http.post(base).set(editor).send(body).expect(403);
    assert.equal((await http.post(`${base}/availability`).set(auth).send({ configurationVersionId: body.configurationVersionId,modelId: body.modelId,selection: body.selection }).expect(201)).body.available,true);
    assert.equal((await http.get(base).set(auth).expect(200)).body.tasks.length,0);
    const created = (await http.post(base).set(auth).send(body).expect(201)).body;
    const lookup = await http.get(`${base}/submissions/${body.requestId}`).set(auth).expect(200);
    assert.equal(lookup.body.id,created.id);assert.equal(lookup.headers["cache-control"],"no-store");
    assert.equal((await http.post(base).set(auth).send(body).expect(201)).body.id,created.id);
    await http.post(base).set(auth).send({ ...body,selection: { ...body.selection,reason: "different" } }).expect(409);
    await http.get(`${base}/submissions/${body.requestId}`).set(editor).expect(404);
    await http.get(base).set(outsider).expect(404);
    await http.get(base).set(auth).query({ limit: "51" }).expect(400);
    assert.equal((await http.get(base).set(auth).expect(200)).body.tasks.length,1);
    const resultPath = `/projects/p/chapters/c/settings/regenerations/${created.id}`;
    await http.get(resultPath).set(auth).expect(404);
    const executor = new SettingsRegenerationTaskExecutor({ tasks: f.tasks,context: f.context,repository: f.results,handoff: f.handoff,access: f.projects,idGenerator: () => "api-regeneration",clock: () => new Date("2026-11-04"),model: { async generate(r) { calls++;return regenerationResponse(r); } } });
    await executor.run(f.actor,created.id);
    const view = await http.get(resultPath).set(auth).expect(200);
    assert.equal(view.body.version.id,"api-regeneration");assert.equal(view.body.sourceFragments[0].text,"雨落");assert.equal(view.body.scriptVersion.id,view.body.version.scriptVersionId);assert.equal(view.body.current,true);assert.equal(view.body.active,true);
    assert.equal((await http.get(`/settings-regeneration-tasks/${created.id}`).set(auth).expect(200)).body.state,"succeeded");
    await http.get(`/settings-regeneration-tasks/${created.id}`).set(outsider).expect(404);
    await http.get(resultPath).set(editor).expect(404);
    await http.post(`/settings-regeneration-tasks/${created.id}/run`).set(auth).expect(404);
    await http.post(`/settings-regeneration-tasks/${created.id}/recover`).set(auth).expect(404);
    const original = await http.get(`${base}/submissions/${body.requestId}`).set(auth).expect(200);
    assert.equal(original.body.result.candidateVersionId,"api-regeneration");assert.equal(calls,1);
    const changed = (await f.projects.findProject(f.actor,"p"))!;changed.chapters[0]!.activeSourceVersionId = "new-source";await f.projects.saveProject(f.actor,changed);
    const stale = await http.get(resultPath).set(auth).expect(200);
    assert.equal(stale.body.current,false);assert.equal(stale.body.sourceFragments[0].text,"雨落");
    assert.equal((await http.get(base).set(auth).expect(200)).body.tasks.length,1);
  } finally { await app.close(); }
});

test("settings regeneration Session submissions fail closed on denied or unavailable rate budgets",async () => {
  const f = await regenerationTaskFixture();
  const sessions = new HmacSessionManager({ secret: "0123456789abcdef0123456789abcdef",resolveActor: async userId => ({ userId,workspaceId: "w" }) });
  for (const unavailable of [false,true]) {
    const ref = await Test.createTestingModule({ imports: [SettingsRegenerationTaskApiModule.register({ sessionVerifier: sessions,tasks: f.tasks,rateLimiter: { async consume() { if (unavailable) throw new Error("private-storage-details");return { allowed: false,retryAfterSeconds: 13 }; } } })] }).compile();
    const app = ref.createNestApplication();await app.listen(0,"127.0.0.1");
    try {
      const response = await request(app.getHttpServer()).post("/projects/p/chapters/c/settings-regeneration-tasks").set("authorization",`Bearer ${await sessions.issue("owner","w")}`).send({ configurationVersionId: f.input.configurationVersionId,modelId: f.input.modelId,requestId: f.input.requestId,selection: f.input.selection }).expect(unavailable ? 503 : 429);
      if (!unavailable) assert.equal(response.headers["retry-after"],"13");
      assert.ok(!JSON.stringify(response.body).includes("private-storage-details"));
      assert.equal((await f.tasks.listSettingsRegeneration(f.actor,"p","c")).tasks.length,0);
    } finally { await app.close(); }
  }
});
test("settings regeneration Session reconciliation never reexecutes unknown model work or admits a new request for that base",async () => {
  const f = await regenerationTaskFixture();let calls = 0;
  const sessions = new HmacSessionManager({ secret: "0123456789abcdef0123456789abcdef",resolveActor: async userId => ({ userId,workspaceId: "w" }) });
  const ref = await Test.createTestingModule({ imports: [SettingsRegenerationTaskApiModule.register({ sessionVerifier: sessions,tasks: f.tasks,rateLimiter: availableRateLimiter() })] }).compile();
  const app = ref.createNestApplication();await app.listen(0,"127.0.0.1");
  try {
    const http = request(app.getHttpServer()),auth = { authorization: `Bearer ${await sessions.issue("owner","w")}` },base = "/projects/p/chapters/c/settings-regeneration-tasks";
    const body = { configurationVersionId: f.input.configurationVersionId,modelId: f.input.modelId,requestId: f.input.requestId,selection: f.input.selection };
    const created = (await http.post(base).set(auth).send(body).expect(201)).body;
    const executor = new SettingsRegenerationTaskExecutor({ tasks: f.tasks,context: f.context,repository: f.results,handoff: f.handoff,access: f.projects,idGenerator: () => "unused",clock: () => new Date("2026-11-04"),model: { async generate() { calls++;throw new Error("uncertain-provider-details"); } } });
    assert.equal((await executor.run(f.actor,created.id)).reason,"EXECUTION_UNCERTAIN");
    const original = await http.get(`${base}/submissions/${body.requestId}`).set(auth).expect(200);
    assert.equal(original.body.reason,"EXECUTION_UNCERTAIN");assert.ok(!JSON.stringify(original.body).includes("uncertain-provider-details"));
    assert.equal((await http.post(base).set(auth).send(body).expect(201)).body.id,created.id);
    await http.post(base).set(auth).send({ ...body,requestId: "new-request" }).expect(409);
    await http.post(`/settings-regeneration-tasks/${created.id}/run`).set(auth).expect(404);
    await http.post(`/settings-regeneration-tasks/${created.id}/recover`).set(auth).expect(404);
    assert.equal(calls,1);
  } finally { await app.close(); }
});
