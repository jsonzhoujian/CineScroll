import type { ModelSettingsPool, ModelSettingsClient } from "./postgres-model-settings.ts";
import { ModelTaskError, validateTaskStatus, type ModelTask, type ModelTaskRepository, type TaskState, type TaskReason } from "./model-tasks.ts";

export class PostgresModelTaskRepository implements ModelTaskRepository {
  readonly #pool: ModelSettingsPool;
  constructor(pool: ModelSettingsPool) { this.#pool = pool; }
  find(workspaceId: string, id: string) {
    return this.#transaction(workspaceId, async client => {
      const row = (await client.query("select payload,state,revision,reason from model_tasks where workspace_id=$1 and id=$2", [workspaceId,id])).rows[0];
      return row ? decode(row) : null;
    });
  }
  insert(task: ModelTask) {
    return this.#transaction(task.workspaceId, async client => {
      if (task.state !== "queued" || task.revision !== 0 || task.reason !== null) throw new ModelTaskError("STATE_CONFLICT");
      const { state, revision, reason, ...payload } = task;
      const row = (await client.query(`insert into model_tasks(workspace_id,id,parent_task_id,payload,state,revision,reason)
        values($1,$2,$3,$4::jsonb,$5,$6,$7) returning payload,state,revision,reason`,
        [task.workspaceId,task.id,task.parentTaskId,JSON.stringify(payload),state,revision,reason])).rows[0]!;
      return decode(row);
    });
  }
  transition(workspaceId: string, id: string, expectedRevision: number, state: TaskState, reason: TaskReason | null) {
    validateTaskStatus(state, reason);
    return this.#transaction(workspaceId, async client => {
      const row = (await client.query(`update model_tasks set state=$4,reason=$5,revision=revision+1
        where workspace_id=$1 and id=$2 and revision=$3 returning payload,state,revision,reason`, [workspaceId,id,expectedRevision,state,reason])).rows[0];
      if (!row) throw new ModelTaskError("STATE_CONFLICT");
      return decode(row);
    });
  }
  async #transaction<T>(workspaceId: string, action: (client: ModelSettingsClient) => Promise<T>): Promise<T> {
    let client: ModelSettingsClient | undefined;
    try {
      client = await this.#pool.connect(); await client.query("begin"); await client.query("set local statement_timeout='5s'");
      await client.query("select set_config('app.model_workspace_id',$1,true)", [workspaceId]);
      const result = await action(client); await client.query("commit"); return result;
    } catch (error) {
      try { await client?.query("rollback"); } catch { /* Sanitized below. */ }
      if (error instanceof ModelTaskError) throw error;
      if (typeof error === "object" && error !== null && "code" in error && ["23505", "P0001"].includes(String(error.code))) throw new ModelTaskError("STATE_CONFLICT");
      throw new ModelTaskError("STORAGE_UNAVAILABLE");
    } finally { client?.release(); }
  }
}
function decode(row: Record<string, unknown>): ModelTask {
  return structuredClone({ ...(row.payload as Omit<ModelTask,"state" | "revision" | "reason">), state: row.state as TaskState, revision: Number(row.revision), reason: row.reason as TaskReason | null });
}
