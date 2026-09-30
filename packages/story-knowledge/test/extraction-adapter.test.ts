import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryStoryKnowledgeRepository, StoryKnowledgeService } from "../src/index.ts";
import {
  StoryKnowledgeExtractionRunner,
  StoryKnowledgeModelError,
  type StoryKnowledgeGenerationRequest,
  type StoryKnowledgeModelPort,
} from "../src/extraction-adapter.ts";

const actor = { userId: "usr_owner", workspaceId: "wsp_studio" } as const;

test("后台执行器把不可变原文快照交给模型，并持久化条目级部分成功结果", async () => {
  const repository = new InMemoryStoryKnowledgeRepository();
  const service = storyService(repository);
  const calls: StoryKnowledgeGenerationRequest[] = [];
  const model: StoryKnowledgeModelPort = {
    async generate(request) {
      calls.push(structuredClone(request));
      return {
        contractVersion: "0.1.0", jobId: request.jobId, stage: "storyKnowledge",
        projectId: request.projectId, chapterId: request.chapterId, sourceVersionId: request.sourceVersionId,
        status: "partially_succeeded",
        items: [
          {
            scopeKey: "event:awakening", status: "succeeded",
            value: {
              id: "fact_event", factType: "event", statement: "少年觉醒灵纹", assertionKind: "explicit",
              resolutionStatus: "resolved", resolutionGroupId: null,
              evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_1" }],
            },
          },
          {
            scopeKey: "identity:wuxin", status: "failed",
            error: { code: "AMBIGUOUS_IDENTITY", message: "称谓无法确定", retryable: true },
          },
        ],
      };
    },
  };
  const runner = new StoryKnowledgeExtractionRunner({ model, storyKnowledge: service });

  const result = await runner.run(actor, generationRequest(), null);

  assert.deepEqual(calls, [generationRequest()]);
  assert.equal(result.extractionStatus, "partially_succeeded");
  assert.deepEqual(result.facts.map(({ id }) => id), ["fact_event"]);
  assert.deepEqual(result.failures.map(({ scopeKey }) => scopeKey), ["identity:wuxin"]);
  assert.equal((await repository.findActive(actor, "prj_1", "chp_1"))?.id, result.id);
});

test("执行器拒绝错配任务的模型响应，且不会污染活动版本", async () => {
  const repository = new InMemoryStoryKnowledgeRepository();
  const runner = new StoryKnowledgeExtractionRunner({
    storyKnowledge: storyService(repository),
    model: {
      async generate(request) {
        return {
          contractVersion: "0.1.0", jobId: request.jobId, stage: "storyKnowledge",
          projectId: "prj_other", chapterId: request.chapterId, sourceVersionId: request.sourceVersionId,
          status: "failed", items: [],
        };
      },
    },
  });

  await assert.rejects(() => runner.run(actor, generationRequest(), null), {
    name: "StoryKnowledgeModelError", code: "INVALID_RESPONSE",
  });
  assert.equal(await repository.findActive(actor, "prj_1", "chp_1"), null);
});

test("执行器在模型调用前拒绝不符合规范的输入快照", async () => {
  let calls = 0;
  const runner = new StoryKnowledgeExtractionRunner({
    storyKnowledge: storyService(new InMemoryStoryKnowledgeRepository()),
    model: { async generate() { calls += 1; return {}; } },
  });

  await assert.rejects(
    () => runner.run(actor, { ...generationRequest(), scopeKeys: [] }, null),
    { name: "StoryKnowledgeModelError", code: "INVALID_REQUEST" },
  );
  assert.equal(calls, 0);
});

test("执行器把嵌套畸形输入统一拒绝为稳定契约错误", async () => {
  let calls = 0;
  const runner = new StoryKnowledgeExtractionRunner({
    storyKnowledge: storyService(new InMemoryStoryKnowledgeRepository()),
    model: { async generate() { calls += 1; return {}; } },
  });

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const request of [
    { ...generationRequest(), input: null },
    { ...generationRequest(), generationParameters: { ...generationRequest().generationParameters, targetDurationSeconds: 999 } },
    { ...generationRequest(), input: { ...generationRequest().input, lockedItemIds: ["duplicate", "duplicate"] } },
    { ...generationRequest(), input: { ...generationRequest().input, confirmedUpstreamContent: [{ callback: () => undefined }] } },
    { ...generationRequest(), input: { ...generationRequest().input, confirmedUpstreamContent: [cyclic] } },
    { ...generationRequest(), provider: "must-not-leak-into-canonical-contract" },
  ]) {
    await assert.rejects(() => runner.run(actor, request, null), {
      name: "StoryKnowledgeModelError", code: "INVALID_REQUEST",
    });
  }
  assert.equal(calls, 0);
});

test("模型端口无法篡改 canonical 快照或响应匹配的信任基准", async () => {
  const repository = new InMemoryStoryKnowledgeRepository();
  const runner = new StoryKnowledgeExtractionRunner({
    storyKnowledge: storyService(repository),
    model: {
      async generate(request) {
        assert.equal(Object.isFrozen(request), true);
        assert.equal(Object.isFrozen(request.input.sourceFragments), true);
        assert.throws(() => { (request as { projectId: string }).projectId = "prj_other"; }, TypeError);
        return {
          contractVersion: "0.1.0", jobId: request.jobId, stage: "storyKnowledge",
          projectId: "prj_other", chapterId: request.chapterId, sourceVersionId: request.sourceVersionId,
          status: "failed", items: [],
        };
      },
    },
  });

  await assert.rejects(() => runner.run(actor, generationRequest(), null), {
    name: "StoryKnowledgeModelError", code: "INVALID_RESPONSE",
  });
  assert.equal(await repository.findActive(actor, "prj_1", "chp_1"), null);
});

test("局部重试只替换请求范围，保留既有成功内容并支持幂等回放", async () => {
  const repository = new InMemoryStoryKnowledgeRepository();
  const service = storyService(repository);
  const initialRunner = new StoryKnowledgeExtractionRunner({
    storyKnowledge: service,
    model: {
      async generate(request) {
        return {
          contractVersion: "0.1.0", jobId: request.jobId, stage: "storyKnowledge",
          projectId: request.projectId, chapterId: request.chapterId, sourceVersionId: request.sourceVersionId,
          status: "partially_succeeded",
          items: [
            { scopeKey: "event:awakening", status: "succeeded", value: {
              id: "fact_event", factType: "event", statement: "少年觉醒灵纹", assertionKind: "explicit",
              resolutionStatus: "resolved", resolutionGroupId: null,
              evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_1" }],
            } },
            { scopeKey: "identity:wuxin", status: "failed", error: {
              code: "AMBIGUOUS_IDENTITY", message: "称谓无法确定", retryable: true,
            } },
          ],
        };
      },
    },
  });
  const initial = await initialRunner.run(actor, generationRequest(), null);
  const retryRequest: StoryKnowledgeGenerationRequest = {
    ...generationRequest(), jobId: "job_story_retry_1", retryOfJobId: "job_story_1", scopeKeys: ["identity:wuxin"],
  };
  const retryRunner = new StoryKnowledgeExtractionRunner({
    storyKnowledge: service,
    model: {
      async generate(request) {
        return {
          contractVersion: "0.1.0", jobId: request.jobId, stage: "storyKnowledge",
          projectId: request.projectId, chapterId: request.chapterId, sourceVersionId: request.sourceVersionId,
          status: "succeeded", items: [{ scopeKey: "identity:wuxin", status: "succeeded", value: {
            id: "fact_identity", factType: "character", statement: "无心是相府之子", assertionKind: "explicit",
            resolutionStatus: "resolved", resolutionGroupId: null,
            evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_2" }],
          } }],
        };
      },
    },
  });

  const retried = await retryRunner.run(actor, retryRequest, initial.id);
  const replayed = await retryRunner.run(actor, retryRequest, initial.id);

  assert.deepEqual(retried.facts.map(({ id }) => id), ["fact_event", "fact_identity"]);
  assert.deepEqual(retried.failures, []);
  assert.equal(replayed.id, retried.id);
});

test("重试缺少活动版本基准时在模型调用前失败", async () => {
  let calls = 0;
  const runner = new StoryKnowledgeExtractionRunner({
    storyKnowledge: storyService(new InMemoryStoryKnowledgeRepository()),
    model: { async generate() { calls += 1; return {}; } },
  });
  const request = { ...generationRequest(), retryOfJobId: "job_story_1", scopeKeys: ["identity:wuxin"] };

  await assert.rejects(() => runner.run(actor, request, null), {
    name: "StoryKnowledgeModelError", code: "INVALID_REQUEST",
  });
  assert.equal(calls, 0);
});

test("结构畸形的重试模型输出归类为模型响应错误", async () => {
  const runner = new StoryKnowledgeExtractionRunner({
    storyKnowledge: storyService(new InMemoryStoryKnowledgeRepository()),
    model: {
      async generate(request) {
        return {
          contractVersion: "0.1.0", jobId: request.jobId, stage: "storyKnowledge",
          projectId: request.projectId, chapterId: request.chapterId, sourceVersionId: request.sourceVersionId,
          status: "succeeded", items: [{ scopeKey: "identity:wuxin", status: "succeeded", value: {
            id: "fact_identity", factType: "not-a-fact-type",
          } }],
        };
      },
    },
  });
  const request = { ...generationRequest(), retryOfJobId: "job_story_1", scopeKeys: ["identity:wuxin"] };

  await assert.rejects(() => runner.run(actor, request, "skv_active"), {
    name: "StoryKnowledgeModelError", code: "INVALID_RESPONSE",
  });
});

test("执行器隔离结构错误的模型输出，不创建候选版本", async () => {
  const repository = new InMemoryStoryKnowledgeRepository();
  const runner = new StoryKnowledgeExtractionRunner({
    storyKnowledge: storyService(repository),
    model: {
      async generate(request) {
        return {
          contractVersion: "0.1.0", jobId: request.jobId, stage: "storyKnowledge",
          projectId: request.projectId, chapterId: request.chapterId, sourceVersionId: request.sourceVersionId,
          status: "succeeded", items: "not-an-array",
        };
      },
    },
  });

  await assert.rejects(() => runner.run(actor, generationRequest(), null), {
    name: "StoryKnowledgeModelError", code: "INVALID_RESPONSE",
  });
  assert.equal(await repository.findActive(actor, "prj_1", "chp_1"), null);
});

function storyService(repository: InMemoryStoryKnowledgeRepository): StoryKnowledgeService {
  let nextId = 0;
  return new StoryKnowledgeService({
    repository,
    sourceReader: {
      async findSourceVersion(_actor, projectId, chapterId, sourceVersionId) {
        return projectId === "prj_1" && chapterId === "chp_1" && sourceVersionId === "srcv_1"
          ? { id: "srcv_1", fragmentIds: ["frag_1", "frag_2"] }
          : null;
      },
    },
    idGenerator: () => `skv_generated_${nextId += 1}`,
    clock: () => new Date("2026-09-30T08:00:00.000Z"),
  });
}

function generationRequest(): StoryKnowledgeGenerationRequest {
  return {
    contractVersion: "0.1.0", jobId: "job_story_1", stage: "storyKnowledge",
    projectId: "prj_1", chapterId: "chp_1", sourceVersionId: "srcv_1",
    upstreamConfirmedVersionIds: [],
    scopeKeys: ["characters", "relationships", "events", "locations", "props", "worldRules"],
    generationParameters: { targetDurationSeconds: 180, aspectRatio: "9:16", narrativeMode: "narration" },
    input: {
      sourceFragments: [
        { id: "frag_1", text: "少年额间灵纹骤亮。" },
        { id: "frag_2", text: "众人称他无心。" },
      ],
      confirmedUpstreamContent: [], approvedAdditionIds: [], lockedItemIds: [],
    },
  };
}
