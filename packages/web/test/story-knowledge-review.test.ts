import assert from "node:assert/strict";
import test from "node:test";

import {
  availableFactActions,
  buildReviewRows,
  canConfirmStoryKnowledge,
  resolutionGroupCandidates,
  selectVisibleFact,
  selectFactEvidence,
} from "../src/lib/story-knowledge-review.ts";
import type { Chapter, StoryKnowledgeVersion } from "../src/lib/api.ts";

const version: StoryKnowledgeVersion = {
  id: "skv_1", parentVersionId: null, projectId: "prj_1", chapterId: "chp_1",
  sourceVersionId: "srcv_1", extractionJobId: "job_1", createdAt: "2026-09-30T08:00:00.000Z",
  createdBy: "usr_owner", extractionStatus: "partially_succeeded", status: "needs_resolution",
  facts: [
    {
      id: "fact_event", factType: "event", statement: "少年觉醒灵纹", assertionKind: "explicit",
      resolutionStatus: "resolved", resolutionGroupId: null,
      evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_1" }],
    },
    {
      id: "fact_identity", factType: "relationship", statement: "墨白可能是无心",
      assertionKind: "inferred", resolutionStatus: "pending_identity", resolutionGroupId: "identity:wuxin",
      evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_2" }],
    },
  ],
  failures: [{ scopeKey: "location:tianyage", originJobId: "job_1", code: "MODEL_TIMEOUT", message: "模型超时", retryable: true }],
};

const chapter: Chapter = {
  id: "chp_1", title: "第一章 青芽微澜", activeSourceVersionId: "srcv_1",
  versions: [{
    id: "srcv_1", ordinal: 1, createdAt: "2026-09-30T07:00:00.000Z", characterCount: 18,
    text: "少年额间灵纹骤亮。众人称他无心。",
    fragments: [
      { id: "frag_1", ordinal: 0, text: "少年额间灵纹骤亮。" },
      { id: "frag_2", ordinal: 1, text: "众人称他无心。" },
    ],
  }],
};

test("审核目录把待裁决事实置顶，并清楚区分原文明示与 AI 推断", () => {
  assert.deepEqual(buildReviewRows(version, "all").map((row) => ({
    id: row.id, provenance: row.provenance, state: row.state,
  })), [
    { id: "fact_identity", provenance: "AI 推断", state: "待确认身份" },
    { id: "fact_event", provenance: "原文明示", state: "可审核" },
  ]);
  assert.deepEqual(buildReviewRows(version, "pending").map(({ id }) => id), ["fact_identity"]);
});

test("选择故事事实时只返回其当前原文版本中的证据片段", () => {
  assert.deepEqual(selectFactEvidence(version, chapter, "fact_identity"), [{
    id: "frag_2", ordinal: 1, text: "众人称他无心。", cited: true,
  }]);
});

test("身份或冲突裁决并列返回同组候选及各自证据", () => {
  const conflicting = {
    ...version,
    facts: [version.facts[1]!, {
      ...version.facts[1]!, id: "fact_identity_alt", statement: "墨白与无心是两个人",
      evidence: [{ sourceVersionId: "srcv_1", fragmentId: "frag_1" }],
    }],
  };
  assert.deepEqual(resolutionGroupCandidates(conflicting, chapter, "fact_identity").map((candidate) => ({
    id: candidate.id, evidenceIds: candidate.evidence.map(({ id }) => id),
  })), [
    { id: "fact_identity", evidenceIds: ["frag_2"] },
    { id: "fact_identity_alt", evidenceIds: ["frag_1"] },
  ]);
});

test("候选事实可编辑审核，未决事实需先裁决，确认后只允许锁定", () => {
  assert.deepEqual(availableFactActions(version.facts[0]!, version.status), ["edit", "accept", "reject"]);
  assert.deepEqual(availableFactActions(version.facts[1]!, version.status), ["resolve"]);
  assert.deepEqual(availableFactActions({ ...version.facts[0]!, decision: {
    outcome: "accepted", decidedBy: "usr_owner", decidedAt: "2026-09-30T09:00:00.000Z", reason: "符合原文",
  } }, "confirmed"), ["lock"]);
});

test("筛选后只允许选择当前目录中的事实", () => {
  const explicitRows = buildReviewRows(version, "explicit");
  assert.equal(selectVisibleFact(explicitRows, "fact_identity")?.id, "fact_event");
});

test("只有无失败、无未决且至少接受一条事实的候选版本可以确认", () => {
  assert.deepEqual(canConfirmStoryKnowledge(version), { allowed: false, reason: "仍有 1 项局部失败需要处理" });
  const resolved = {
    ...version,
    status: "candidate" as const,
    failures: [],
    facts: version.facts.map((fact) => ({ ...fact, resolutionStatus: "resolved" as const })),
  };
  assert.deepEqual(canConfirmStoryKnowledge(resolved), { allowed: false, reason: "至少需要接受一条故事事实" });
  assert.deepEqual(canConfirmStoryKnowledge({
    ...resolved,
    facts: resolved.facts.map((fact, index) => index === 0 ? { ...fact, decision: {
      outcome: "accepted" as const, decidedBy: "usr_owner", decidedAt: "2026-09-30T09:00:00.000Z", reason: "符合原文",
    } } : fact),
  }), { allowed: true, reason: null });
});
