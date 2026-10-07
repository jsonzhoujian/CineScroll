import assert from "node:assert/strict";
import test from "node:test";
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { HmacSessionManager } from "@novel-adaptation/identity";
import { InMemoryProjectImportRepository } from "@novel-adaptation/project-import";
import { InMemoryStoryKnowledgeRepository, StoryKnowledgeService } from "@novel-adaptation/story-knowledge";
import { WorkspaceModelSettings, InMemoryModelSettingsRepository } from "@novel-adaptation/script/model-settings";
import { ModelTaskService, InMemoryModelTaskRepository } from "@novel-adaptation/script/model-tasks";
import { StoryKnowledgeTaskContext } from "../src/story-knowledge-task-context.ts";
import { StoryKnowledgeRetryPlanner } from "../src/story-knowledge-retry-planner.ts";
import { StoryKnowledgeTaskApiModule } from "../src/story-knowledge-task-api.ts";
import { availableRateLimiter } from "./rate-limit-fixture.ts";
import { StoryKnowledgeTaskExecutor } from "../src/story-knowledge-task-executor.ts";

test("认证局部重试持久化可信快照，重复提交返回同一任务且不能更换范围", async () => {
  const h = await harness();
  try {
    const path = "/projects/p/chapters/c/story-knowledge-tasks/retries";
    const http = request(h.app.getHttpServer()), auth = { authorization: `Bearer ${await h.sessions.issue("owner", "w")}` };
    const input = { expectedActiveVersionId: h.candidate.id, scopeKeys: ["identity"], configurationVersionId: h.config.id, modelId: "m", requestId: "intent-1" };
    await http.post(path).send(input).expect(401);
    await http.post(path).set("authorization", `Bearer ${await h.sessions.issue("outsider", "w")}`).send(input).expect(404);
    await http.post(path).set(auth).send({ ...input, retryOfJobId: "forged" }).expect(400);
    const created = await http.post(path).set(auth).send(input).expect(201);
    assert.deepEqual(created.body.input.retry, { expectedActiveVersionId: h.candidate.id, retryOfJobId: "origin", scopeKeys: ["identity"] });
    assert.equal(created.body.input.sourceVersionId, "s");
    assert.equal(created.body.state, "queued");
    const duplicate = await http.post(path).set(auth).send(input).expect(201);
    assert.equal(duplicate.body.id, created.body.id);
    await http.post(path).set(auth).send({ ...input, scopeKeys: ["identity", "props"] }).expect(409);
    assert.ok(!JSON.stringify(created.body).includes("fixture-key"));
    assert.equal((await h.tasks.get(h.owner, created.body.id)).input.retry?.retryOfJobId, "origin");
  } finally { await h.app.close(); }
});

async function harness() {
  const owner = { userId: "owner", workspaceId: "w" };
  const projects = new InMemoryProjectImportRepository();
  await projects.saveProject(owner, { id: "p", workspaceId: "w", ownerUserId: "owner", members: [{ userId: "owner", role: "owner" }], title: "作品",
    aspectRatio: "9:16", targetDurationSeconds: 180, narrativeMode: "narration", dataRegion: "CN", createdAt: "2026-10-06",
    chapters: [{ id: "c", title: "章", activeSourceVersionId: "s", versions: [{ id: "s", ordinal: 1, createdAt: "2026-10-06", createdBy: "owner", characterCount: 2,
      text: "雨落", fragments: [{ id: "f", ordinal: 1, startOffset: 0, endOffset: 2, text: "雨落", contentHash: "hash" }] }] }] });
  let seq = 0, now = Date.now();
  const knowledge = new StoryKnowledgeService({ repository: new InMemoryStoryKnowledgeRepository(), projectAccessReader: projects,
    sourceReader: { async findSourceVersion(actor, p, c, s) { const chapter = await projects.findChapter(actor, p, c); const source = chapter?.versions.find(v => v.id === s); return source ? { id: source.id, fragmentIds: source.fragments.map(f => f.id) } : null; } },
    idGenerator: () => `k${++seq}`, clock: () => new Date(now) });
  const candidate = await knowledge.recordExtraction(owner, envelope("origin", [
    { scopeKey: "weather", status: "succeeded", value: { id: "rain", factType: "worldRule", statement: "雨落", assertionKind: "explicit", resolutionStatus: "resolved", resolutionGroupId: null, evidence: [{ sourceVersionId: "s", fragmentId: "f" }] } },
    ...["identity", "props"].map(scopeKey => ({ scopeKey, status: "failed", error: { code: "UNKNOWN", message: "待查", retryable: true } })),
  ]));
  const settings = new WorkspaceModelSettings({ repository: new InMemoryModelSettingsRepository(), encryptionKey: new Uint8Array(32).fill(7), access: { read: async actor => actor.userId === "owner" ? { owner: true, advanced: true } : null },
    idGenerator: () => `cfg${++seq}`, probe: { processingRegion: () => "mainland", test: async () => ({ modelIds: ["m"], processingRegion: "mainland" }) } });
  const saved = await settings.configure(owner, { expectedVersionId: null, providerId: "deepseek", apiKey: "fixture-key" });
  const config = await settings.testConnection(owner, saved.id);
  const repository = new InMemoryModelTaskRepository(() => now, () => ({ maxQueued: 100, maxExecuting: 100 }));
  const planner = new StoryKnowledgeRetryPlanner({ projects, storyKnowledge: knowledge });
  const tasks = new ModelTaskService({ settings, repository, contextReader: new StoryKnowledgeTaskContext(projects, planner),
    storyAdmission: { workspaceIds: ["w"], providerIds: ["deepseek"] }, generationPolicy: { isAllowed: async () => true }, idGenerator: () => `j${++seq}` });
  const sessions = new HmacSessionManager({ secret: "0123456789abcdef0123456789abcdef", resolveActor: async userId => ({ userId, workspaceId: "w" }) });
  const ref = await Test.createTestingModule({ imports: [StoryKnowledgeTaskApiModule.register({ sessionVerifier: sessions, tasks,rateLimiter: availableRateLimiter(), retryPlanning: { projects, storyKnowledge: knowledge } })] }).compile();
  const app = ref.createNestApplication(); await app.listen(0, "127.0.0.1");
  return { owner, projects, knowledge, candidate, config, tasks, repository, sessions, app, advance: () => { now += 600001; } };
}
test("局部重试只处理失败范围，保留人工决定并可从已保存结果恢复", async () => {
  const h = await harness();
  try {
    const reviewed = await h.knowledge.reviewFact(h.owner, "p", "c", { expectedActiveVersionId: h.candidate.id, factId: "rain", outcome: "accepted", reason: "核对原文" });
    const job = await h.tasks.submitRetry(h.owner, { projectId: "p", chapterId: "c", expectedActiveVersionId: reviewed.id, scopeKeys: ["identity"], configurationVersionId: h.config.id, modelId: "m", requestId: "run-1" });
    let calls = 0;
    const executor = new StoryKnowledgeTaskExecutor({ tasks: h.tasks, projects: h.projects, storyKnowledge: h.knowledge, model: { async generate(input) {
      calls++; assert.deepEqual(input.scopeKeys, ["identity"]); assert.equal(input.retryOfJobId, "origin");
      return { ...envelope(input.jobId, [{ scopeKey: "identity", status: "succeeded", value: { id: "person", factType: "character", statement: "有人在雨中", assertionKind: "inferred", resolutionStatus: "resolved", resolutionGroupId: null, evidence: [{ sourceVersionId: "s", fragmentId: "f" }] } }]), status: "succeeded" };
    } } });
    const result = await executor.run(h.owner, job.id);
    assert.equal(result.state, "succeeded");
    const merged = await h.knowledge.getActive(h.owner, "p", "c");
    assert.equal(merged.parentVersionId, reviewed.id);
    assert.deepEqual(merged.facts.find(f => f.id === "rain"), reviewed.facts[0]);
    assert.deepEqual(merged.failures.map(f => f.scopeKey), ["props"]);
    assert.equal(merged.status, "candidate");
    assert.equal(calls, 1);
    const next = await h.tasks.submitRetry(h.owner, { projectId: "p", chapterId: "c", expectedActiveVersionId: merged.id, scopeKeys: ["props"], configurationVersionId: h.config.id, modelId: "m", requestId: "recover-1" });
    const running = await h.repository.transition("w", next.id, 0, "running", null);
    const saved = await h.knowledge.recordRetry(h.owner, "p", "c", { expectedActiveVersionId: merged.id, retryOfJobId: "origin",
      extraction: { ...envelope(next.id, [{ scopeKey: "props", status: "failed", error: { code: "UNKNOWN", message: "仍不明", retryable: true } }]), status: "failed" } });
    h.advance();
    assert.equal(running.state, "running");
    const recovered = await executor.recover(h.owner, next.id);
    assert.equal(recovered.result?.candidateVersionId, saved.id);
    assert.equal(calls, 1);
  } finally { await h.app.close(); }
});
function envelope(jobId: string, items: unknown[]) { return { contractVersion: "0.1.0", jobId, stage: "storyKnowledge", projectId: "p", chapterId: "c", sourceVersionId: "s", status: "partially_succeeded", items }; }
for (const change of ["before", "during", "wrong-scope", "unknown-recovery"]) test(`重试遇到版本或执行不确定性不覆盖成功内容：${change}`, async () => {
  const h = await harness();
  try {
    const job = await h.tasks.submitRetry(h.owner, { projectId: "p", chapterId: "c", expectedActiveVersionId: h.candidate.id, scopeKeys: ["identity"], configurationVersionId: h.config.id, modelId: "m", requestId: change });
    let calls = 0;
    const edit = () => h.knowledge.editFact(h.owner, "p", "c", { expectedActiveVersionId: h.candidate.id, factId: "rain", statement: "雨仍在落", reason: "人工校对" });
    if (change === "before") await edit();
    const executor = new StoryKnowledgeTaskExecutor({ tasks: h.tasks, projects: h.projects, storyKnowledge: h.knowledge, model: { async generate(input) {
      calls++; if (change === "during") await edit();
      return { ...envelope(input.jobId, [{ scopeKey: change === "wrong-scope" ? "weather" : "identity", status: "failed", error: { code: "UNKNOWN", message: "待查", retryable: true } }]), status: "failed" };
    } } });
    if (change === "unknown-recovery") {
      await h.repository.transition("w", job.id, 0, "running", null); h.advance();
      const recovered = await executor.recover(h.owner, job.id);
      assert.equal(recovered.reason, "EXECUTION_UNCERTAIN");
      await assert.rejects(() => h.tasks.resubmit(h.owner, job.id, { configurationVersionId: h.config.id, modelId: "m" }), { code: "STATE_CONFLICT" });
      assert.equal(calls, 0);
    } else {
      const result = await executor.run(h.owner, job.id);
      assert.equal(result.reason, change === "wrong-scope" ? "INVALID_RESPONSE" : "UPSTREAM_CHANGED");
      assert.equal(calls, change === "before" ? 0 : 1);
    }
    const current = await h.knowledge.getActive(h.owner, "p", "c");
    assert.equal(current.facts[0]?.statement, ["before", "during"].includes(change) ? "雨仍在落" : "雨落");
    assert.equal(current.failures.length, 2);
  } finally { await h.app.close(); }
});
