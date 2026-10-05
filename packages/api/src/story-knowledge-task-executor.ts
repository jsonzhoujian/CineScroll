import type { Actor } from "@novel-adaptation/identity";
import type { ProjectImportRepository } from "@novel-adaptation/project-import";
import { ModelTaskError, TaskExecutionError, type ModelTaskService } from "@novel-adaptation/script/model-tasks";
import { StoryKnowledgeError, StoryKnowledgeSourceChangedError, type StoryKnowledgeService } from "@novel-adaptation/story-knowledge";
import { StoryKnowledgeExtractionRunner, StoryKnowledgeModelError, type StoryKnowledgeGenerationRequest } from "@novel-adaptation/story-knowledge/extraction-adapter";

type Credentials = { apiKey: string; providerId: string; modelId: string; processingRegion: "mainland" };
export interface CredentialedStoryKnowledgeModel {
  /** Trusted transport only. Never persist or return credentials in model output. */
  generate(request: StoryKnowledgeGenerationRequest, credentials: Credentials): Promise<unknown>;
}
type Options = { tasks: ModelTaskService; projects: Pick<ProjectImportRepository, "findProjectAccess" | "findChapter">;
  storyKnowledge: StoryKnowledgeService; model: CredentialedStoryKnowledgeModel };

/** Initial extraction only; existing candidates require a separate, explicitly scoped regeneration flow. */
export class StoryKnowledgeTaskExecutor {
  readonly #options: Options;
  constructor(options: Options) { this.#options = options; }
  async recover(actor: Actor, id: string) {
    return this.#options.tasks.recover(actor, id, async task => {
      if (task.input.stage !== "story_knowledge") throw new ModelTaskError("TASK_NOT_FOUND");
      const candidate = await this.#options.storyKnowledge.getInitialExtraction(actor, task.projectId, task.chapterId, task.id);
      if (!candidate || candidate.sourceVersionId !== task.input.sourceVersionId) return null;
      return { candidateVersionId: candidate.id, extractionStatus: candidate.extractionStatus };
    });
  }
  async run(actor: Actor, id: string) {
    const { tasks, projects, storyKnowledge, model } = this.#options;
    const task = await tasks.get(actor, id);
    if (task.input.stage !== "story_knowledge") throw new ModelTaskError("TASK_NOT_FOUND");
    return tasks.run(actor, id, async credentials => {
      try {
        try {
          await storyKnowledge.getActive(actor, task.projectId, task.chapterId);
          throw new TaskExecutionError("CANDIDATE_EXISTS");
        } catch (error) {
          if (!(error instanceof StoryKnowledgeError && error.code === "STAGE_RESULT_NOT_FOUND")) throw error;
        }
        const readSource = async () => {
          if (!await projects.findProjectAccess(actor, task.projectId)) throw new ModelTaskError("TASK_NOT_FOUND");
          const chapter = await projects.findChapter(actor, task.projectId, task.chapterId);
          if (chapter?.activeSourceVersionId !== task.input.sourceVersionId) throw new TaskExecutionError("UPSTREAM_CHANGED");
          const source = chapter.versions.find(version => version.id === task.input.sourceVersionId);
          if (!source) throw new TaskExecutionError("UPSTREAM_CHANGED");
          return source;
        };
        const source = await readSource();
        const request: StoryKnowledgeGenerationRequest = {
          contractVersion: "0.1.0", jobId: task.id, stage: "storyKnowledge", projectId: task.projectId, chapterId: task.chapterId,
          sourceVersionId: source.id, upstreamConfirmedVersionIds: [],
          scopeKeys: ["characters", "relationships", "events", "locations", "props", "worldRules"],
          generationParameters: task.input.generationParameters,
          input: { sourceFragments: source.fragments.map(({ id, text }) => ({ id, text })), confirmedUpstreamContent: [], approvedAdditionIds: [], lockedItemIds: [] },
        };
        const runner = new StoryKnowledgeExtractionRunner({ storyKnowledge, model: { async generate(snapshot) {
          const response = await model.generate(snapshot, { apiKey: credentials.apiKey, providerId: credentials.providerId,
            modelId: credentials.modelId, processingRegion: credentials.processingRegion });
          await readSource();
          return response;
        } } });
        const candidate = await runner.run(actor, request, null);
        return { candidateVersionId: candidate.id, extractionStatus: candidate.extractionStatus };
      } catch (error) {
        if (error instanceof StoryKnowledgeModelError && error.code === "INVALID_RESPONSE") throw new TaskExecutionError("INVALID_RESPONSE");
        if (error instanceof StoryKnowledgeSourceChangedError) throw new TaskExecutionError("UPSTREAM_CHANGED");
        if (error instanceof StoryKnowledgeError && error.code === "VERSION_CONFLICT") throw new TaskExecutionError("CANDIDATE_EXISTS");
        throw error;
      }
    });
  }
}
