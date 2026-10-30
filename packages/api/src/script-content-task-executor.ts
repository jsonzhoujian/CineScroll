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
      if (!candidate || candidate.jobId !== task.id || candidate.sourceVersionId !== task.input.sourceVersionId || candidate.planVersionId !== task.input.upstreamConfirmedVersionIds[0]
        || task.input.retry && (candidate.parentVersionId !== task.input.retry.expectedActiveVersionId || candidate.retry?.retryOfJobId !== task.input.retry.retryOfJobId || candidate.retry.scopeKeys.length !== task.input.retry.scopeKeys.length || candidate.retry.scopeKeys.some(s => !task.input.retry!.scopeKeys.includes(s)))) return null;
      if (task.input.retry?.failureOrigins && (candidate.retry?.failureOrigins?.length !== task.input.retry.failureOrigins.length
        || task.input.retry.failureOrigins.some(f => !candidate.retry?.failureOrigins?.some(other => other.scopeKey === f.scopeKey && other.jobId === f.jobId)))) return null;
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
        let current;
        try { current = task.input.retry ? await context.readRetry(actor,task.projectId,task.chapterId,task.input.retry) : await context.read(actor,task.projectId,task.chapterId); }
        catch (error) { if (error instanceof ModelTaskError && ["UPSTREAM_CHANGED","INVALID_CONTEXT","TASK_NOT_FOUND"].includes(error.code)) throw new TaskExecutionError("UPSTREAM_CHANGED"); throw error; }
        if (!current || current.sourceVersionId !== task.input.sourceVersionId || current.resultType !== task.input.resultType
          || current.upstreamConfirmedVersionIds.length !== task.input.upstreamConfirmedVersionIds.length
          || current.upstreamConfirmedVersionIds.some((id,i) => id !== task.input.upstreamConfirmedVersionIds[i])
          || current.generationParameters.targetDurationSeconds !== task.input.generationParameters.targetDurationSeconds
          || current.generationParameters.aspectRatio !== task.input.generationParameters.aspectRatio
          || current.generationParameters.narrativeMode !== task.input.generationParameters.narrativeMode) throw new TaskExecutionError("UPSTREAM_CHANGED");
      };
      await guard();
      const active = await repository.findActive(actor,task.projectId,task.chapterId);
      if (!task.input.retry && active) throw new TaskExecutionError("CANDIDATE_EXISTS");
      if (task.input.retry && active?.id !== task.input.retry.expectedActiveVersionId) throw new TaskExecutionError("UPSTREAM_CHANGED");
      let guardedError: TaskExecutionError | null = null;
      let modelInvoked = false;
      try {
        const runner = new ScriptRunner({ contextReader: context,service,model: { async generate(request) {
          modelInvoked = true;
          const response = await model.generate(request,credentials);
          try { await guard(); } catch (error) { guardedError = error instanceof TaskExecutionError ? error : new TaskExecutionError("EXECUTION_UNCERTAIN"); throw guardedError; }
          return response;
        } } });
        const candidate = await runner.run(actor,{ projectId: task.projectId,chapterId: task.chapterId,jobId: task.id,expectedActiveVersionId: task.input.retry?.expectedActiveVersionId ?? null,...(task.input.retry ? { retry: task.input.retry } : {}),generationParameters: task.input.generationParameters });
        return { candidateVersionId: candidate.id,extractionStatus: candidate.generationStatus };
      } catch (error) {
        if (guardedError) throw guardedError;
        if (error instanceof ScriptContentError && error.code === "CONTEXT_NOT_FOUND") throw new TaskExecutionError("UPSTREAM_CHANGED");
        if (error instanceof ScriptContentError && error.code === "STORAGE_UNAVAILABLE" || error instanceof ScriptModelError && error.code === "PROVIDER_UNAVAILABLE") throw new TaskExecutionError("EXECUTION_UNCERTAIN");
        if (error instanceof ScriptContentError && error.code === "VERSION_CONFLICT") throw new TaskExecutionError(task.input.retry ? "UPSTREAM_CHANGED" : "CANDIDATE_EXISTS");
        if (error instanceof ScriptModelError && error.code === "INVALID_RESPONSE" || error instanceof ScriptContentError && error.code === "INVALID_GENERATION") throw new TaskExecutionError("INVALID_RESPONSE");
        if (modelInvoked) throw new TaskExecutionError("EXECUTION_UNCERTAIN");
        throw error;
      }
    },signal);
  }
}
