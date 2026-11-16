import { ModelTaskError, type ModelTaskRepository, type TaskPageRequest, type TaskScanMode } from "@novel-adaptation/script/model-tasks";
import type { DispatchItem } from "./story-knowledge-task-dispatcher.ts";
import type { StoryboardTaskExecutor } from "./storyboard-task-executor.ts";

export class StoryboardTaskDispatcher {
  private readonly repository: Pick<ModelTaskRepository, "scanStoryboard">;
  private readonly executor: Pick<StoryboardTaskExecutor, "run" | "recover">;

  constructor(repository: StoryboardTaskDispatcher["repository"], executor: StoryboardTaskDispatcher["executor"]) {
    this.repository = repository;
    this.executor = executor;
  }

  async tick(workspaceId: string, mode: TaskScanMode, page: TaskPageRequest, signal?: AbortSignal) {
    if (signal?.aborted) return { items: [], nextCursor: page.cursor };
    const found = await this.repository.scanStoryboard?.(workspaceId, mode, page);
    if (!found) throw new ModelTaskError("STORAGE_UNAVAILABLE");
    const items: DispatchItem[] = [];
    for (const task of found.tasks) {
      if (signal?.aborted) break;
      if (task.workspaceId !== workspaceId || task.input.stage !== "storyboard" || task.input.resultType !== "storyboardContent") throw new ModelTaskError("INVALID_CONTEXT");
      const actor = { workspaceId, userId: task.createdBy };
      try {
        const result = mode === "run" ? await this.executor.run(actor, task.id, signal) : await this.executor.recover(actor, task.id);
        items.push({ id: task.id, outcome: "completed", state: result.state, reason: result.reason });
      } catch (error) {
        items.push({ id: task.id, outcome: error instanceof ModelTaskError && error.code === "TASK_EXECUTION_FULL" ? "limited"
          : error instanceof ModelTaskError && error.code === "STATE_CONFLICT" ? "raced" : "unavailable" });
      }
    }
    return { items, nextCursor: found.nextCursor };
  }
}
