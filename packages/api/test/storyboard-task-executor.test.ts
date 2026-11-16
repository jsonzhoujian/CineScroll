import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryModelTaskRepository, ModelTaskService } from "@novel-adaptation/script/model-tasks";
import { InMemoryModelSettingsRepository, WorkspaceModelSettings } from "@novel-adaptation/script/model-settings";
import type { ConfirmedStoryboardHandoff } from "@novel-adaptation/script/storyboard-handoff";
import type { StoryboardCandidate } from "@novel-adaptation/script/storyboard-runner";
import fixture from "../../../docs/contracts/fixtures/ai/valid-storyboard.json" with { type: "json" };
import { context, version } from "../../script/test/script-quality-fixture.ts";
import { StoryboardTaskDispatcher } from "../src/storyboard-task-dispatcher.ts";
import { StoryboardTaskExecutor, storyboardTaskContext } from "../src/storyboard-task-executor.ts";

test("storyboard executor claims once and reconciles an ambiguous save from the original result", async () => {
  const actor = { userId: "owner", workspaceId: "studio" };
  const { projectId, chapterId, sourceVersionId } = fixture;
  const ids = ["cv_ss1", "cv_st1", "plan", "bible"];
  const handoff: Pick<ConfirmedStoryboardHandoff, "read"> = { async read() {
    return {
      sourceVersionId, upstreamConfirmedVersionIds: ids,
      script: { version, sourceFragments: context.fragments, upstreamConfirmedVersionIds: ids.slice(2) },
      settings: {
        projectId, chapterId, sourceVersionId, upstreamConfirmedVersionIds: [ids[0]!, ...ids.slice(2)],
        id: ids[1]!, jobId: "settings-job", scriptVersionId: ids[0]!, status: "confirmed",
        assets: [], failures: [], generationStatus: "succeeded", createdBy: actor.userId,
        createdAt: "2026-11-07", parentVersionId: null, suggestions: [], locks: {},
      },
      context: {
        sourceVersionId, scenes: [{ id: "scene_s1", episodeId: "ep_s1", scriptElementIds: ["se_s1"] }],
        assetIds: ["asset_s1"], fragmentIds: ["frag_s1"], approvedAdditionIds: [],
      },
    };
  } };
  const candidates = new Map<string, StoryboardCandidate>();
  let loseResponse = true;
  const repository = {
    async findGeneration(_actor: typeof actor, identity: { jobId: string }) { return candidates.get(identity.jobId) ?? null; },
    async saveGeneration(_actor: typeof actor, candidate: StoryboardCandidate) {
      candidates.set(candidate.jobId, candidate);
      if (loseResponse) throw new Error("commit response lost");
      return candidate;
    },
  };
  const reader = storyboardTaskContext({
    canRead: async a => a.workspaceId === actor.workspaceId,
    read: async () => ({
      stage: "script", resultType: "scriptContent", sourceVersionId, upstreamConfirmedVersionIds: ids.slice(2),
      generationParameters: { targetDurationSeconds: 60, aspectRatio: "9:16", narrativeMode: "dialogue" },
    }),
  }, handoff, repository);
  let sequence = 0;
  const settings = new WorkspaceModelSettings({
    repository: new InMemoryModelSettingsRepository(), encryptionKey: new Uint8Array(32).fill(7),
    access: { read: async () => ({ owner: true, advanced: true }) }, idGenerator: () => `version-${++sequence}`,
    probe: { processingRegion: () => "mainland", test: async () => ({ modelIds: ["model"], processingRegion: "mainland" }) },
  });
  const config = await settings.configure(actor, { expectedVersionId: null, providerId: "deepseek", apiKey: "fixture-key" });
  const tested = await settings.testConnection(actor, config.id);
  const taskRepository = new InMemoryModelTaskRepository(Date.now, () => ({ maxQueued: 10, maxExecuting: 10 }));
  const tasks = new ModelTaskService({
    settings, contextReader: reader, generationPolicy: { isAllowed: async () => true },
    repository: taskRepository,
    storyboardAdmission: { workspaceIds: [actor.workspaceId], providerIds: ["deepseek"] }, idGenerator: () => `task-${++sequence}`,
  });
  const task = await tasks.submitStoryboard(actor, { projectId, chapterId, configurationVersionId: tested.id, modelId: "model", requestId: "original" });
  let calls = 0;
  const executor = new StoryboardTaskExecutor({
    tasks, handoff, context: reader,
    repository,
    model: { async generate(request) {
      calls++;
      const identity = { ...fixture, jobId: request.jobId, upstreamConfirmedVersionIds: request.upstreamConfirmedVersionIds };
      if (request.scopeKeys) {
        assert.deepEqual(request.scopeKeys, ["shot:2"]);
        assert.equal(request.retryOfJobId, task.id);
        const shot = { ...fixture.items[0]!, scopeKey: "shot:2", value: { ...fixture.items[0]!.value, id: "shot_s2" } };
        return { ...identity, items: calls === 3 ? [shot, fixture.items[0]] : [shot] };
      }
      const failures = ["shot:2", "shot:3"].map(scopeKey => ({ scopeKey, status: "failed", error: { code: "FAILED", message: "", retryable: true } }));
      return { ...identity, status: "partially_succeeded", items: [...fixture.items, ...failures] };
    } },
  });
  await assert.rejects(() => executor.run({ ...actor, userId: "other" }, task.id), { code: "TASK_NOT_FOUND" });
  const outcomes = await Promise.allSettled([executor.run(actor, task.id), executor.run(actor, task.id)]);
  const completed = outcomes.find(outcome => outcome.status === "fulfilled");
  assert.equal(completed?.value.reason, "EXECUTION_UNCERTAIN");
  assert.equal(outcomes.filter(outcome => outcome.status === "rejected").length, 1);
  const dispatcher = new StoryboardTaskDispatcher(taskRepository, executor);
  const page = { limit: 20, cursor: null };
  assert.deepEqual((await dispatcher.tick(actor.workspaceId, "recover", page)).items, [
    { id: task.id, outcome: "completed", state: "succeeded", reason: null },
  ]);
  const recovered = await tasks.get(actor, task.id);
  assert.deepEqual(recovered.result, { candidateVersionId: task.id, extractionStatus: "partially_succeeded" });
  assert.equal(recovered.state, "succeeded");
  assert.equal(calls, 1);

  loseResponse = false;
  const selection = { projectId, chapterId, configurationVersionId: tested.id, modelId: "model", requestId: "selected",
    expectedActiveVersionId: task.id, scopeKeys: ["shot:2"] };
  await assert.rejects(() => tasks.submitStoryboardRetry(actor, { ...selection, scopeKeys: ["shot:1"] }), { code: "UPSTREAM_CHANGED" });
  const retry = await tasks.submitStoryboardRetry(actor, selection);
  assert.equal((await tasks.submitStoryboardRetry(actor, selection)).id, retry.id);
  assert.equal((await dispatcher.tick(actor.workspaceId, "run", page)).items[0]?.state, "succeeded");
  const original = candidates.get(task.id)!;
  const merged = candidates.get(retry.id)!;
  assert.deepEqual(merged.shots.map(shot => shot.id), ["shot_s1", "shot_s2"]);
  assert.deepEqual(merged.shots[0], original.shots[0]);
  assert.deepEqual(merged.failures, [original.failures[1]]);
  assert.equal(original.failures.length, 2);
  const extra = await tasks.submitStoryboardRetry(actor, { ...selection, requestId: "overbroad" });
  assert.equal((await dispatcher.tick(actor.workspaceId, "run", page)).items[0]?.reason, "INVALID_RESPONSE");
  assert.equal(candidates.has(extra.id), false);
  assert.equal(calls, 3);
});
