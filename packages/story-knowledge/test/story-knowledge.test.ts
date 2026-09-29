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
  assert.deepEqual(result.failures, [{ scopeKey: "fact:invalid", originJobId: "job_1", code: "EVIDENCE_REQUIRED", message: "每条故事知识必须关联至少一个原文片段", retryable: true }]);
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

test("编辑候选事实时保留证据并派生可审计的新版本", async () => {
  const ids = ["skv_base", "skv_edited"];
  const service = new StoryKnowledgeService({
    repository: new InMemoryStoryKnowledgeRepository(),
    sourceReader: { async findSourceVersion() { return { id: "srcv_1", fragmentIds: ["frag_1"] }; } },
    idGenerator: () => ids.shift() ?? "unexpected",
    clock: () => new Date("2026-09-29T13:00:00.000Z"),
  });
  await service.recordExtraction(actor, {
    contractVersion: "0.1.0", jobId: "job_base", stage: "storyKnowledge", projectId: "prj_1", chapterId: "chp_1", sourceVersionId: "srcv_1", status: "succeeded",
    items: [{ scopeKey: "fact:event", status: "succeeded", value: { id: "fact_event", factType: "event", statement: "少年灵纹觉醒", assertionKind: "explicit", resolutionStatus: "resolved", resolutionGroupId: null, evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_1" }] } }],
  });

  const edited = await service.editFact(actor, "prj_1", "chp_1", {
    expectedActiveVersionId: "skv_base",
    factId: "fact_event",
    statement: "少年在宗门试炼中觉醒灵纹",
    reason: "补充原文明确给出的事件地点",
  });

  assert.equal(edited.id, "skv_edited");
  assert.equal(edited.parentVersionId, "skv_base");
  assert.deepEqual(edited.facts[0], {
    id: "fact_event", factType: "event", statement: "少年在宗门试炼中觉醒灵纹",
    assertionKind: "user_confirmed", resolutionStatus: "resolved", resolutionGroupId: null,
    evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_1" }],
    lastEdit: {
      editedBy: "usr_owner", editedAt: "2026-09-29T13:00:00.000Z",
      reason: "补充原文明确给出的事件地点",
    },
  });
  const original = await service.getVersion(actor, "prj_1", "chp_1", "skv_base");
  assert.equal(original.facts[0]?.statement, "少年灵纹觉醒");
});

test("接受或拒绝候选事实均保留条目和证据并逐次派生版本", async () => {
  const ids = ["skv_base", "skv_accepted", "skv_rejected"];
  const service = new StoryKnowledgeService({
    repository: new InMemoryStoryKnowledgeRepository(),
    sourceReader: { async findSourceVersion() { return { id: "srcv_1", fragmentIds: ["frag_1", "frag_2"] }; } },
    idGenerator: () => ids.shift() ?? "unexpected",
    clock: () => new Date("2026-09-29T14:00:00.000Z"),
  });
  await service.recordExtraction(actor, {
    contractVersion: "0.1.0", jobId: "job_review", stage: "storyKnowledge", projectId: "prj_1", chapterId: "chp_1", sourceVersionId: "srcv_1", status: "succeeded",
    items: [
      { scopeKey: "fact:one", status: "succeeded", value: { id: "fact_one", factType: "event", statement: "保留事实", assertionKind: "explicit", resolutionStatus: "resolved", resolutionGroupId: null, evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_1" }] } },
      { scopeKey: "fact:two", status: "succeeded", value: { id: "fact_two", factType: "event", statement: "拒绝事实", assertionKind: "inferred", resolutionStatus: "resolved", resolutionGroupId: null, evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_2" }] } },
    ],
  });

  const accepted = await service.reviewFact(actor, "prj_1", "chp_1", {
    expectedActiveVersionId: "skv_base",
    factId: "fact_one", outcome: "accepted", reason: "符合原文",
  });
  const rejected = await service.reviewFact(actor, "prj_1", "chp_1", {
    expectedActiveVersionId: "skv_accepted",
    factId: "fact_two", outcome: "rejected", reason: "属于无依据推断",
  });

  assert.equal(accepted.parentVersionId, "skv_base");
  assert.equal(rejected.parentVersionId, "skv_accepted");
  assert.deepEqual(rejected.facts.map((fact) => ({
    id: fact.id, outcome: fact.decision?.outcome, evidence: fact.evidence,
  })), [
    { id: "fact_one", outcome: "accepted", evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_1" }] },
    { id: "fact_two", outcome: "rejected", evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_2" }] },
  ]);
  await assert.rejects(() => service.editFact(actor, "prj_1", "chp_1", {
    expectedActiveVersionId: "skv_rejected", factId: "fact_two", statement: "篡改已拒绝内容", reason: "不应允许",
  }), { code: "INVALID_EDIT" });
  await assert.rejects(() => service.reviewFact(actor, "prj_1", "chp_1", {
    expectedActiveVersionId: "skv_base", factId: "fact_one", outcome: "accepted", reason: "过期页面操作",
  }), { code: "VERSION_CONFLICT" });
});

test("局部重试只合并可重试范围并保留既有事实与不可重试失败", async () => {
  const ids = ["skv_partial", "skv_retry"];
  const service = new StoryKnowledgeService({
    repository: new InMemoryStoryKnowledgeRepository(),
    sourceReader: { async findSourceVersion(requester: typeof actor) { return requester.userId === actor.userId ? { id: "srcv_1", fragmentIds: ["frag_1", "frag_2"] } : null; } },
    idGenerator: () => ids.shift() ?? "unexpected",
    clock: () => new Date("2026-09-29T15:00:00.000Z"),
  });
  const partial = await service.recordExtraction(actor, {
    contractVersion: "0.1.0", jobId: "job_base", stage: "storyKnowledge", projectId: "prj_1", chapterId: "chp_1", sourceVersionId: "srcv_1", status: "partially_succeeded",
    items: [
      { scopeKey: "fact:existing", status: "succeeded", value: { id: "fact_existing", factType: "event", statement: "既有事实", assertionKind: "explicit", resolutionStatus: "resolved", resolutionGroupId: null, evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_1" }] } },
      { scopeKey: "fact:identity", status: "failed", error: { code: "AMBIGUOUS_IDENTITY", message: "待重试", retryable: true } },
      { scopeKey: "fact:restricted", status: "failed", error: { code: "COMPLIANCE_RESTRICTED", message: "不可重试", retryable: false } },
    ],
  });
  const retryResult = {
    contractVersion: "0.1.0", jobId: "job_retry", stage: "storyKnowledge", projectId: "prj_1", chapterId: "chp_1", sourceVersionId: "srcv_1", status: "succeeded",
    items: [{ scopeKey: "fact:identity", status: "succeeded", value: { id: "fact_identity", factType: "relationship", statement: "墨白是无心的身份", assertionKind: "explicit", resolutionStatus: "resolved", resolutionGroupId: null, evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_2" }] } }],
  };

  const retryCommand = {
    expectedActiveVersionId: partial.id,
    retryOfJobId: "job_base",
    extraction: retryResult,
  };
  await assert.rejects(
    () => service.recordRetry({ userId: "usr_other", workspaceId: actor.workspaceId }, "prj_1", "chp_1", { ...retryCommand, expectedActiveVersionId: "guessed_version" }),
    { code: "STAGE_RESULT_NOT_FOUND" },
  );
  const retried = await service.recordRetry(actor, "prj_1", "chp_1", retryCommand);
  const idempotent = await service.recordRetry(actor, "prj_1", "chp_1", retryCommand);

  assert.equal(retried.parentVersionId, "skv_partial");
  assert.deepEqual(retried.facts.map(({ id }) => id), ["fact_existing", "fact_identity"]);
  assert.deepEqual(retried.failures.map(({ scopeKey }) => scopeKey), ["fact:restricted"]);
  assert.equal(retried.extractionStatus, "partially_succeeded");
  assert.equal(idempotent.id, retried.id);
  await assert.rejects(
    () => service.recordRetry(actor, "prj_1", "chp_1", { ...retryCommand, extraction: { ...retryResult, items: [{ ...retryResult.items[0], value: { ...retryResult.items[0]?.value, statement: "同一幂等键的不同内容" } }] } }),
    { code: "INVALID_RETRY" },
  );
  await assert.rejects(
    () => service.recordRetry(actor, "prj_1", "chp_1", { expectedActiveVersionId: retried.id, retryOfJobId: "job_retry", extraction: { ...retryResult, jobId: "job_invalid", status: "failed", items: [{ scopeKey: "fact:restricted", status: "failed", error: { code: "STILL_RESTRICTED", message: "不可重试", retryable: false } }] } }),
    { code: "INVALID_RETRY" },
  );
});

test("多个失败范围可以分批关联各自来源任务完成重试", async () => {
  const ids = ["skv_base", "skv_retry_a", "skv_retry_b"];
  const service = new StoryKnowledgeService({
    repository: new InMemoryStoryKnowledgeRepository(),
    sourceReader: { async findSourceVersion() { return { id: "srcv_1", fragmentIds: ["frag_a", "frag_b"] }; } },
    idGenerator: () => ids.shift() ?? "unexpected",
    clock: () => new Date("2026-09-29T16:00:00.000Z"),
  });
  const base = await service.recordExtraction(actor, {
    contractVersion: "0.1.0", jobId: "job_base", stage: "storyKnowledge", projectId: "prj_1", chapterId: "chp_1", sourceVersionId: "srcv_1", status: "failed",
    items: [
      { scopeKey: "fact:a", status: "failed", error: { code: "FAILED_A", message: "A失败", retryable: true } },
      { scopeKey: "fact:b", status: "failed", error: { code: "FAILED_B", message: "B失败", retryable: true } },
    ],
  });
  const retryA = await service.recordRetry(actor, "prj_1", "chp_1", {
    expectedActiveVersionId: base.id,
    retryOfJobId: "job_base",
    extraction: {
      contractVersion: "0.1.0", jobId: "job_retry_a", stage: "storyKnowledge", projectId: "prj_1", chapterId: "chp_1", sourceVersionId: "srcv_1", status: "succeeded",
      items: [{ scopeKey: "fact:a", status: "succeeded", value: { id: "fact_a", factType: "event", statement: "事实A", assertionKind: "explicit", resolutionStatus: "resolved", resolutionGroupId: null, evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_a" }] } }],
    },
  });
  assert.deepEqual(retryA.failures, [{ scopeKey: "fact:b", originJobId: "job_base", code: "FAILED_B", message: "B失败", retryable: true }]);

  const retryB = await service.recordRetry(actor, "prj_1", "chp_1", {
    expectedActiveVersionId: retryA.id,
    retryOfJobId: "job_base",
    extraction: {
      contractVersion: "0.1.0", jobId: "job_retry_b", stage: "storyKnowledge", projectId: "prj_1", chapterId: "chp_1", sourceVersionId: "srcv_1", status: "succeeded",
      items: [{ scopeKey: "fact:b", status: "succeeded", value: { id: "fact_b", factType: "event", statement: "事实B", assertionKind: "explicit", resolutionStatus: "resolved", resolutionGroupId: null, evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_b" }] } }],
    },
  });
  assert.deepEqual(retryB.facts.map(({ id }) => id), ["fact_a", "fact_b"]);
  assert.deepEqual(retryB.failures, []);
});
