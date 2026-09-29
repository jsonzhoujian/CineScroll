import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryStoryKnowledgeRepository, StoryKnowledgeService } from "../src/index.ts";

const actor = { userId: "usr_owner", workspaceId: "wsp_studio" } as const;

test("部分成功保留有效故事事实，并只允许重试可重试的失败项", async () => {
  const repository = new InMemoryStoryKnowledgeRepository();
  const service = new StoryKnowledgeService({
    repository,
    sourceReader: {
      async findSourceVersion() {
        return { id: "srcv_1", fragmentIds: ["frag_1", "frag_2"] };
      },
    },
    idGenerator: () => "skv_1",
    clock: () => new Date("2026-09-29T08:00:00.000Z"),
  });

  const result = await service.recordExtraction(actor, {
    contractVersion: "0.1.0",
    jobId: "job_1",
    stage: "storyKnowledge",
    projectId: "prj_1",
    chapterId: "chp_1",
    sourceVersionId: "srcv_1",
    status: "partially_succeeded",
    items: [
      {
        scopeKey: "fact:awakening",
        status: "succeeded",
        value: {
          id: "fact_1",
          factType: "event",
          statement: "少年灵纹觉醒",
          assertionKind: "explicit",
          resolutionStatus: "resolved",
          evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_1" }],
        },
      },
      {
        scopeKey: "fact:identity",
        status: "failed",
        error: { code: "AMBIGUOUS_IDENTITY", message: "称谓无法确定", retryable: true },
      },
      {
        scopeKey: "fact:unsafe",
        status: "failed",
        error: { code: "COMPLIANCE_RESTRICTED", message: "内容受限", retryable: false },
      },
    ],
  });

  assert.equal(result.status, "candidate");
  assert.equal(result.extractionStatus, "partially_succeeded");
  assert.deepEqual(result.facts.map(({ statement }) => statement), ["少年灵纹觉醒"]);
  assert.deepEqual(result.failures.map(({ scopeKey }) => scopeKey), ["fact:identity", "fact:unsafe"]);
  assert.deepEqual(await service.getRetryableScopes(actor, "prj_1", "chp_1"), ["fact:identity"]);

  const persisted = await repository.findActive(actor, "prj_1", "chp_1");
  assert.equal(persisted?.id, "skv_1");
  assert.equal(persisted?.sourceVersionId, "srcv_1");
});

test("单条知识证据无效时保留其他有效事实，并把该条转成可重试失败", async () => {
  const service = new StoryKnowledgeService({
    repository: new InMemoryStoryKnowledgeRepository(),
    sourceReader: { async findSourceVersion() { return { id: "srcv_1", fragmentIds: ["frag_1"] }; } },
    idGenerator: () => "skv_1",
    clock: () => new Date("2026-09-29T08:00:00.000Z"),
  });

  const result = await service.recordExtraction(actor, {
    contractVersion: "0.1.0", jobId: "job_1", stage: "storyKnowledge",
    projectId: "prj_1", chapterId: "chp_1", sourceVersionId: "srcv_1", status: "succeeded",
    items: [
      {
        scopeKey: "fact:valid", status: "succeeded",
        value: { id: "fact_1", factType: "character", statement: "无心是少年", assertionKind: "explicit", resolutionStatus: "resolved", evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_1" }] },
      },
      {
        scopeKey: "fact:invalid", status: "succeeded",
        value: { id: "fact_2", factType: "character", statement: "证据缺失", assertionKind: "inferred", resolutionStatus: "resolved", evidence: [] },
      },
    ],
  });

  assert.deepEqual(result.facts.map(({ id }) => id), ["fact_1"]);
  assert.equal(result.extractionStatus, "partially_succeeded");
  assert.deepEqual(result.failures, [{ scopeKey: "fact:invalid", code: "EVIDENCE_REQUIRED", message: "每条故事知识必须关联至少一个原文片段", retryable: true }]);
});

test("后台响应必须通过运行时契约与任务状态一致性校验", async () => {
  const service = new StoryKnowledgeService({
    repository: new InMemoryStoryKnowledgeRepository(),
    sourceReader: { async findSourceVersion() { return { id: "srcv_1", fragmentIds: ["frag_1"] }; } },
    idGenerator: () => "skv_1",
    clock: () => new Date("2026-09-29T08:00:00.000Z"),
  });
  const invalid = {
    contractVersion: "0.1.0", jobId: "job_1", stage: "storyKnowledge",
    projectId: "prj_1", chapterId: "chp_1", sourceVersionId: "srcv_1", status: "partially_succeeded",
    items: [{ scopeKey: "fact:1", status: "succeeded", value: { id: "fact_1", factType: "event", statement: "", assertionKind: "explicit", resolutionStatus: "resolved", evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_1" }] } }],
  };

  await assert.rejects(() => service.recordExtraction(actor, invalid), { code: "INVALID_EXTRACTION" });
});

test("同工作区非项目成员不能读取局部重试范围", async () => {
  const repository = new InMemoryStoryKnowledgeRepository();
  const sourceReader = {
    async findSourceVersion(requester: typeof actor) {
      return requester.userId === actor.userId ? { id: "srcv_1", fragmentIds: ["frag_1"] } : null;
    },
  };
  const service = new StoryKnowledgeService({ repository, sourceReader, idGenerator: () => "skv_1", clock: () => new Date("2026-09-29T08:00:00.000Z") });
  await service.recordExtraction(actor, {
    contractVersion: "0.1.0", jobId: "job_1", stage: "storyKnowledge", projectId: "prj_1", chapterId: "chp_1", sourceVersionId: "srcv_1", status: "failed",
    items: [{ scopeKey: "fact:identity", status: "failed", error: { code: "AMBIGUOUS_IDENTITY", message: "无法确定", retryable: true } }],
  });

  await assert.rejects(
    () => service.getRetryableScopes({ userId: "usr_other", workspaceId: "wsp_studio" }, "prj_1", "chp_1"),
    { code: "STAGE_RESULT_NOT_FOUND" },
  );
});
