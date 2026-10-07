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
import { availableRateLimiter } from "./rate-limit-fixture.ts";
import { StoryKnowledgeTaskExecutor } from "../src/story-knowledge-task-executor.ts";
import { StoryKnowledgeTaskDispatcher } from "../src/story-knowledge-task-dispatcher.ts";
import { StoryKnowledgeTaskWorker } from "../src/story-knowledge-task-worker.ts";
import { StoryKnowledgeWorkerModule } from "../src/story-knowledge-worker-module.ts";
import { DeepSeekStoryKnowledgeModel } from "../src/deepseek-story-model.ts";
import { PostgresModelTaskRepository } from "@novel-adaptation/script/postgres-model-tasks";
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
  let maxQueued = 100;
  let maxExecuting = 100;
  const taskRepository = new InMemoryModelTaskRepository(() => now, () => ({ maxQueued, maxExecuting }));
  let policyAllowed = true;
  const tasks = new ModelTaskService({ settings, repository: taskRepository, storyAdmission: { workspaceIds: ["w"], providerIds: ["deepseek"] }, generationPolicy: { isAllowed: async () => policyAllowed }, contextReader: new StoryKnowledgeTaskContext(projects), idGenerator: () => `j${++job}` });
  const sessions = new HmacSessionManager({ secret: "0123456789abcdef0123456789abcdef", resolveActor: async userId => ({ userId, workspaceId: "w" }) });
  const ref = await Test.createTestingModule({ imports: [StoryKnowledgeTaskApiModule.register({ sessionVerifier: sessions, tasks,rateLimiter: availableRateLimiter() })] }).compile();
  const app = ref.createNestApplication(); await app.listen(0, "127.0.0.1");
  try {
    const http = request(app.getHttpServer()), bearer = `Bearer ${await sessions.issue("owner", "w")}`;
    const path = "/projects/p/chapters/c/story-knowledge-tasks";
    const selection = { configurationVersionId: tested.id, modelId: "m" };
    const availabilityPath = `${path}/availability?configurationVersionId=${tested.id}&modelId=m`;
    await http.get(availabilityPath).expect(401);
    await http.get(`/projects/${"p".repeat(257)}/chapters/c/story-knowledge-tasks/availability?configurationVersionId=${tested.id}&modelId=m`).set("authorization", bearer).expect(400);
    await http.get(availabilityPath).set("authorization", `Bearer ${await sessions.issue("outsider", "w")}`).expect(404);
    const available = await http.get(availabilityPath).set("authorization", bearer).expect(200);
    assert.deepEqual(available.body, { available: true, reason: null });
    policyAllowed = false;
    const restricted = await http.post(path).set("authorization", bearer).send(selection).expect(403);
    assert.equal(restricted.body.code, "POLICY_RESTRICTED");
    policyAllowed = true;
    await http.post(path).send(selection).expect(401);
    await http.post(path).set("authorization", bearer).send({ ...selection, sourceVersionId: "forged" }).expect(400);
    await http.post(`/projects/${"p".repeat(257)}/chapters/c/story-knowledge-tasks`).set("authorization", bearer).send(selection).expect(400);
    await http.get(`/story-knowledge-tasks/${"j".repeat(257)}`).set("authorization", bearer).expect(400);
    await http.post(path).set("authorization", `Bearer ${await sessions.issue("outsider", "w")}`).send(selection).expect(404);
    const created = await http.post(path).set("authorization", bearer).send(selection).expect(201);
    maxQueued = 0;
    const limited = await http.post(path).set("authorization", bearer).send(selection).expect(429);
    assert.equal(limited.body.code, "TASK_QUEUE_FULL");
    maxQueued = 100;
    assert.equal(created.body.input.stage, "story_knowledge"); assert.equal(created.body.input.sourceVersionId, "source1");
    assert.deepEqual(created.body.input.upstreamConfirmedVersionIds, []); assert.equal(created.body.state, "queued");
    assert.equal(created.headers["cache-control"], "no-store"); assert.ok(!JSON.stringify(created.body).includes("fixture-key"));
    await http.get(path).expect(401);
    await http.get(path).set("authorization", `Bearer ${await sessions.issue("outsider", "w")}`).expect(404);
    await http.get(`${path}?limit=51`).set("authorization", bearer).expect(400);
    await http.get(`${path}?workspaceId=forged`).set("authorization", bearer).expect(400);
    const listing = await http.get(`${path}?limit=1`).set("authorization", bearer).expect(200);
    assert.deepEqual(listing.body.tasks.map((task: { id: string }) => task.id), [created.body.id]);
    assert.equal(listing.headers["cache-control"], "no-store");
    assert.ok(!JSON.stringify(listing.body).includes("fixture-key"));
    await http.get(`/story-knowledge-tasks/${created.body.id}`).set("authorization", bearer).expect(200);
    const changed = await settings.configure(owner, { expectedVersionId: tested.id, providerId: "deepseek", apiKey: "new-fixture" });
    const next = await settings.testConnection(owner, changed.id);
    assert.equal((await tasks.run(owner, created.body.id, async () => { throw new Error("must not execute"); })).state, "paused");
    const child = await http.post(`/story-knowledge-tasks/${created.body.id}/resubmit`).set("authorization", bearer).send({ configurationVersionId: next.id, modelId: "m" }).expect(201);
    assert.deepEqual(child.body.input, created.body.input); assert.equal(child.body.parentTaskId, created.body.id);
    const paged = await http.get(`${path}?limit=1`).set("authorization", bearer).expect(200);
    assert.equal(paged.body.nextCursor, created.body.id);
    const more = await http.get(`${path}?limit=1&cursor=${paged.body.nextCursor}`).set("authorization", bearer).expect(200);
    assert.deepEqual(more.body.tasks.map((task: { id: string }) => task.id), [child.body.id]); assert.equal(more.body.nextCursor, null);
    await http.post(`/story-knowledge-tasks/${created.body.id}/resubmit`).set("authorization", bearer).send({ configurationVersionId: next.id, modelId: "m" }).expect(409);
    await http.get(`/story-knowledge-tasks/${created.body.id}`).set("authorization", `Bearer ${await sessions.issue("outsider", "w")}`).expect(404);
    const knowledge = new StoryKnowledgeService({ repository: new InMemoryStoryKnowledgeRepository(), projectAccessReader: projects,
      sourceReader: { async findSourceVersion(actor, projectId, chapterId, sourceVersionId) {
        if (!await projects.findProjectAccess(actor, projectId)) return null;
        const chapter = await projects.findChapter(actor, projectId, chapterId);
        const source = chapter?.versions.find(version => version.id === sourceVersionId);
        return source ? { id: source.id, fragmentIds: source.fragments.map(fragment => fragment.id) } : null;
      } }, idGenerator: () => `k${++version}`, clock: () => new Date("2026-10-05") });
    let dispatchCalls = 0;
    let entered!: () => void, releaseWorker!: () => void;
    const enteredModel = new Promise<void>(resolve => { entered = resolve; });
    const modelGate = new Promise<void>(resolve => { releaseWorker = resolve; });
    const executor = new StoryKnowledgeTaskExecutor({ tasks, projects, storyKnowledge: knowledge,
      model: new DeepSeekStoryKnowledgeModel({ fetch: async (url, init) => {
        dispatchCalls++;
        entered(); await modelGate;
        assert.equal(url, "https://api.deepseek.com/chat/completions");
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer new-fixture");
        assert.ok(!String(init?.body).includes("new-fixture"));
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, "m");
        const input = JSON.parse(body.messages[1].content);
        assert.deepEqual(input.input.sourceFragments, [{ id: "f", text: "雨落" }]);
        const extraction = { contractVersion: "0.1.0", jobId: input.jobId, stage: "storyKnowledge", projectId: "p", chapterId: "c", sourceVersionId: "source1",
          status: "partially_succeeded", items: [
            { scopeKey: "weather", status: "succeeded", value: { id: "rain", factType: "worldRule", statement: "正在下雨", assertionKind: "explicit", resolutionStatus: "resolved", resolutionGroupId: null, evidence: [{ sourceVersionId: "source1", fragmentId: "f" }] } },
            { scopeKey: "identity", status: "failed", error: { code: "UNKNOWN", message: "无法确定", retryable: true } },
          ] };
        return Response.json({ object: "chat.completion", model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(extraction) } }] });
      } }) });
    const dispatcher = new StoryKnowledgeTaskDispatcher({ repository: taskRepository, executor });
    const scans: { workspace: unknown; cursor: unknown; recover: boolean }[] = [];
    const scanRepository = new PostgresModelTaskRepository({ async connect() {
      return { release() {}, async query(sql, values) {
        if (!sql.includes("from model_tasks")) return { rows: [] };
        scans.push({ workspace: values?.[0], cursor: values?.[1], recover: sql.includes("EXECUTION_UNCERTAIN") });
        return { rows: values?.[1] == null ? Array.from({ length: 21 }, (_, i) => ({
          payload: { workspaceId: "w", id: `scan-${i.toString().padStart(2, "0")}`, createdBy: "outsider", input: { stage: "story_knowledge" } },
          state: "queued", revision: 0, reason: null,
        })) : [] };
      } };
    } });
    const configuredIds = ["w"];
    let rounds = 0;
    const sweepWorker = new StoryKnowledgeTaskWorker({ dispatcher: new StoryKnowledgeTaskDispatcher({ repository: scanRepository, executor }),
      enabled: true, workspaceIds: configuredIds, wait: async (_delay, signal) => { if (++rounds === 3) {
        queueMicrotask(() => { void sweepWorker.stop(); });
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      } } });
    configuredIds.push("not-allowlisted");
    await sweepWorker.start();
    assert.deepEqual(scans, [
      { workspace: "w", cursor: null, recover: false }, { workspace: "w", cursor: null, recover: true },
      { workspace: "w", cursor: "scan-19", recover: false }, { workspace: "w", cursor: "scan-19", recover: true },
      { workspace: "w", cursor: null, recover: false }, { workspace: "w", cursor: null, recover: true },
    ]);
    const delays: number[] = [];
    const brokenRepository = new PostgresModelTaskRepository({ async connect() { throw new Error("private database error"); } });
    const backoffWorker = new StoryKnowledgeTaskWorker({ dispatcher: new StoryKnowledgeTaskDispatcher({ repository: brokenRepository, executor }),
      enabled: true, workspaceIds: ["w"], intervalMs: 100, maxBackoffMs: 400,
      wait: async (delay, signal) => {
        assert.equal(backoffWorker.status().state, "running");
        assert.equal(backoffWorker.status().lastError, "DISPATCH_UNAVAILABLE");
        assert.equal(backoffWorker.status().backoffMs, delay);
        assert.equal(backoffWorker.status().lastScanAt, null);
        delays.push(delay); if (delays.length === 3) {
        queueMicrotask(() => { void backoffWorker.stop(); });
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      } } });
    await backoffWorker.start();
    assert.deepEqual(delays, [200, 400, 400]);
    const fatalRef = await Test.createTestingModule({ imports: [StoryKnowledgeWorkerModule.register({
      dispatcher: new StoryKnowledgeTaskDispatcher({ repository: brokenRepository, executor }), enabled: true, workspaceIds: ["w"],
      wait: async () => { throw new Error("fixture-key private database error 雨落"); },
    })] }).compile();
    const fatalApp = fatalRef.createNestApplication();
    await fatalApp.init();
    await new Promise<void>(resolve => setImmediate(resolve));
    const fatalWorker = fatalApp.get(StoryKnowledgeTaskWorker);
    assert.deepEqual(fatalWorker.status(), { enabled: true, state: "error", lastScanAt: null, backoffMs: 0, lastError: "WORKER_LOOP_FAILED" });
    const snapshot = fatalWorker.status(); snapshot.state = "running";
    assert.equal(fatalWorker.status().state, "error");
    await fatalApp.close();
    assert.throws(() => new StoryKnowledgeTaskWorker({ dispatcher, enabled: true, workspaceIds: [] }), /INVALID_WORKER_CONFIG/);
    assert.throws(() => new StoryKnowledgeTaskWorker({ dispatcher, workspaceIds: ["w", "w"] }), /INVALID_WORKER_CONFIG/);
    const disabledRef = await Test.createTestingModule({ imports: [StoryKnowledgeWorkerModule.register({ dispatcher, workspaceIds: ["w"] })] }).compile();
    const disabledApp = disabledRef.createNestApplication();
    await disabledApp.init();
    const disabledWorker = disabledApp.get(StoryKnowledgeTaskWorker);
    assert.equal(disabledWorker.status().state, "stopped");
    await disabledApp.close();
    assert.equal(dispatchCalls, 0);
    const workerRef = await Test.createTestingModule({ imports: [StoryKnowledgeWorkerModule.register({ dispatcher, enabled: true, workspaceIds: ["w"] })] }).compile();
    const workerApp = workerRef.createNestApplication();
    await workerApp.init();
    const worker = workerApp.get(StoryKnowledgeTaskWorker);
    await enteredModel;
    assert.equal(worker.status().state, "running");
    await assert.rejects(() => worker.start(), /WORKER_ALREADY_RUNNING/);
    const competingTick = await dispatcher.tick("w", "run");
    assert.equal(competingTick.items.length, 0);
    let stopped = false;
    const stopping = workerApp.close().then(() => { stopped = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(worker.status().state, "stopping");
    assert.equal(stopped, false);
    releaseWorker(); await stopping;
    assert.equal(worker.status().state, "stopped");
    assert.ok(worker.status().lastScanAt);
    assert.equal(worker.status().backoffMs, 0);
    assert.ok(!JSON.stringify(worker.status()).includes("new-fixture"));
    assert.equal(dispatchCalls, 1);
    const held = await tasks.submit(owner, { projectId: "p", chapterId: "c", configurationVersionId: next.id, modelId: "m" });
    await taskRepository.transition("w", held.id, 0, "running", null);
    const waiting = await tasks.submit(owner, { projectId: "p", chapterId: "c", configurationVersionId: next.id, modelId: "m" });
    maxExecuting = 1;
    const capacity = await dispatcher.tick("w", "run");
    assert.equal(capacity.items.find(item => item.id === waiting.id)?.outcome, "limited");
    assert.equal((await tasks.get(owner, waiting.id)).state, "queued");
    assert.equal(dispatchCalls, 1);
    await taskRepository.transition("w", held.id, 1, "failed", "PROVIDER_UNAVAILABLE");
    await taskRepository.transition("w", waiting.id, 0, "running", null);
    await taskRepository.transition("w", waiting.id, 1, "failed", "PROVIDER_UNAVAILABLE");
    maxExecuting = 100;
    assert.equal((await tasks.get(owner, child.body.id)).state, "succeeded");
    const deniedTask = { ...(await tasks.get(owner, child.body.id)), id: "zz-denied", parentTaskId: null, createdBy: "outsider", state: "queued" as const, revision: 0, reason: null, result: null, leaseExpiresAt: null };
    await taskRepository.insert(deniedTask);
    assert.deepEqual((await dispatcher.tick("w", "run")).items, [{ id: "zz-denied", outcome: "unavailable" }]);
    assert.equal(dispatchCalls, 1);
    assert.equal((await taskRepository.find("w", "zz-denied"))?.state, "queued");
    assert.deepEqual((await dispatcher.tick("other", "run")).items, []);
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
    const recoveryDispatcher = new StoryKnowledgeTaskDispatcher({ repository: taskRepository, executor: recovery });
    assert.deepEqual((await recoveryDispatcher.tick("w", "recover")).items, []);
    await assert.rejects(() => recovery.recover(owner, crashed.id), { code: "STATE_CONFLICT" });
    now += 600_001;
    assert.equal((await recoveryDispatcher.tick("w", "recover")).items[0]?.outcome, "completed");
    const repaired = await tasks.get(owner, crashed.id);
    assert.equal(repaired.state, "succeeded"); assert.equal(repaired.result?.candidateVersionId, savedCandidate.id);
    assert.equal(repaired.result?.extractionStatus, "failed");
    const unknown = await tasks.submit(owner, { projectId: "p", chapterId: "c", configurationVersionId: next.id, modelId: "m" });
    await taskRepository.transition("w", unknown.id, 0, "running", null);
    now += 600_001;
    assert.equal((await recoveryDispatcher.tick("w", "recover")).items[0]?.reason, "EXECUTION_UNCERTAIN");
    assert.equal((await recoveryDispatcher.tick("w", "recover")).items[0]?.outcome, "raced");
    await http.post(`/story-knowledge-tasks/${unknown.id}/resubmit`).set("authorization", bearer).send({ configurationVersionId: next.id, modelId: "m" }).expect(409);
    await assert.rejects(() => recovery.recover({ userId: "outsider", workspaceId: "w" }, unknown.id), { code: "TASK_NOT_FOUND" });
    assert.equal(recoveryModelCalls, 0);
    const lateKnowledge = new StoryKnowledgeService({ repository: new InMemoryStoryKnowledgeRepository(), projectAccessReader: projects,
      sourceReader: { async findSourceVersion() { return { id: "source1", fragmentIds: ["f"] }; } },
      idGenerator: () => `late${++version}`, clock: () => new Date("2026-10-05") });
    const lateCandidate = await lateKnowledge.recordExtraction(owner, {
      contractVersion: "0.1.0", jobId: unknown.id, stage: "storyKnowledge", projectId: "p", chapterId: "c", sourceVersionId: "source1", status: "failed",
      items: [{ scopeKey: "identity", status: "failed", error: { code: "UNKNOWN", message: "无法确定", retryable: true } }],
    });
    const lateDispatcher = new StoryKnowledgeTaskDispatcher({ repository: taskRepository,
      executor: new StoryKnowledgeTaskExecutor({ tasks, projects, storyKnowledge: lateKnowledge,
        model: { async generate() { recoveryModelCalls++; throw new Error("must not resend"); } } }) });
    assert.equal((await lateDispatcher.tick("w", "recover")).items[0]?.state, "succeeded");
    assert.equal((await tasks.get(owner, unknown.id)).result?.candidateVersionId, lateCandidate.id);
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
    for (const mode of ["success", "wrong-envelope", "provider-error", "timeout", "policy-changed", "source-changed"] as const) {
      const isolated = new StoryKnowledgeService({ repository: new InMemoryStoryKnowledgeRepository(), projectAccessReader: projects,
        sourceReader: { async findSourceVersion() { return { id: "source1", fragmentIds: ["f"] }; } },
        idGenerator: () => `isolated${++version}`, clock: () => new Date("2026-10-05") });
      const queued = await tasks.submit(owner, { projectId: "p", chapterId: "c", configurationVersionId: next.id, modelId: "m" });
      let httpCalls = 0;
      const invalid = new StoryKnowledgeTaskExecutor({ tasks, projects, storyKnowledge: isolated,
        model: new DeepSeekStoryKnowledgeModel({ timeoutMs: 100, fetch: async (_url, init) => {
          httpCalls++;
          assert.equal(new Headers(init?.headers).get("authorization"), "Bearer new-fixture");
          const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
          if (mode === "provider-error") throw new Error("new-fixture: vendor private response");
          if (mode === "timeout") return new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener("abort", () => reject(new Error("new-fixture: timeout")), { once: true });
          });
          if (mode === "policy-changed") policyAllowed = false;
          if (mode === "source-changed") {
            const project = (await projects.findProject(owner, "p"))!;
            project.chapters[0]!.activeSourceVersionId = "source2";
            await projects.saveProject(owner, project);
          }
          const extraction = { contractVersion: "0.1.0", jobId: mode === "wrong-envelope" ? "forged" : input.jobId,
            stage: "storyKnowledge", projectId: "p", chapterId: "c", sourceVersionId: "source1", status: mode === "success" ? "succeeded" : "failed",
            items: mode === "success" ? [{ scopeKey: "weather", status: "succeeded", value: { id: "rain", factType: "worldRule", statement: "正在下雨",
              assertionKind: "explicit", resolutionStatus: "resolved", resolutionGroupId: null, evidence: [{ sourceVersionId: "source1", fragmentId: "f" }] } }]
              : [{ scopeKey: "identity", status: "failed", error: { code: "UNKNOWN", message: "无法确定", retryable: true } }] };
          return Response.json({ object: "chat.completion", model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(extraction) } }] });
        } }) });
      const isolatedDispatcher = new StoryKnowledgeTaskDispatcher({ repository: taskRepository, executor: invalid });
      const isolatedWorker = new StoryKnowledgeTaskWorker({ dispatcher: isolatedDispatcher, enabled: true, workspaceIds: ["w"],
        wait: async (_delay, signal) => {
          queueMicrotask(() => { void isolatedWorker.stop(); });
          await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        } });
      await isolatedWorker.start();
      const report = await isolatedDispatcher.tick("w", "run");
      assert.equal(report.items.find(item => item.id === queued.id), undefined);
      assert.equal(httpCalls, 1);
      assert.ok(!JSON.stringify(report).includes("new-fixture"));
      const outcome = (await taskRepository.find(owner.workspaceId, queued.id))!;
      assert.equal(outcome.state, mode === "success" ? "succeeded" : ["source-changed", "policy-changed"].includes(mode) ? "paused" : "failed");
      assert.equal(outcome.reason, mode === "success" ? null : mode === "policy-changed" ? "POLICY_RESTRICTED" : mode === "source-changed" ? "UPSTREAM_CHANGED" : mode === "wrong-envelope" ? "INVALID_RESPONSE" : "PROVIDER_UNAVAILABLE");
      if (mode !== "success") assert.equal(outcome.result, null);
      assert.ok(!JSON.stringify(outcome).includes("new-fixture"));
      if (mode !== "source-changed") {
        const status = await http.get(`/story-knowledge-tasks/${queued.id}`).set("authorization", bearer).expect(200);
        assert.equal(status.body.state, outcome.state);
        assert.equal(status.body.reason, outcome.reason);
        if (mode === "success") {
          const candidate = await isolated.getActive(owner, "p", "c");
          assert.equal(candidate.status, "candidate");
          assert.equal(candidate.extractionStatus, "succeeded");
          assert.deepEqual(status.body.result, { candidateVersionId: candidate.id, extractionStatus: "succeeded" });
          assert.deepEqual(candidate.facts.map(fact => fact.statement), ["正在下雨"]);
        } else assert.equal(status.body.result, null);
        assert.ok(!JSON.stringify(status.body).includes("new-fixture"));
      }
      if (mode !== "success") await assert.rejects(() => isolated.getActive(owner, "p", "c"), { code: "STAGE_RESULT_NOT_FOUND" });
      policyAllowed = true;
    }
  } finally { await app.close(); }
});
