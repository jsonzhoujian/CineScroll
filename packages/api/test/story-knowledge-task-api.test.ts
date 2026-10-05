import assert from "node:assert/strict";
import test from "node:test";
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { HmacSessionManager } from "@novel-adaptation/identity";
import { InMemoryProjectImportRepository } from "@novel-adaptation/project-import";
import { WorkspaceModelSettings, InMemoryModelSettingsRepository } from "@novel-adaptation/script/model-settings";
import { ModelTaskService, InMemoryModelTaskRepository } from "@novel-adaptation/script/model-tasks";
import { StoryKnowledgeTaskContext } from "../src/story-knowledge-task-context.ts";
import { StoryKnowledgeTaskApiModule } from "../src/story-knowledge-task-api.ts";
import { StoryKnowledgeTaskExecutor } from "../src/story-knowledge-task-executor.ts";
import { InMemoryStoryKnowledgeRepository, StoryKnowledgeService } from "@novel-adaptation/story-knowledge";

test("故事知识任务从授权原文生成输入，不接受客户端版本；旧Key暂停后显式重提交", async () => {
  const owner = { userId: "owner", workspaceId: "w" };
  const projects = new InMemoryProjectImportRepository();
  await projects.saveProject(owner, { id: "p", workspaceId: "w", ownerUserId: "owner", members: [{ userId: "owner", role: "owner" }],
    title: "fixture", aspectRatio: "9:16", targetDurationSeconds: 180, narrativeMode: "narration", dataRegion: "CN", createdAt: "2026-10-05",
    chapters: [{ id: "c", title: "chapter", activeSourceVersionId: "source1", versions: [{ id: "source1", ordinal: 1, createdAt: "2026-10-05", createdBy: "owner", characterCount: 2, text: "雨落", fragments: [{ id: "f", ordinal: 1, startOffset: 0, endOffset: 2, text: "雨落", contentHash: "hash" }] }] }] });
  let version = 0, job = 0;
  const settings = new WorkspaceModelSettings({ repository: new InMemoryModelSettingsRepository(), encryptionKey: new Uint8Array(32).fill(7),
    access: { read: async actor => actor.userId === "owner" ? { owner: true, advanced: true } : null }, idGenerator: () => `v${++version}`,
    probe: { processingRegion: () => "mainland", test: async () => ({ modelIds: ["m"], processingRegion: "mainland" }) } });
  const saved = await settings.configure(owner, { expectedVersionId: null, providerId: "deepseek", apiKey: "fixture-key" });
  const tested = await settings.testConnection(owner, saved.id);
  let now = Date.now();
  const taskRepository = new InMemoryModelTaskRepository(() => now);
  const tasks = new ModelTaskService({ settings, repository: taskRepository, contextReader: new StoryKnowledgeTaskContext(projects), idGenerator: () => `j${++job}` });
  const sessions = new HmacSessionManager({ secret: "0123456789abcdef0123456789abcdef", resolveActor: async userId => ({ userId, workspaceId: "w" }) });
  const ref = await Test.createTestingModule({ imports: [StoryKnowledgeTaskApiModule.register({ sessionVerifier: sessions, tasks })] }).compile();
  const app = ref.createNestApplication(); await app.listen(0, "127.0.0.1");
  try {
    const http = request(app.getHttpServer()), bearer = `Bearer ${await sessions.issue("owner", "w")}`;
    const path = "/projects/p/chapters/c/story-knowledge-tasks";
    const selection = { configurationVersionId: tested.id, modelId: "m" };
    await http.post(path).send(selection).expect(401);
    await http.post(path).set("authorization", bearer).send({ ...selection, sourceVersionId: "forged" }).expect(400);
    await http.post(`/projects/${"p".repeat(257)}/chapters/c/story-knowledge-tasks`).set("authorization", bearer).send(selection).expect(400);
    await http.get(`/story-knowledge-tasks/${"j".repeat(257)}`).set("authorization", bearer).expect(400);
    await http.post(path).set("authorization", `Bearer ${await sessions.issue("outsider", "w")}`).send(selection).expect(404);
    const created = await http.post(path).set("authorization", bearer).send(selection).expect(201);
    assert.equal(created.body.input.stage, "story_knowledge"); assert.equal(created.body.input.sourceVersionId, "source1");
    assert.deepEqual(created.body.input.upstreamConfirmedVersionIds, []); assert.equal(created.body.state, "queued");
    assert.equal(created.headers["cache-control"], "no-store"); assert.ok(!JSON.stringify(created.body).includes("fixture-key"));
    await http.get(`/story-knowledge-tasks/${created.body.id}`).set("authorization", bearer).expect(200);
    const changed = await settings.configure(owner, { expectedVersionId: tested.id, providerId: "deepseek", apiKey: "new-fixture" });
    const next = await settings.testConnection(owner, changed.id);
    assert.equal((await tasks.run(owner, created.body.id, async () => { throw new Error("must not execute"); })).state, "paused");
    const child = await http.post(`/story-knowledge-tasks/${created.body.id}/resubmit`).set("authorization", bearer).send({ configurationVersionId: next.id, modelId: "m" }).expect(201);
    assert.deepEqual(child.body.input, created.body.input); assert.equal(child.body.parentTaskId, created.body.id);
    await http.post(`/story-knowledge-tasks/${created.body.id}/resubmit`).set("authorization", bearer).send({ configurationVersionId: next.id, modelId: "m" }).expect(409);
    await http.get(`/story-knowledge-tasks/${created.body.id}`).set("authorization", `Bearer ${await sessions.issue("outsider", "w")}`).expect(404);
    const knowledge = new StoryKnowledgeService({ repository: new InMemoryStoryKnowledgeRepository(), projectAccessReader: projects,
      sourceReader: { async findSourceVersion(actor, projectId, chapterId, sourceVersionId) {
        if (!await projects.findProjectAccess(actor, projectId)) return null;
        const chapter = await projects.findChapter(actor, projectId, chapterId);
        const source = chapter?.versions.find(version => version.id === sourceVersionId);
        return source ? { id: source.id, fragmentIds: source.fragments.map(fragment => fragment.id) } : null;
      } }, idGenerator: () => `k${++version}`, clock: () => new Date("2026-10-05") });
    const executor = new StoryKnowledgeTaskExecutor({ tasks, projects, storyKnowledge: knowledge,
      model: { async generate(input, credentials) {
        assert.equal(credentials.apiKey, "new-fixture");
        assert.deepEqual(input.input.sourceFragments, [{ id: "f", text: "雨落" }]);
        return { contractVersion: "0.1.0", jobId: input.jobId, stage: "storyKnowledge", projectId: "p", chapterId: "c", sourceVersionId: "source1",
          status: "partially_succeeded", items: [
            { scopeKey: "weather", status: "succeeded", value: { id: "rain", factType: "worldRule", statement: "正在下雨", assertionKind: "explicit", resolutionStatus: "resolved", resolutionGroupId: null, evidence: [{ sourceVersionId: "source1", fragmentId: "f" }] } },
            { scopeKey: "identity", status: "failed", error: { code: "UNKNOWN", message: "无法确定", retryable: true } },
          ] };
      } } });
    assert.equal((await executor.run(owner, child.body.id)).state, "succeeded");
    const candidate = await knowledge.getActive(owner, "p", "c");
    assert.deepEqual((await tasks.get(owner, child.body.id)).result, { candidateVersionId: candidate.id, extractionStatus: "partially_succeeded" });
    const read = await http.get(`/story-knowledge-tasks/${child.body.id}`).set("authorization", bearer).expect(200);
    assert.equal(read.body.result.extractionStatus, "partially_succeeded");
    assert.ok(!JSON.stringify(read.body).includes("new-fixture"));
    assert.equal(candidate.extractionStatus, "partially_succeeded");
    assert.equal(candidate.status, "candidate");
    assert.deepEqual(candidate.facts.map(fact => fact.id), ["rain"]);
    assert.deepEqual(candidate.failures.map(failure => failure.scopeKey), ["identity"]);
    await assert.rejects(() => executor.run(owner, child.body.id), { code: "STATE_CONFLICT" });
    const blocked = await tasks.submit(owner, { projectId: "p", chapterId: "c", configurationVersionId: next.id, modelId: "m" });
    assert.equal((await executor.run(owner, blocked.id)).reason, "CANDIDATE_EXISTS");
    assert.equal((await knowledge.getActive(owner, "p", "c")).id, candidate.id);
    const recoveryKnowledge = new StoryKnowledgeService({ repository: new InMemoryStoryKnowledgeRepository(), projectAccessReader: projects,
      sourceReader: { async findSourceVersion(actor, projectId, chapterId, sourceVersionId) {
        if (!await projects.findProjectAccess(actor, projectId)) return null;
        return { id: sourceVersionId, fragmentIds: ["f"] };
      } }, idGenerator: () => `recovered${++version}`, clock: () => new Date("2026-10-05") });
    const crashed = await tasks.submit(owner, { projectId: "p", chapterId: "c", configurationVersionId: next.id, modelId: "m" });
    await taskRepository.transition("w", crashed.id, 0, "running", null);
    const savedCandidate = await recoveryKnowledge.recordExtraction(owner, {
      contractVersion: "0.1.0", jobId: crashed.id, stage: "storyKnowledge", projectId: "p", chapterId: "c", sourceVersionId: "source1", status: "failed",
      items: [{ scopeKey: "identity", status: "failed", error: { code: "UNKNOWN", message: "无法确定", retryable: true } }],
    });
    let recoveryModelCalls = 0;
    const recovery = new StoryKnowledgeTaskExecutor({ tasks, projects, storyKnowledge: recoveryKnowledge,
      model: { async generate() { recoveryModelCalls++; throw new Error("must not resend"); } } });
    await assert.rejects(() => recovery.recover(owner, crashed.id), { code: "STATE_CONFLICT" });
    now += 600_001;
    const repaired = await recovery.recover(owner, crashed.id);
    assert.equal(repaired.state, "succeeded"); assert.equal(repaired.result?.candidateVersionId, savedCandidate.id);
    assert.equal(repaired.result?.extractionStatus, "failed");
    const unknown = await tasks.submit(owner, { projectId: "p", chapterId: "c", configurationVersionId: next.id, modelId: "m" });
    await taskRepository.transition("w", unknown.id, 0, "running", null);
    now += 600_001;
    assert.equal((await recovery.recover(owner, unknown.id)).reason, "EXECUTION_UNCERTAIN");
    await http.post(`/story-knowledge-tasks/${unknown.id}/resubmit`).set("authorization", bearer).send({ configurationVersionId: next.id, modelId: "m" }).expect(409);
    await assert.rejects(() => recovery.recover({ userId: "outsider", workspaceId: "w" }, unknown.id), { code: "TASK_NOT_FOUND" });
    assert.equal(recoveryModelCalls, 0);
    const competingKnowledge = new StoryKnowledgeService({ repository: new InMemoryStoryKnowledgeRepository(), projectAccessReader: projects,
      sourceReader: { async findSourceVersion() { return { id: "source1", fragmentIds: ["f"] }; } },
      idGenerator: () => `race${++version}`, clock: () => new Date("2026-10-05") });
    let release!: () => void, ready!: () => void, running = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const bothStarted = new Promise<void>(resolve => { ready = resolve; });
    const competing = new StoryKnowledgeTaskExecutor({ tasks, projects, storyKnowledge: competingKnowledge,
      model: { async generate(input) {
        if (++running === 2) ready();
        await gate;
        return { contractVersion: "0.1.0", jobId: input.jobId, stage: "storyKnowledge", projectId: "p", chapterId: "c", sourceVersionId: "source1", status: "failed",
          items: [{ scopeKey: "identity", status: "failed", error: { code: "UNKNOWN", message: "无法确定", retryable: true } }] };
      } } });
    const first = await tasks.submit(owner, { projectId: "p", chapterId: "c", configurationVersionId: next.id, modelId: "m" });
    const second = await tasks.submit(owner, { projectId: "p", chapterId: "c", configurationVersionId: next.id, modelId: "m" });
    const competingRuns = Promise.all([competing.run(owner, first.id), competing.run(owner, second.id)]);
    await bothStarted; release();
    const outcomes = await competingRuns;
    assert.equal(outcomes.filter(outcome => outcome.state === "succeeded").length, 1);
    assert.equal(outcomes.find(outcome => outcome.state !== "succeeded")?.reason, "CANDIDATE_EXISTS");
    assert.equal(outcomes.find(outcome => outcome.state === "succeeded")?.result?.extractionStatus, "failed");
    for (const mode of ["wrong-envelope", "provider-error", "source-changed"] as const) {
      const isolated = new StoryKnowledgeService({ repository: new InMemoryStoryKnowledgeRepository(), projectAccessReader: projects,
        sourceReader: { async findSourceVersion() { return { id: "source1", fragmentIds: ["f"] }; } },
        idGenerator: () => `isolated${++version}`, clock: () => new Date("2026-10-05") });
      const queued = await tasks.submit(owner, { projectId: "p", chapterId: "c", configurationVersionId: next.id, modelId: "m" });
      const invalid = new StoryKnowledgeTaskExecutor({ tasks, projects, storyKnowledge: isolated,
        model: { async generate(input) {
          if (mode === "provider-error") throw new Error("new-fixture: vendor private response");
          if (mode === "source-changed") {
            const project = (await projects.findProject(owner, "p"))!;
            project.chapters[0]!.activeSourceVersionId = "source2";
            await projects.saveProject(owner, project);
          }
          return { contractVersion: "0.1.0", jobId: mode === "wrong-envelope" ? "forged" : input.jobId,
            stage: "storyKnowledge", projectId: "p", chapterId: "c", sourceVersionId: "source1", status: "failed", items: [] };
        } } });
      const outcome = await invalid.run(owner, queued.id);
      assert.equal(outcome.state, mode === "source-changed" ? "paused" : "failed");
      assert.equal(outcome.reason, mode === "source-changed" ? "UPSTREAM_CHANGED" : mode === "wrong-envelope" ? "INVALID_RESPONSE" : "PROVIDER_UNAVAILABLE");
      assert.equal(outcome.result, null);
      assert.ok(!JSON.stringify(outcome).includes("new-fixture"));
      await assert.rejects(() => isolated.getActive(owner, "p", "c"), { code: "STAGE_RESULT_NOT_FOUND" });
    }
  } finally { await app.close(); }
});
