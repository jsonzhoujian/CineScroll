import { ModelTaskError, type ModelTaskRepository } from "@novel-adaptation/script/model-tasks";
import type { EpisodeOutboxConsumer } from "./episode-outbox-consumer.ts";
import type { EpisodePlanTaskExecutor } from "./episode-plan-task-executor.ts";

type Options = {
  consumer: Pick<EpisodeOutboxConsumer,"tick">;
  repository: Pick<ModelTaskRepository,"find">;
  executor: Pick<EpisodePlanTaskExecutor,"run" | "recover">;
  responsibility(workspaceId: string,taskId: string): Promise<"byok" | "platform">;
};

/** Internal bridge. The existing executor resolves BYOK credentials only. */
export class EpisodeOutboxDispatcher {
  readonly #options: Options;
  constructor(options: Options) { this.#options={...options}; }

  async tick(workspaceId: string,signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    const {consumer,repository,executor,responsibility}=this.#options;
    return consumer.tick(workspaceId,async item=>{
      if (signal?.aborted || item.workspaceId!==workspaceId) throw new ModelTaskError("INVALID_CONTEXT");
      const task=await repository.find(workspaceId,item.taskId);
      if (!task || task.workspaceId!==workspaceId || task.id!==item.taskId
        || task.input.stage!=="script" || task.input.resultType!=="episodePlan") {
        throw new ModelTaskError("TASK_NOT_FOUND");
      }
      const actor={workspaceId,userId:task.createdBy};
      if (task.state==="queued") {
        if (await responsibility(workspaceId,task.id)!=="byok") throw new ModelTaskError("WORKSPACE_TASK_DISABLED");
        await executor.run(actor,task.id,signal);
      } else if (task.state==="running") {
        // The recovery CAS rejects active leases and cannot invoke the model.
        await executor.recover(actor,task.id);
      }
      // Terminal and paused states are durable. Later reconciliation uses the existing recovery sweep.
    });
  }
}
