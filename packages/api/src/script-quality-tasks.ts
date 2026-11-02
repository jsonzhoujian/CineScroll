import { ModelSettingsError } from "@novel-adaptation/script/model-settings";
import type { Actor } from "@novel-adaptation/script";
import { ScriptContentError } from "@novel-adaptation/script/script-content";
import { ScriptPublicationService, sameQualityBinding } from "@novel-adaptation/script/script-publication";
import { DeepSeekQualityModel } from "@novel-adaptation/script/deepseek-quality-model";
import { ModelTaskError, TaskExecutionError, validateTaskScan, type ModelTaskService, type ModelTaskRepository, type TaskPageRequest, type TaskScanMode } from "@novel-adaptation/script/model-tasks";
import type { ScriptContentContext } from "./script-content-context.ts";
import type { DispatchItem } from "./story-knowledge-task-dispatcher.ts";

/** Independent task context pins quality to the complete current candidate and upstream snapshot. */
export class ScriptQualityTaskContext {
  private readonly context: ScriptContentContext;private readonly publication: ScriptPublicationService;
  constructor(context: ScriptContentContext,publication: ScriptPublicationService) { this.context = context;this.publication = publication; }
  canRead(a: Actor,p: string,c: string) { return this.context.canRead(a,p,c); }
  async read(a: Actor,p: string,c: string) {
    const base = await this.context.read(a,p,c); if (!base) return null;
    let target;
    try { target = await this.publication.target(a,p,c); }
    catch (error) {
      if (error instanceof ScriptContentError && error.code === "FORBIDDEN") throw new ModelSettingsError("FORBIDDEN");
      if (error instanceof ScriptContentError && ["INVALID_STATE","CONTEXT_NOT_FOUND","VERSION_CONFLICT"].includes(error.code)) return null;
      throw error;
    }
    return { ...base,resultType: "scriptQuality" as const,qualityTarget: target };
  }
}
export class ScriptQualityTaskExecutor {
  private readonly options: { tasks: ModelTaskService;publication: ScriptPublicationService;fetch?: typeof globalThis.fetch };
  constructor(options: ScriptQualityTaskExecutor["options"]) { this.options = options; }
  async run(a: Actor,id: string,signal?: AbortSignal) {
    const { tasks,publication } = this.options,task = await tasks.get(a,id);
    if (task.input.resultType !== "scriptQuality" || !task.input.qualityTarget) throw new ModelTaskError("TASK_NOT_FOUND");
    return tasks.run(a,id,async credentials => {
      let invoked = false;
      try {
        const model = new DeepSeekQualityModel({ apiKey: credentials.apiKey,model: credentials.modelId,processingRegion: credentials.processingRegion,...(this.options.fetch ? { fetch: this.options.fetch } : {}) });
        const report = await publication.assess(a,task.projectId,task.chapterId,{ jobId: id,binding: task.input.qualityTarget!,model: { assess: async input => { invoked = true; return model.assess(input); } } });
        return { candidateVersionId: report.id,extractionStatus: "succeeded" };
      } catch (error) {
        if (error instanceof ScriptContentError && ["VERSION_CONFLICT","CONTEXT_NOT_FOUND","FORBIDDEN","INVALID_STATE"].includes(error.code)) throw new TaskExecutionError("UPSTREAM_CHANGED");
        throw new TaskExecutionError(invoked ? "EXECUTION_UNCERTAIN" : "INVALID_RESPONSE");
      }
    },signal);
  }
  async recover(a: Actor,id: string) {
    return this.options.tasks.recover(a,id,async task => {
      if (task.input.resultType !== "scriptQuality" || !task.input.qualityTarget) throw new ModelTaskError("TASK_NOT_FOUND");
      const report = await this.options.publication.report(a,task.projectId,task.chapterId,id);
      return report && sameQualityBinding(report,task.input.qualityTarget) ? { candidateVersionId: report.id,extractionStatus: "succeeded" } : null;
    });
  }
}
export class ScriptQualityTaskDispatcher {
  private readonly repository: ModelTaskRepository;private readonly executor: ScriptQualityTaskExecutor;
  constructor(repository: ModelTaskRepository,executor: ScriptQualityTaskExecutor) { this.repository = repository;this.executor = executor; }
  async tick(workspaceId: string,mode: TaskScanMode,page: TaskPageRequest = { limit: 20,cursor: null },signal?: AbortSignal) {
    validateTaskScan(mode,page);
    if (!workspaceId?.trim() || workspaceId.length > 256 || /[\r\n]/.test(workspaceId)) throw new ModelTaskError("INVALID_CONTEXT");
    if (signal?.aborted) return { items: [],nextCursor: page.cursor };
    const found = await this.repository.scanScriptQuality?.(workspaceId,mode,page);
    if (!found) throw new ModelTaskError("STORAGE_UNAVAILABLE");
    const items: DispatchItem[] = [];
    for (const task of found.tasks) {
      if (signal?.aborted) break;
      if (task.workspaceId !== workspaceId || task.input.resultType !== "scriptQuality") throw new ModelTaskError("INVALID_CONTEXT");
      try {
        const a = { workspaceId,userId: task.createdBy },result = mode === "run" ? await this.executor.run(a,task.id,signal) : await this.executor.recover(a,task.id);
        items.push({ id: task.id,outcome: "completed",state: result.state,reason: result.reason });
      } catch (error) { items.push({ id: task.id,outcome: error instanceof ModelTaskError && error.code === "STATE_CONFLICT" ? "raced" : error instanceof ModelTaskError && error.code === "TASK_EXECUTION_FULL" ? "limited" : "unavailable" }); }
    }
    return { items,nextCursor: found.nextCursor };
  }
}
