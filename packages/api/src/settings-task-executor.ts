import type { Actor } from "@novel-adaptation/script";
import type { ConfirmedScriptHandoff } from "@novel-adaptation/script/script-handoff";
import { ScriptContentError } from "@novel-adaptation/script/script-content";
import { SettingsContentError } from "@novel-adaptation/script/settings-content";
import { SettingsRunner,SettingsGenerationError,type SettingsCandidate,type SettingsCandidateRepository,type SettingsGenerationRequest } from "@novel-adaptation/script/settings-runner";
import { ModelTaskError,TaskExecutionError,type ModelTask,type ModelTaskContextReader,type ModelTaskService,type TaskInput } from "@novel-adaptation/script/model-tasks";

type Handoff = Pick<ConfirmedScriptHandoff,"read">;
/** Reuses script context for membership and project parameters; formal script is an additional authority. */
export class SettingsTaskContext implements ModelTaskContextReader {
  private readonly script: ModelTaskContextReader;
  private readonly handoff: Handoff;
  constructor(script: ModelTaskContextReader,handoff: Handoff) { this.script = script;this.handoff = handoff; }
  async canRead(a: Actor,p: string,c: string) { return await this.script.canRead?.(a,p,c) === true; }
  async read(a: Actor,p: string,c: string): Promise<TaskInput | null> {
    const context = await this.script.read(a,p,c);
    if (!context) return null;
    if (context.stage !== "script" || context.resultType !== "scriptContent") throw new ModelTaskError("INVALID_CONTEXT");
    try {
      const formal = await this.handoff.read(a,p,c);
      if (formal.version.sourceVersionId !== context.sourceVersionId || formal.upstreamConfirmedVersionIds.length !== context.upstreamConfirmedVersionIds.length
        || formal.upstreamConfirmedVersionIds.some((id,i) => id !== context.upstreamConfirmedVersionIds[i])) throw new ModelTaskError("UPSTREAM_CHANGED");
      return { stage: "settings",resultType: "settingsContent",sourceVersionId: context.sourceVersionId,
        upstreamConfirmedVersionIds: [formal.version.id,...formal.upstreamConfirmedVersionIds],generationParameters: { ...context.generationParameters } };
    } catch (error) {
      if (error instanceof ScriptContentError && ["CONTEXT_NOT_FOUND","INVALID_STATE"].includes(error.code)) throw new ModelTaskError("UPSTREAM_CHANGED");
      throw error;
    }
  }
}
export interface CredentialedSettingsModel {
  generate(request: SettingsGenerationRequest,credentials: { apiKey: string;providerId: string;modelId: string;processingRegion: "mainland" }): Promise<unknown>;
}
type Repository = SettingsCandidateRepository & { findActive(a: Actor,p: string,c: string): Promise<SettingsCandidate | null> };
export class SettingsTaskExecutor {
  private readonly options: { tasks: ModelTaskService;context: SettingsTaskContext;handoff: Handoff;repository: Repository;model: CredentialedSettingsModel;idGenerator(): string;clock(): Date };
  constructor(options: SettingsTaskExecutor["options"]) { this.options = options; }
  private kind(task: ModelTask) { if (task.input.stage !== "settings" || task.input.resultType !== "settingsContent") throw new ModelTaskError("TASK_NOT_FOUND"); }
  async recover(a: Actor,id: string) {
    return this.options.tasks.recover(a,id,async task => {
      this.kind(task);
      const v = await this.options.repository.findGeneration(a,task.projectId,task.chapterId,task.id);
      if (!v || v.status !== "candidate" || v.createdBy !== task.createdBy || v.jobId !== task.id || v.projectId !== task.projectId || v.chapterId !== task.chapterId || v.sourceVersionId !== task.input.sourceVersionId
        || v.scriptVersionId !== task.input.upstreamConfirmedVersionIds[0] || v.upstreamConfirmedVersionIds.length !== task.input.upstreamConfirmedVersionIds.length
        || v.upstreamConfirmedVersionIds.some((id,i) => id !== task.input.upstreamConfirmedVersionIds[i])) return null;
      return { candidateVersionId: v.id,extractionStatus: v.generationStatus };
    });
  }
  async run(a: Actor,id: string,signal?: AbortSignal) {
    const { tasks,context,handoff,repository,model } = this.options;
    const task = await tasks.get(a,id);this.kind(task);
    return tasks.run(a,id,async credentials => {
      const guard = async () => {
        await tasks.assertGenerationAllowed(a,task.projectId,task.chapterId,task.input);
        const current = await context.read(a,task.projectId,task.chapterId);
        if (!current || current.sourceVersionId !== task.input.sourceVersionId || current.upstreamConfirmedVersionIds.length !== task.input.upstreamConfirmedVersionIds.length
          || current.upstreamConfirmedVersionIds.some((v,i) => v !== task.input.upstreamConfirmedVersionIds[i])
          || current.generationParameters.targetDurationSeconds !== task.input.generationParameters.targetDurationSeconds
          || current.generationParameters.aspectRatio !== task.input.generationParameters.aspectRatio || current.generationParameters.narrativeMode !== task.input.generationParameters.narrativeMode) throw new TaskExecutionError("UPSTREAM_CHANGED");
      };
      let invoked = false,guardedError: TaskExecutionError | null = null;
      try {
        await guard();
        const active = await repository.findActive(a,task.projectId,task.chapterId);
        if (active && active.jobId !== task.id) throw new TaskExecutionError("CANDIDATE_EXISTS");
        const runner = new SettingsRunner({ handoff,repository,idGenerator: this.options.idGenerator,clock: this.options.clock,model: { async generate(request) {
          // Runner rereads authority independently; bind its exact input before the paid boundary.
          if (request.sourceVersionId !== task.input.sourceVersionId || request.upstreamConfirmedVersionIds.length !== task.input.upstreamConfirmedVersionIds.length || request.upstreamConfirmedVersionIds.some((v,i) => v !== task.input.upstreamConfirmedVersionIds[i])) { guardedError = new TaskExecutionError("UPSTREAM_CHANGED");throw guardedError; }
          try { await guard(); } catch (error) { const mapped = executionFailure(error,false);guardedError = mapped instanceof TaskExecutionError ? mapped : new TaskExecutionError("EXECUTION_UNCERTAIN");throw guardedError; }
          invoked = true;
          const response = await model.generate(request,credentials);
          try { await guard(); } catch (error) { const mapped = executionFailure(error,true);guardedError = mapped instanceof TaskExecutionError ? mapped : new TaskExecutionError("EXECUTION_UNCERTAIN");throw guardedError; }
          return response;
        } } });
        const v = await runner.run(a,task.projectId,task.chapterId,task.id);
        return { candidateVersionId: v.id,extractionStatus: v.generationStatus };
      } catch (error) {
        if (guardedError) throw guardedError;
        throw executionFailure(error,invoked);
      }
    },signal);
  }
}
function executionFailure(error: unknown,invoked: boolean): Error {
  if (error instanceof TaskExecutionError) return error;
  if (error instanceof ModelTaskError && ["POLICY_RESTRICTED","UPSTREAM_CHANGED","INVALID_CONTEXT","TASK_NOT_FOUND"].includes(error.code)) return new TaskExecutionError(error.code === "POLICY_RESTRICTED" ? "POLICY_RESTRICTED" : "UPSTREAM_CHANGED");
  if (error instanceof ScriptContentError && ["CONTEXT_NOT_FOUND","INVALID_STATE"].includes(error.code) || error instanceof SettingsGenerationError && error.code === "UPSTREAM_CHANGED") return new TaskExecutionError("UPSTREAM_CHANGED");
  if (error instanceof SettingsGenerationError && error.code === "CANDIDATE_EXISTS") return new TaskExecutionError("CANDIDATE_EXISTS");
  if (error instanceof SettingsContentError) return new TaskExecutionError("INVALID_RESPONSE");
  if (invoked) return new TaskExecutionError("EXECUTION_UNCERTAIN");
  return error instanceof Error ? error : new Error("SETTINGS_EXECUTION_UNAVAILABLE");
}
