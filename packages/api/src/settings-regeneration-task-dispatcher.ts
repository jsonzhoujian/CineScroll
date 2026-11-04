import { ModelTaskError, validateTaskScan, type ModelTaskRepository, type TaskScanMode, type TaskPageRequest } from "@novel-adaptation/script/model-tasks";
import type { SettingsRegenerationTaskExecutor } from "./settings-regeneration-task-executor.ts";
import type { DispatchItem } from "./story-knowledge-task-dispatcher.ts";

export { StoryKnowledgeTaskWorker as SettingsRegenerationTaskWorker } from "./story-knowledge-task-worker.ts";
/** Internal bounded sweep. The worker supplies a trusted workspace allowlist; no public run route. */
export class SettingsRegenerationTaskDispatcher {
  readonly #repository: ModelTaskRepository;
  readonly #executor: SettingsRegenerationTaskExecutor;
  constructor(options: { repository: ModelTaskRepository; executor: SettingsRegenerationTaskExecutor }) { this.#repository = options.repository; this.#executor = options.executor; }
  async tick(workspaceId: string, mode: TaskScanMode, page: TaskPageRequest = { limit: 20,cursor: null }, signal?: AbortSignal) {
    validateTaskScan(mode,page);
    if (typeof workspaceId !== "string" || !workspaceId.trim() || workspaceId.length > 256 || /[\r\n]/.test(workspaceId)) throw new ModelTaskError("INVALID_CONTEXT");
    if (signal?.aborted) return { items: [],nextCursor: page.cursor };
    const found = await this.#repository.scanSettingsRegeneration?.(workspaceId,mode,page);
    if (!found) throw new ModelTaskError("STORAGE_UNAVAILABLE");
    const items: DispatchItem[] = [];
    for (const task of found.tasks) {
      if (signal?.aborted) break;
      if (task.workspaceId !== workspaceId || task.input.stage !== "settings" || task.input.resultType !== "settingsRegeneration") throw new ModelTaskError("INVALID_CONTEXT");
      const actor = { workspaceId,userId: task.createdBy };
      try {
        const result = mode === "run" ? await this.#executor.run(actor,task.id,signal) : await this.#executor.recover(actor,task.id);
        items.push({ id: task.id,outcome: "completed",state: result.state,reason: result.reason });
      } catch (error) {
        // Never resubmit: the exception might follow a paid call or an already saved candidate.
        items.push({ id: task.id,outcome: error instanceof ModelTaskError && error.code === "TASK_EXECUTION_FULL" ? "limited"
          : error instanceof ModelTaskError && error.code === "STATE_CONFLICT" ? "raced" : "unavailable" });
      }
    }
    return { items,nextCursor: found.nextCursor };
  }
}
