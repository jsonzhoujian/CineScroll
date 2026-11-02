import type { ScriptContentVersion, ScriptGenerationContext } from "../src/script-content.ts";
export const version: ScriptContentVersion = {
  id: "script_1", parentVersionId: null, projectId: "p", chapterId: "c", sourceVersionId: "source_1", planVersionId: "plan_1", jobId: "job",
  status: "candidate", generationStatus: "succeeded", createdBy: "owner", createdAt: "2026-10-01", failures: [],
  scenes: [{ id: "scene_1", episodeId: "episode_1", ordinal: 1, title: "庭院", environment: "晨光", characters: ["少年"] }],
  elements: [{ id: "e1", sceneId: "scene_1", elementType: "action", ordinal: 1, text: "少年起身。",
    provenance: [{ type: "source_fragment", sourceVersionId: "source_1", fragmentId: "f1", transformation: "retained" }] }],
};
export const context: ScriptGenerationContext = {
  planVersionId: "plan_1", sourceVersionId: "source_1", fragments: [{ id: "f1", text: "少年起身。" }], approvedAdditionIds: [],
  confirmedPlan: { id: "plan_1", parentVersionId: null, projectId: "p", chapterId: "c", sourceVersionId: "source_1", status: "confirmed",
    storyBibleVersionId: "bible_1", targetDurationSeconds: 60, aspectRatio: "9:16", narrativeMode: "narration", createdBy: "owner", createdAt: "2026-10-01",
    majorAdaptationProposals: [], episodes: [{ id: "episode_1", ordinal: 1, title: "起身", sourceFragmentIds: ["f1"], coreEventFactIds: ["fact_1"] }] },
  confirmedStoryKnowledge: { versionId: "bible_1", facts: [{ id: "fact_1", statement: "少年起身。" }] },
};
export const verdict = { versionId: "script_1", events: [{ factId: "fact_1", elementIds: ["e1"], verdict: "covered" }],
  facts: [{ factId: "fact_1", verdict: "consistent" }], unsupportedCoreFactElementIds: [], episodes: [{ episodeId: "episode_1", estimatedSeconds: 60 }] };

