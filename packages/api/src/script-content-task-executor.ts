import type { Actor } from "@novel-adaptation/script";
import { ScriptRunner, ScriptModelError } from "@novel-adaptation/script/script-runner";
import { ScriptContentError, type ScriptContentRepository, type ScriptContentService } from "@novel-adaptation/script/script-content";
import { ModelTaskError, TaskExecutionError, type ModelTaskService, type ModelTask } from "@novel-adaptation/script/model-tasks";
import type { ScriptContentContext } from "./script-content-context.ts";
export interface CredentialedScriptContentModel {
  generate(request: Parameters<import("@novel-adaptation/script/script-runner").ScriptModelPort["generate"]>[0],credentials: { apiKey: string;providerId: string;modelId: string;processingRegion: "mainland" }): Promise<unknown>;
}
export class ScriptContentTaskExecutor {
  private readonly options: { tasks: ModelTaskService;context: ScriptContentContext;repository: ScriptContentRepository;service: ScriptContentService;model: CredentialedScriptContentModel };
  constructor(options: ScriptContentTaskExecutor["options"]) { this.options = options; }
  async recover(actor: Actor,id: string) {
    return this.options.tasks.recover(actor,id,async task => {
      this.kind(task);
      const candidate = await this.options.repository.findGeneration?.(actor,task.projectId,task.chapterId,task.id);
      if (!candidate || candidate.jobId !== task.id || candidate.sourceVersionId !== task.input.sourceVersionId || candidate.planVersionId !== task.input.upstreamConfirmedVersionIds[0]) return null;
      return { candidateVersionId: candidate.id,extractionStatus: candidate.generationStatus };
    });
  }
  private kind(task: ModelTask) { if (task.input.resultType !== "scriptContent" || task.input.stage !== "script") throw new ModelTaskError("TASK_NOT_FOUND"); }
  async run(actor: Actor,id: string,signal?: AbortSignal) {
    const { tasks,context,repository,service,model } = this.options;
    const task = await tasks.get(actor,id); this.kind(task);
    return tasks.run(actor,id,async credentials => {
      const guard = async () => {
        await tasks.assertGenerationAllowed(actor,task.projectId,task.chapterId,task.input);
        const current = await context.read(actor,task.projectId,task.chapterId);
        if (!current || current.sourceVersionId !== task.input.sourceVersionId || current.resultType !== task.input.resultType
          || current.upstreamConfirmedVersionIds.length !== task.input.upstreamConfirmedVersionIds.length
          || current.upstreamConfirmedVersionIds.some((id,i) => id !== task.input.upstreamConfirmedVersionIds[i])
          || current.generationParameters.targetDurationSeconds !== task.input.generationParameters.targetDurationSeconds
          || current.generationParameters.aspectRatio !== task.input.generationParameters.aspectRatio
          || current.generationParameters.narrativeMode !== task.input.generationParameters.narrativeMode) throw new TaskExecutionError("UPSTREAM_CHANGED");
      };
      await guard();
      if (await repository.findActive(actor,task.projectId,task.chapterId)) throw new TaskExecutionError("CANDIDATE_EXISTS");
      let guardedError: TaskExecutionError | null = null;
      try {
        const runner = new ScriptRunner({ contextReader: context,service,model: { async generate(request) {
          const response = await model.generate(request,credentials);
          try { await guard(); } catch (error) { guardedError = error instanceof TaskExecutionError ? error : new TaskExecutionError("EXECUTION_UNCERTAIN"); throw guardedError; }
          return response;
        } } });
        const candidate = await runner.run(actor,{ projectId: task.projectId,chapterId: task.chapterId,jobId: task.id,expectedActiveVersionId: null,generationParameters: task.input.generationParameters });
        return { candidateVersionId: candidate.id,extractionStatus: candidate.generationStatus };
      } catch (error) {
        if (guardedError) throw guardedError;
        if (error instanceof ScriptContentError && error.code === "CONTEXT_NOT_FOUND") throw new TaskExecutionError("UPSTREAM_CHANGED");
        if (error instanceof ScriptContentError && error.code === "STORAGE_UNAVAILABLE" || error instanceof ScriptModelError && error.code === "PROVIDER_UNAVAILABLE") throw new TaskExecutionError("EXECUTION_UNCERTAIN");
        if (error instanceof ScriptContentError && error.code === "VERSION_CONFLICT") throw new TaskExecutionError("CANDIDATE_EXISTS");
        if (error instanceof ScriptModelError && error.code === "INVALID_RESPONSE" || error instanceof ScriptContentError && error.code === "INVALID_GENERATION") throw new TaskExecutionError("INVALID_RESPONSE");
        throw error;
      }
    },signal);
  }
}
