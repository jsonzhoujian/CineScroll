import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryScriptRepository, ScriptService } from "../src/index.ts";

const actor = { userId: "usr_owner", workspaceId: "wsp_studio" } as const;

test("拆集方案上游知识变化后不能确认旧候选", async () => {
  let upstream = "bible-1", id = 0;
  const service = new ScriptService({ repository: new InMemoryScriptRepository(), accessReader: { findProjectAccess: async () => ({ role: "owner" }) },
    upstreamReader: { findConfirmedStoryBible: async () => ({ versionId: upstream, sourceVersionId: "s", factIds: ["event"], fragmentIds: ["f"] }) },
    idGenerator: () => `plan-${++id}`, clock: () => new Date("2026-10-06") });
  const candidate = await service.recordEpisodePlan(actor, { expectedActiveVersionId: null, projectId: "p", chapterId: "c", sourceVersionId: "s", storyBibleVersionId: "bible-1", targetDurationSeconds: 60,
    aspectRatio: "9:16", narrativeMode: "dialogue", episodes: [{ id: "e", ordinal: 1, title: "雨落", sourceFragmentIds: ["f"], coreEventFactIds: ["event"] }], majorAdaptationProposals: [] });
  upstream = "bible-2";
  await assert.rejects(() => service.confirmEpisodePlan(actor, "p", "c", { expectedActiveVersionId: candidate.id }), { code: "VERSION_CONFLICT" });
});

test("重大改编建议必须逐项裁决，获批后才能确认拆集方案", async () => {
  const ids = ["plan_candidate", "plan_decided", "plan_confirmed"];
  const service = new ScriptService({
    repository: new InMemoryScriptRepository(),
    accessReader: { async findProjectAccess() { return { role: "owner" }; } },
    upstreamReader: {
      async findConfirmedStoryBible() {
        return {
          versionId: "story_bible_v1",
          sourceVersionId: "source_v1",
          factIds: ["fact_awaken", "fact_departure"],
          fragmentIds: ["frag_1", "frag_2", "frag_3"],
        };
      },
    },
    idGenerator: () => ids.shift() ?? "unexpected",
    clock: () => new Date("2026-10-01T08:00:00.000Z"),
  });

  const candidate = await service.recordEpisodePlan(actor, {
    expectedActiveVersionId: null,
    projectId: "project_1",
    chapterId: "chapter_1",
    sourceVersionId: "source_v1",
    storyBibleVersionId: "story_bible_v1",
    targetDurationSeconds: 180,
    aspectRatio: "9:16",
    narrativeMode: "narration",
    episodes: [
      {
        id: "episode_1",
        ordinal: 1,
        title: "灵纹初醒",
        sourceFragmentIds: ["frag_1", "frag_2"],
        coreEventFactIds: ["fact_awaken"],
      },
      {
        id: "episode_2",
        ordinal: 2,
        title: "踏上旅途",
        sourceFragmentIds: ["frag_3"],
        coreEventFactIds: ["fact_departure"],
      },
    ],
    majorAdaptationProposals: [
      {
        id: "proposal_merge",
        kind: "merge_characters",
        summary: "将两名引路人合并为一人",
        rationale: "减少短篇登场人物数量",
        affectedFactIds: ["fact_departure"],
      },
    ],
  });

  await assert.rejects(
    () => service.confirmEpisodePlan(actor, "project_1", "chapter_1", {
      expectedActiveVersionId: candidate.id,
    }),
    { code: "UNRESOLVED_MAJOR_ADAPTATION" },
  );

  const decided = await service.decideMajorAdaptation(actor, "project_1", "chapter_1", {
    expectedActiveVersionId: candidate.id,
    proposalId: "proposal_merge",
    decision: "approved",
    reason: "不改变核心事件，仅合并功能相同的人物",
  });
  const confirmed = await service.confirmEpisodePlan(actor, "project_1", "chapter_1", {
    expectedActiveVersionId: decided.id,
  });

  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.parentVersionId, decided.id);
  assert.equal(confirmed.confirmedBy, actor.userId);
  assert.deepEqual(confirmed.majorAdaptationProposals[0]?.decision, {
    outcome: "approved",
    reason: "不改变核心事件，仅合并功能相同的人物",
    decidedBy: actor.userId,
    decidedAt: "2026-10-01T08:00:00.000Z",
  });
  assert.deepEqual(confirmed.episodes.map(({ sourceFragmentIds, coreEventFactIds }) => ({ sourceFragmentIds, coreEventFactIds })), [
    { sourceFragmentIds: ["frag_1", "frag_2"], coreEventFactIds: ["fact_awaken"] },
    { sourceFragmentIds: ["frag_3"], coreEventFactIds: ["fact_departure"] },
  ]);

  const replayedDecision = await service.decideMajorAdaptation(actor, "project_1", "chapter_1", {
    expectedActiveVersionId: candidate.id,
    proposalId: "proposal_merge",
    decision: "approved",
    reason: "不改变核心事件，仅合并功能相同的人物",
  });
  const replayedConfirmation = await service.confirmEpisodePlan(actor, "project_1", "chapter_1", {
    expectedActiveVersionId: decided.id,
  });
  assert.equal(replayedDecision.id, decided.id);
  assert.equal(replayedConfirmation.id, confirmed.id);
});

test("编辑可以参与拆集但不能正式确认方案", async () => {
  const ids = ["plan_candidate", "plan_confirmed"];
  const service = new ScriptService({
    repository: new InMemoryScriptRepository(),
    accessReader: { async findProjectAccess() { return { role: "editor" }; } },
    upstreamReader: {
      async findConfirmedStoryBible() {
        return {
          versionId: "story_bible_v1",
          sourceVersionId: "source_v1",
          factIds: ["fact_awaken"],
          fragmentIds: ["frag_1"],
        };
      },
    },
    idGenerator: () => ids.shift() ?? "unexpected",
    clock: () => new Date("2026-10-01T08:00:00.000Z"),
  });
  const candidate = await service.recordEpisodePlan(actor, {
    expectedActiveVersionId: null,
    projectId: "project_1",
    chapterId: "chapter_1",
    sourceVersionId: "source_v1",
    storyBibleVersionId: "story_bible_v1",
    targetDurationSeconds: 60,
    aspectRatio: "16:9",
    narrativeMode: "dialogue",
    episodes: [{
      id: "episode_1",
      ordinal: 1,
      title: "灵纹初醒",
      sourceFragmentIds: ["frag_1"],
      coreEventFactIds: ["fact_awaken"],
    }],
    majorAdaptationProposals: [],
  });

  await assert.rejects(
    () => service.confirmEpisodePlan(actor, "project_1", "chapter_1", {
      expectedActiveVersionId: candidate.id,
    }),
    { code: "FORBIDDEN" },
  );
});

test("旧拆集方案不能覆盖新版本，已确认版本保持独立可读", async () => {
  const repository = new InMemoryScriptRepository();
  const ids = ["plan_candidate", "plan_decided", "plan_confirmed", "unexpected"];
  const service = new ScriptService({
    repository,
    accessReader: { async findProjectAccess() { return { role: "reviewer" }; } },
    upstreamReader: {
      async findConfirmedStoryBible() {
        return {
          versionId: "story_bible_v1", sourceVersionId: "source_v1",
          factIds: ["fact_awaken"], fragmentIds: ["frag_1"],
        };
      },
    },
    idGenerator: () => ids.shift() ?? "unexpected",
    clock: () => new Date("2026-10-01T08:00:00.000Z"),
  });
  const input = {
    expectedActiveVersionId: null,
    projectId: "project_1", chapterId: "chapter_1",
    sourceVersionId: "source_v1", storyBibleVersionId: "story_bible_v1",
    targetDurationSeconds: 60 as const, aspectRatio: "9:16" as const, narrativeMode: "narration" as const,
    episodes: [{ id: "episode_1", ordinal: 1, title: "觉醒", sourceFragmentIds: ["frag_1"], coreEventFactIds: ["fact_awaken"] }],
    majorAdaptationProposals: [{ id: "proposal_1", kind: "reorder_events" as const, summary: "调整揭示顺序", rationale: "强化开场", affectedFactIds: ["fact_awaken"] }],
  };
  const candidate = await service.recordEpisodePlan(actor, input);
  const decided = await service.decideMajorAdaptation(actor, "project_1", "chapter_1", {
    expectedActiveVersionId: candidate.id, proposalId: "proposal_1", decision: "rejected", reason: "保持原作顺序",
  });

  await assert.rejects(
    () => service.recordEpisodePlan(actor, { ...input, expectedActiveVersionId: candidate.id }),
    { code: "VERSION_CONFLICT" },
  );
  const confirmed = await service.confirmEpisodePlan(actor, "project_1", "chapter_1", { expectedActiveVersionId: decided.id });
  assert.equal((await repository.findConfirmedEpisodePlan(actor, "project_1", "chapter_1"))?.id, confirmed.id);
  const otherWorkspaceActor = { userId: "usr_other", workspaceId: "wsp_other" };
  assert.equal(await repository.findActiveEpisodePlan(otherWorkspaceActor, "project_1", "chapter_1"), null);
  assert.equal(await repository.findConfirmedEpisodePlan(otherWorkspaceActor, "project_1", "chapter_1"), null);
  assert.equal(await repository.findOperationResult(
    otherWorkspaceActor,
    "project_1",
    "chapter_1",
    `confirmation:${decided.id}`,
  ), null);
  await assert.rejects(
    () => service.recordEpisodePlan(actor, { ...input, expectedActiveVersionId: confirmed.id }),
    { code: "CONFIRMED_PLAN_REQUIRES_SUGGESTION" },
  );
  assert.equal((await repository.findConfirmedEpisodePlan(actor, "project_1", "chapter_1"))?.id, confirmed.id);
});

test("非项目成员不能提交拆集建议", async () => {
  const service = new ScriptService({
    repository: new InMemoryScriptRepository(),
    accessReader: { async findProjectAccess() { return null; } },
    upstreamReader: { async findConfirmedStoryBible() { throw new Error("不应读取上游内容"); } },
    idGenerator: () => "unexpected",
    clock: () => new Date("2026-10-01T08:00:00.000Z"),
  });

  await assert.rejects(() => service.recordEpisodePlan(actor, {
    expectedActiveVersionId: null,
    projectId: "project_other", chapterId: "chapter_1",
    sourceVersionId: "source_v1", storyBibleVersionId: "story_bible_v1",
    targetDurationSeconds: 60, aspectRatio: "9:16", narrativeMode: "narration",
    episodes: [{ id: "episode_1", ordinal: 1, title: "觉醒", sourceFragmentIds: ["frag_1"], coreEventFactIds: ["fact_1"] }],
    majorAdaptationProposals: [],
  }), { code: "FORBIDDEN" });
});

test("拆集建议拒绝不受支持的时长以及脱离上游证据的集", async () => {
  const makeService = () => new ScriptService({
    repository: new InMemoryScriptRepository(),
    accessReader: { async findProjectAccess() { return { role: "owner" as const }; } },
    upstreamReader: {
      async findConfirmedStoryBible() {
        return { versionId: "story_bible_v1", sourceVersionId: "source_v1", factIds: ["fact_1"], fragmentIds: ["frag_1"] };
      },
    },
    idGenerator: () => "unexpected",
    clock: () => new Date("2026-10-01T08:00:00.000Z"),
  });
  const valid = {
    expectedActiveVersionId: null,
    projectId: "project_1", chapterId: "chapter_1",
    sourceVersionId: "source_v1", storyBibleVersionId: "story_bible_v1",
    targetDurationSeconds: 60 as const, aspectRatio: "9:16" as const, narrativeMode: "narration" as const,
    episodes: [{ id: "episode_1", ordinal: 1, title: "觉醒", sourceFragmentIds: ["frag_1"], coreEventFactIds: ["fact_1"] }],
    majorAdaptationProposals: [],
  };

  await assert.rejects(
    () => makeService().recordEpisodePlan(actor, { ...valid, targetDurationSeconds: 120 as 60 }),
    { code: "INVALID_EPISODE_PLAN" },
  );
  await assert.rejects(
    () => makeService().recordEpisodePlan(actor, { ...valid, episodes: [{ ...valid.episodes[0]!, sourceFragmentIds: ["frag_unknown"] }] }),
    { code: "INVALID_EPISODE_PLAN" },
  );
  await assert.rejects(
    () => makeService().recordEpisodePlan(actor, { ...valid, episodes: [{ ...valid.episodes[0]!, coreEventFactIds: ["fact_unknown"] }] }),
    { code: "INVALID_EPISODE_PLAN" },
  );
});
