import type { Actor } from "@novel-adaptation/identity";
import type { ProjectImportRepository } from "@novel-adaptation/project-import";
import { ScriptError, ScriptUpstreamChangedError, type ScriptService } from "@novel-adaptation/script";
import { ModelTaskError, TaskExecutionError, type ModelTaskContextReader, type ModelTaskService, type TaskInput } from "@novel-adaptation/script/model-tasks";
import { EpisodePlanRunner, EpisodePlanModelError, type EpisodePlanGenerationRequest } from "@novel-adaptation/script/episode-plan-runner";
import { StoryKnowledgeError, type StoryKnowledgeService } from "@novel-adaptation/story-knowledge";

type Projects = Pick<ProjectImportRepository, "findProjectAccess" | "findProject" | "findChapter">;
type Credentials = { apiKey: string; providerId: string; modelId: string; processingRegion: "mainland" };
export interface CredentialedEpisodePlanModel {
  generate(request: EpisodePlanGenerationRequest, credentials: Credentials): Promise<unknown>;
}
/** Reads authoritative generation prerequisites, never client-supplied content. */
export class EpisodePlanTaskContext implements ModelTaskContextReader {
  readonly #projects: Projects; readonly #knowledge: StoryKnowledgeService;
  constructor(projects: Projects, knowledge: StoryKnowledgeService) { this.#projects = projects; this.#knowledge = knowledge; }
  async canRead(actor: Actor, p: string, c: string): Promise<boolean> {
    return !!await this.#projects.findProjectAccess(actor,p) && !!await this.#projects.findChapter(actor,p,c);
  }
  async read(actor: Actor, p: string, c: string): Promise<TaskInput | null> {
    if (!await this.#projects.findProjectAccess(actor,p)) return null;
    const project = await this.#projects.findProject(actor,p), chapter = await this.#projects.findChapter(actor,p,c);
    const source = chapter?.versions.find(v => v.id === chapter.activeSourceVersionId);
    if (!project || project.workspaceId !== actor.workspaceId || !source || !source.text.trim() || !source.fragments.length || source.characterCount > 20_000) return null;
    try {
      const bible = await this.#knowledge.getConfirmedStoryBible(actor,p,c);
      const version = await this.#knowledge.getVersion(actor,p,c,bible.versionId);
      if (version.status !== "confirmed" || version.sourceVersionId !== source.id) return null;
      return { stage: "script", resultType: "episodePlan", sourceVersionId: source.id, upstreamConfirmedVersionIds: [bible.versionId], generationParameters: {
        targetDurationSeconds: project.targetDurationSeconds, aspectRatio: project.aspectRatio, narrativeMode: project.narrativeMode,
      } };
    } catch (error) { if (error instanceof StoryKnowledgeError && error.code === "STAGE_RESULT_NOT_FOUND") return null; throw error; }
  }
}
type Options = { tasks: ModelTaskService; projects: Projects; knowledge: StoryKnowledgeService; script: ScriptService; model: CredentialedEpisodePlanModel };
export class EpisodePlanTaskExecutor {
  readonly #options: Options;
  constructor(options: Options) { this.#options = options; }
  async recover(actor: Actor, id: string) {
    return this.#options.tasks.recover(actor,id,async task => {
      if (task.input.stage !== "script" || task.input.resultType !== "episodePlan") throw new ModelTaskError("TASK_NOT_FOUND");
      const candidate = await this.#options.script.getEpisodePlanGeneration(actor,task.projectId,task.chapterId,task.id);
      if (!candidate || candidate.sourceVersionId !== task.input.sourceVersionId || task.input.upstreamConfirmedVersionIds.length !== 1
        || candidate.storyBibleVersionId !== task.input.upstreamConfirmedVersionIds[0]
        || candidate.targetDurationSeconds !== task.input.generationParameters.targetDurationSeconds
        || candidate.aspectRatio !== task.input.generationParameters.aspectRatio || candidate.narrativeMode !== task.input.generationParameters.narrativeMode) return null;
      return { candidateVersionId: candidate.id, extractionStatus: "succeeded" };
    });
  }
  async run(actor: Actor, id: string, signal?: AbortSignal) {
    const { tasks, projects, knowledge, script, model } = this.#options;
    const task = await tasks.get(actor,id);
    if (task.input.stage !== "script" || task.input.resultType !== "episodePlan") throw new ModelTaskError("TASK_NOT_FOUND");
    return tasks.run(actor,id,async credentials => {
      let guardedError: unknown;
      try {
        try { await script.getEpisodePlan(actor,task.projectId,task.chapterId); throw new TaskExecutionError("CANDIDATE_EXISTS"); }
        catch (error) { if (!(error instanceof ScriptError && error.code === "EPISODE_PLAN_NOT_FOUND")) throw error; }
        const readUpstream = async () => {
          await tasks.assertGenerationAllowed(actor,task.projectId,task.chapterId,task.input);
          if (!await projects.findProjectAccess(actor,task.projectId)) throw new TaskExecutionError("UPSTREAM_CHANGED");
          const project = await projects.findProject(actor,task.projectId);
          const parameters = task.input.generationParameters;
          if (!project || project.workspaceId !== actor.workspaceId || project.targetDurationSeconds !== parameters.targetDurationSeconds
            || project.aspectRatio !== parameters.aspectRatio || project.narrativeMode !== parameters.narrativeMode) throw new TaskExecutionError("UPSTREAM_CHANGED");
          const chapter = await projects.findChapter(actor,task.projectId,task.chapterId);
          const source = chapter?.versions.find(v => v.id === chapter.activeSourceVersionId);
          if (!source || source.id !== task.input.sourceVersionId) throw new TaskExecutionError("UPSTREAM_CHANGED");
          const bible = await knowledge.getConfirmedStoryBible(actor,task.projectId,task.chapterId);
          if (bible.versionId !== task.input.upstreamConfirmedVersionIds[0]) throw new TaskExecutionError("UPSTREAM_CHANGED");
          return { source, bible };
        };
        const { source,bible } = await readUpstream();
        const request: EpisodePlanGenerationRequest = { contractVersion: "0.1.0", jobId: task.id, stage: "script", projectId: task.projectId, chapterId: task.chapterId,
          sourceVersionId: source.id, upstreamConfirmedVersionIds: task.input.upstreamConfirmedVersionIds, scopeKeys: ["episode-plan"], generationParameters: task.input.generationParameters,
          input: { sourceFragments: source.fragments.map(({ id,text }) => ({ id,text })),
            // No user core-event classifier exists yet: conservatively require every accepted event.
            confirmedUpstreamContent: bible.facts.map(({ id,factType,statement }) => ({ id,factType,statement,isCoreEvent: factType === "event" })), approvedAdditionIds: [], lockedItemIds: [] } };
        const runner = new EpisodePlanRunner({ script, model: { async generate(snapshot) {
          const response = await model.generate(snapshot,{ apiKey: credentials.apiKey, providerId: credentials.providerId, modelId: credentials.modelId, processingRegion: credentials.processingRegion });
          try { await readUpstream(); } catch (error) { guardedError = error; throw error; }
          return response;
        } } });
        const candidate = await runner.run(actor,request,null);
        return { candidateVersionId: candidate.id, extractionStatus: "succeeded" };
      } catch (caught) {
        const error = guardedError ?? caught;
        if (error instanceof TaskExecutionError) throw error;
        if (error instanceof ScriptUpstreamChangedError) throw new TaskExecutionError("UPSTREAM_CHANGED");
        if (error instanceof ModelTaskError && error.code === "POLICY_RESTRICTED") throw new TaskExecutionError("POLICY_RESTRICTED");
        if (error instanceof EpisodePlanModelError && ["INVALID_REQUEST","INVALID_RESPONSE"].includes(error.code)) throw new TaskExecutionError("INVALID_RESPONSE");
        if (error instanceof ScriptError && error.code === "VERSION_CONFLICT") throw new TaskExecutionError("CANDIDATE_EXISTS");
        if (error instanceof StoryKnowledgeError && error.code === "STAGE_RESULT_NOT_FOUND" || error instanceof ScriptError && error.code === "CONFIRMED_STORY_BIBLE_NOT_FOUND") throw new TaskExecutionError("UPSTREAM_CHANGED");
        throw error;
      }
    },signal);
  }
}
