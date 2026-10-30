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
import { InMemoryScriptContentRepository, ScriptContentService } from "@novel-adaptation/script/script-content";

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
