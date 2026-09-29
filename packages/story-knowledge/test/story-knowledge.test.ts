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
          resolutionGroupId: null,
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
        value: { id: "fact_1", factType: "character", statement: "无心是少年", assertionKind: "explicit", resolutionStatus: "resolved", resolutionGroupId: null, evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_1" }] },
      },
      {
        scopeKey: "fact:invalid", status: "succeeded",
        value: { id: "fact_2", factType: "character", statement: "证据缺失", assertionKind: "inferred", resolutionStatus: "resolved", resolutionGroupId: null, evidence: [] },
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
    items: [{ scopeKey: "fact:1", status: "succeeded", value: { id: "fact_1", factType: "event", statement: "", assertionKind: "explicit", resolutionStatus: "resolved", resolutionGroupId: null, evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_1" }] } }],
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

test("用户确认隐藏身份候选时派生新版本并完整保留候选证据", async () => {
  const repository = new InMemoryStoryKnowledgeRepository();
  const ids = ["skv_candidate", "skv_resolved"];
  const service = new StoryKnowledgeService({
    repository,
    sourceReader: {
      async findSourceVersion() {
        return { id: "srcv_1", fragmentIds: ["frag_alias", "frag_identity"] };
      },
    },
    idGenerator: () => ids.shift() ?? "unexpected",
    clock: () => new Date("2026-09-29T09:00:00.000Z"),
  });
  const candidate = await service.recordExtraction(actor, {
    contractVersion: "0.1.0", jobId: "job_identity", stage: "storyKnowledge",
    projectId: "prj_1", chapterId: "chp_1", sourceVersionId: "srcv_1", status: "succeeded",
    items: [{
      scopeKey: "fact:hidden-identity", status: "succeeded",
      value: {
        id: "fact_identity", factType: "relationship", statement: "墨白可能是无心的隐藏身份",
        assertionKind: "inferred", resolutionStatus: "pending_identity",
        resolutionGroupId: "issue:identity-wuxin",
        evidence: [
          { sourceVersionId: "srcv_1", fragmentId: "frag_alias" },
          { sourceVersionId: "srcv_1", fragmentId: "frag_identity" },
        ],
      },
    }],
  });

  const resolved = await service.resolveFact(actor, "prj_1", "chp_1", {
    factId: "fact_identity",
    statement: "墨白是无心使用的身份",
    reason: "原文两处称谓和行动线索一致",
  });

  assert.equal(candidate.status, "needs_resolution");
  assert.equal(candidate.facts[0]?.resolutionStatus, "pending_identity");
  assert.equal(resolved.id, "skv_resolved");
  assert.equal(resolved.parentVersionId, "skv_candidate");
  assert.equal(resolved.status, "candidate");
  assert.deepEqual(resolved.facts[0], {
    ...candidate.facts[0],
    statement: "墨白是无心使用的身份",
    assertionKind: "user_confirmed",
    resolutionStatus: "resolved",
    decision: {
      outcome: "accepted",
      decidedBy: "usr_owner",
      decidedAt: "2026-09-29T09:00:00.000Z",
      reason: "原文两处称谓和行动线索一致",
    },
  });
  const original = await service.getVersion(actor, "prj_1", "chp_1", "skv_candidate");
  assert.equal(original.facts[0]?.resolutionStatus, "pending_identity");
  assert.equal(original.facts[0]?.decision, undefined);
});

test("解决冲突事实时保留胜出项与被否决项的全部证据", async () => {
  const ids = ["skv_conflict", "skv_decided"];
  const service = new StoryKnowledgeService({
    repository: new InMemoryStoryKnowledgeRepository(),
    sourceReader: {
      async findSourceVersion() {
        return { id: "srcv_1", fragmentIds: ["frag_spring", "frag_winter"] };
      },
    },
    idGenerator: () => ids.shift() ?? "unexpected",
    clock: () => new Date("2026-09-29T10:00:00.000Z"),
  });
  await service.recordExtraction(actor, {
    contractVersion: "0.1.0", jobId: "job_conflict", stage: "storyKnowledge",
    projectId: "prj_1", chapterId: "chp_1", sourceVersionId: "srcv_1", status: "succeeded",
    items: [
      {
        scopeKey: "fact:season-spring", status: "succeeded",
        value: { id: "fact_spring", factType: "worldRule", statement: "事件发生在春季", assertionKind: "explicit", resolutionStatus: "conflicting", resolutionGroupId: "issue:event-season", evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_spring" }] },
      },
      {
        scopeKey: "fact:season-winter", status: "succeeded",
        value: { id: "fact_winter", factType: "worldRule", statement: "事件发生在冬季", assertionKind: "explicit", resolutionStatus: "conflicting", resolutionGroupId: "issue:event-season", evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_winter" }] },
      },
    ],
  });

  await assert.rejects(() => service.resolveFact(actor, "prj_1", "chp_1", {
    factId: "fact_winter",
    statement: "事件发生在冬季",
    reason: "未处理同组的春季候选",
    conflictClassification: "character_misunderstanding",
  }), { code: "INVALID_DECISION" });

  const decided = await service.resolveFact(actor, "prj_1", "chp_1", {
    factId: "fact_winter",
    alternativeFactIds: ["fact_spring"],
    conflictClassification: "character_misunderstanding",
    statement: "事件发生在冬季",
    reason: "春季描述属于人物误解",
  });

  assert.equal(decided.status, "candidate");
  assert.equal(decided.facts.length, 2);
  assert.deepEqual(decided.facts.map((fact) => ({
    id: fact.id,
    evidence: fact.evidence,
    outcome: fact.decision?.outcome,
  })), [
    { id: "fact_spring", evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_spring" }], outcome: "rejected" },
    { id: "fact_winter", evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_winter" }], outcome: "accepted" },
  ]);
  assert.equal(decided.facts[0]?.decision?.conflictClassification, "character_misunderstanding");
});

test("冲突决定拒绝跨候选组事实，并在并发修改时只接受一个后继版本", async () => {
  const ids = ["skv_base", "skv_a", "skv_b"];
  const service = new StoryKnowledgeService({
    repository: new InMemoryStoryKnowledgeRepository(),
    sourceReader: { async findSourceVersion() { return { id: "srcv_1", fragmentIds: ["frag_a", "frag_b"] }; } },
    idGenerator: () => ids.shift() ?? "unexpected",
    clock: () => new Date("2026-09-29T11:00:00.000Z"),
  });
  await service.recordExtraction(actor, {
    contractVersion: "0.1.0", jobId: "job_groups", stage: "storyKnowledge", projectId: "prj_1", chapterId: "chp_1", sourceVersionId: "srcv_1", status: "succeeded",
    items: [
      { scopeKey: "fact:a", status: "succeeded", value: { id: "fact_a", factType: "event", statement: "甲结论", assertionKind: "inferred", resolutionStatus: "conflicting", resolutionGroupId: "issue:a", evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_a" }] } },
      { scopeKey: "fact:b", status: "succeeded", value: { id: "fact_b", factType: "event", statement: "乙结论", assertionKind: "inferred", resolutionStatus: "conflicting", resolutionGroupId: "issue:b", evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_b" }] } },
    ],
  });

  await assert.rejects(() => service.resolveFact(actor, "prj_1", "chp_1", {
    factId: "fact_a", alternativeFactIds: ["fact_b"], statement: "甲结论", reason: "不同问题不能合并裁决", conflictClassification: "other",
  }), { code: "INVALID_DECISION" });

  const decisions = await Promise.allSettled([
    service.resolveFact(actor, "prj_1", "chp_1", { factId: "fact_a", statement: "甲结论一", reason: "决定一", conflictClassification: "other" }),
    service.resolveFact(actor, "prj_1", "chp_1", { factId: "fact_a", statement: "甲结论二", reason: "决定二", conflictClassification: "other" }),
  ]);
  assert.equal(decisions.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(decisions.filter(({ status }) => status === "rejected").length, 1);
  const rejection = decisions.find((result) => result.status === "rejected");
  assert.equal(rejection?.status === "rejected" && (rejection.reason as { code?: string }).code, "VERSION_CONFLICT");
});

test("畸形决定命令返回稳定业务错误", async () => {
  const service = new StoryKnowledgeService({
    repository: new InMemoryStoryKnowledgeRepository(),
    sourceReader: { async findSourceVersion() { return null; } },
    idGenerator: () => "unused",
    clock: () => new Date("2026-09-29T11:00:00.000Z"),
  });
  await assert.rejects(
    () => service.resolveFact(actor, "prj_1", "chp_1", { factId: null } as unknown),
    { code: "INVALID_DECISION" },
  );
});

test("迟到的提取结果不能覆盖已经完成的人工决定", async () => {
  const ids = ["skv_base", "skv_decided", "skv_late"];
  const service = new StoryKnowledgeService({
    repository: new InMemoryStoryKnowledgeRepository(),
    sourceReader: { async findSourceVersion() { return { id: "srcv_1", fragmentIds: ["frag_1"] }; } },
    idGenerator: () => ids.shift() ?? "unexpected",
    clock: () => new Date("2026-09-29T12:00:00.000Z"),
  });
  const extraction = {
    contractVersion: "0.1.0", jobId: "job_base", stage: "storyKnowledge", projectId: "prj_1", chapterId: "chp_1", sourceVersionId: "srcv_1", status: "succeeded",
    items: [{ scopeKey: "fact:identity", status: "succeeded", value: { id: "fact_identity", factType: "relationship", statement: "身份待确认", assertionKind: "inferred", resolutionStatus: "pending_identity", resolutionGroupId: "issue:identity", evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_1" }] } }],
  };
  await service.recordExtraction(actor, extraction);
  await service.resolveFact(actor, "prj_1", "chp_1", { factId: "fact_identity", statement: "身份已确认", reason: "人工确认" });

  await assert.rejects(() => service.recordExtraction(actor, { ...extraction, jobId: "job_late" }), {
    code: "VERSION_CONFLICT",
  });
});
