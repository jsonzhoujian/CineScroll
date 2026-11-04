import type { Actor,ProjectAccessReader } from "@novel-adaptation/script";
import type { ConfirmedScriptHandoff } from "@novel-adaptation/script/script-handoff";
import { ModelSettingsError } from "@novel-adaptation/script/model-settings";
import { ModelTaskError,TaskExecutionError,type ModelTask,type ModelTaskService,type ModelTaskContextReader,type TaskInput } from "@novel-adaptation/script/model-tasks";
import { SettingsReviewError } from "@novel-adaptation/script/settings-review";
import { ScriptContentError } from "@novel-adaptation/script/script-content";
import { SettingsContentError } from "@novel-adaptation/script/settings-content";
import { SettingsRegenerationRunner,SettingsRegenerationError,normalizeSettingsRegenerationSelection,selectSettingsRegenerationTargets,settingsRegenerationFingerprint,type SettingsRegenerationSelection,type SettingsRegenerationRepository,type SettingsRegenerationRequest } from "@novel-adaptation/script/settings-regeneration";
export class SettingsRegenerationTaskContext implements ModelTaskContextReader {
  private readonly base: ModelTaskContextReader;
  private readonly repository: SettingsRegenerationRepository;
  private readonly access: ProjectAccessReader;
  constructor(base: ModelTaskContextReader,repository: SettingsRegenerationRepository,access: ProjectAccessReader) { this.base = base;this.repository = repository;this.access = access; }
  async canRead(a: Actor,p: string,c: string) { return await this.base.canRead?.(a,p,c) === true; }
  async read(): Promise<TaskInput | null> { return null; } // Selection is mandatory; generic initial submission stays closed.
  async readRegeneration(a: Actor,p: string,c: string,input: SettingsRegenerationSelection): Promise<TaskInput | null> {
    if (!await this.canRead(a,p,c)) return null;
    const access = await this.access.findProjectAccess(a,p);
    if (!access) return null;
    if (access.role !== "owner" && access.role !== "reviewer") throw new ModelSettingsError("FORBIDDEN");
    try {
      const selection = normalizeSettingsRegenerationSelection(input),context = await this.base.read(a,p,c);
      if (!context) return null;
      if (context.stage !== "settings" || context.resultType !== "settingsContent") throw new ModelTaskError("INVALID_CONTEXT");
      const v = await this.repository.findActive(a,p,c);
      if (!v || v.id !== selection.expectedActiveVersionId || v.sourceVersionId !== context.sourceVersionId || v.upstreamConfirmedVersionIds.length !== context.upstreamConfirmedVersionIds.length || v.upstreamConfirmedVersionIds.some((id,i) => id !== context.upstreamConfirmedVersionIds[i])) throw new ModelTaskError("UPSTREAM_CHANGED");
      selectSettingsRegenerationTargets(v,selection);
      return { ...context,resultType: "settingsRegeneration",regeneration: selection };
    } catch (error) {
      if (error instanceof SettingsReviewError) throw new ModelTaskError(error.code === "STORAGE_UNAVAILABLE" ? "STORAGE_UNAVAILABLE" : "UPSTREAM_CHANGED");
      if (error instanceof SettingsRegenerationError) throw new ModelTaskError("INVALID_CONTEXT");
      throw error;
    }
  }
}
export interface CredentialedSettingsRegenerationModel {
  generate(request: SettingsRegenerationRequest,credentials: { apiKey: string;providerId: string;modelId: string;processingRegion: "mainland" }): Promise<unknown>;
}
export class SettingsRegenerationTaskExecutor {
  private readonly options: { tasks: ModelTaskService;context: SettingsRegenerationTaskContext;repository: SettingsRegenerationRepository;handoff: Pick<ConfirmedScriptHandoff,"read">;access: ProjectAccessReader;model: CredentialedSettingsRegenerationModel;idGenerator(): string;clock(): Date };
  constructor(options: SettingsRegenerationTaskExecutor["options"]) { this.options = options; }
  private kind(a: Actor,task: ModelTask) {
    if (task.workspaceId !== a.workspaceId || task.createdBy !== a.userId || task.input.stage !== "settings" || task.input.resultType !== "settingsRegeneration" || !task.input.regeneration) throw new ModelTaskError("TASK_NOT_FOUND");
  }
  async recover(a: Actor,id: string) {
    return this.options.tasks.recover(a,id,async task => {
      this.kind(a,task);
      const selection = task.input.regeneration!,fingerprint = settingsRegenerationFingerprint(selection);
      const v = await this.options.repository.findGeneration(a,task.projectId,task.chapterId,task.id),meta = v?.regeneration;
      if (!v || !meta || v.status !== "candidate" || v.createdBy !== task.createdBy || v.projectId !== task.projectId || v.chapterId !== task.chapterId || v.parentVersionId !== selection.expectedActiveVersionId
        || meta.jobId !== task.id || meta.fingerprint !== fingerprint || settingsRegenerationFingerprint({ expectedActiveVersionId: v.parentVersionId,assetIds: meta.assetIds,failureScopeKeys: meta.failureScopeKeys,reason: meta.reason }) !== fingerprint
        || v.operation?.kind !== "regenerate" || v.operation.fingerprint !== fingerprint || v.sourceVersionId !== task.input.sourceVersionId || v.scriptVersionId !== task.input.upstreamConfirmedVersionIds[0]
        || v.upstreamConfirmedVersionIds.length !== task.input.upstreamConfirmedVersionIds.length || v.upstreamConfirmedVersionIds.some((id,i) => id !== task.input.upstreamConfirmedVersionIds[i])) return null;
      return { candidateVersionId: v.id,extractionStatus: meta.outcome };
    });
  }
  async run(a: Actor,id: string,signal?: AbortSignal) {
    const { tasks,context,repository,handoff,access,model } = this.options;
    const task = await tasks.get(a,id);this.kind(a,task);
    const selection = normalizeSettingsRegenerationSelection(task.input.regeneration!);
    return tasks.run(a,id,async credentials => {
      let guardedError: TaskExecutionError | null = null;
      const guard = async () => {
        await tasks.assertGenerationAllowed(a,task.projectId,task.chapterId,task.input);
        const current = await context.readRegeneration(a,task.projectId,task.chapterId,selection);
        if (!current || current.sourceVersionId !== task.input.sourceVersionId || current.upstreamConfirmedVersionIds.length !== task.input.upstreamConfirmedVersionIds.length
          || current.upstreamConfirmedVersionIds.some((id,i) => id !== task.input.upstreamConfirmedVersionIds[i]) || JSON.stringify(current.regeneration) !== JSON.stringify(selection)
          || current.generationParameters.targetDurationSeconds !== task.input.generationParameters.targetDurationSeconds || current.generationParameters.aspectRatio !== task.input.generationParameters.aspectRatio || current.generationParameters.narrativeMode !== task.input.generationParameters.narrativeMode) throw new TaskExecutionError("UPSTREAM_CHANGED");
      };
      try {
        await guard();
        const runner = new SettingsRegenerationRunner({ repository,handoff,access,idGenerator: this.options.idGenerator,clock: this.options.clock,model: { async generate(request) {
          if (request.regeneration.baseVersionId !== selection.expectedActiveVersionId || request.sourceVersionId !== task.input.sourceVersionId || request.upstreamConfirmedVersionIds.length !== task.input.upstreamConfirmedVersionIds.length || request.upstreamConfirmedVersionIds.some((id,i) => id !== task.input.upstreamConfirmedVersionIds[i])) { guardedError = new TaskExecutionError("UPSTREAM_CHANGED");throw guardedError; }
          try { await guard(); } catch (error) { guardedError = failure(error);throw guardedError; }
          const response = await model.generate(request,credentials);
          try { await guard(); } catch (error) { guardedError = failure(error);throw guardedError; }
          return response;
        } } });
        const result = await runner.run(a,task.projectId,task.chapterId,task.id,selection);
        return { candidateVersionId: result.id,extractionStatus: result.regeneration!.outcome };
      } catch (error) { throw guardedError ?? failure(error); }
    },signal);
  }
}
function failure(error: unknown): TaskExecutionError {
  if (error instanceof TaskExecutionError) return error;
  if (error instanceof SettingsContentError || error instanceof SettingsRegenerationError && ["INVALID_REQUEST","INVALID_RESPONSE"].includes(error.code)) return new TaskExecutionError("INVALID_RESPONSE");
  if (error instanceof ModelSettingsError && error.code === "FORBIDDEN" || error instanceof SettingsReviewError && error.code === "FORBIDDEN" || error instanceof ModelTaskError && error.code === "POLICY_RESTRICTED") return new TaskExecutionError("POLICY_RESTRICTED");
  if (error instanceof SettingsReviewError && ["LOCKED","UPSTREAM_CHANGED","VERSION_CONFLICT","NOT_FOUND","INVALID_STATE"].includes(error.code)
    || error instanceof ModelTaskError && ["UPSTREAM_CHANGED","INVALID_CONTEXT","TASK_NOT_FOUND"].includes(error.code) || error instanceof ScriptContentError && ["CONTEXT_NOT_FOUND","INVALID_STATE"].includes(error.code)) return new TaskExecutionError("UPSTREAM_CHANGED");
  // Conservative for any unknown storage/provider outcome; recovery never invokes a model.
  return new TaskExecutionError("EXECUTION_UNCERTAIN");
}
