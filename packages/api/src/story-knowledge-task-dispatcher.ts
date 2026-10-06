import { ModelTaskError, validateTaskScan, type ModelTaskRepository, type TaskScanMode, type TaskPageRequest, type TaskState, type TaskReason } from "@novel-adaptation/script/model-tasks";
import type { StoryKnowledgeTaskExecutor } from "./story-knowledge-task-executor.ts";

type Options = { repository: ModelTaskRepository; executor: StoryKnowledgeTaskExecutor };
export type DispatchItem = { id: string; outcome: "completed" | "raced" | "unavailable" | "limited"; state?: TaskState; reason?: TaskReason | null };
/** Internal bounded sweep, not a public API. Caller supplies a trusted workspace allowlist and scheduling policy. */
export class StoryKnowledgeTaskDispatcher {
  readonly #options: Options;
  constructor(options: Options) { this.#options = options; }
  async tick(workspaceId: string, mode: TaskScanMode, page: TaskPageRequest = { limit: 20, cursor: null }) {
    validateTaskScan(mode, page);
    if (typeof workspaceId !== "string" || !workspaceId.trim() || workspaceId.length > 256 || /[\r\n]/.test(workspaceId)) throw new ModelTaskError("INVALID_CONTEXT");
    const found = await this.#options.repository.scanStoryKnowledge(workspaceId, mode, page);
    const items: DispatchItem[] = [];
    for (const task of found.tasks) {
      if (task.workspaceId !== workspaceId || task.input.stage !== "story_knowledge") throw new ModelTaskError("INVALID_CONTEXT");
      const actor = { workspaceId, userId: task.createdBy };
      try {
        // Executor reauthorizes the original submitter and claims via CAS before model access.
        const result = mode === "run" ? await this.#options.executor.run(actor, task.id) : await this.#options.executor.recover(actor, task.id);
        items.push({ id: task.id, outcome: "completed", state: result.state, reason: result.reason });
      } catch (error) {
        // Never retry here: an exception may follow a paid call or a saved candidate.
        items.push({ id: task.id, outcome: error instanceof ModelTaskError && error.code === "TASK_EXECUTION_FULL" ? "limited" : error instanceof ModelTaskError && error.code === "STATE_CONFLICT" ? "raced" : "unavailable" });
      }
    }
    return { items, nextCursor: found.nextCursor };
  }
}
