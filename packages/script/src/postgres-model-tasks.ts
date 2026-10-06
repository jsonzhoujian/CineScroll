import type { ModelSettingsPool, ModelSettingsClient } from "./postgres-model-settings.ts";
import { ModelTaskError, validateTaskScan, validateTaskPage, validateTaskStatus, validateTaskResult, type TaskScanMode, type TaskPageRequest, type TaskResult, type ModelTask, type ModelTaskRepository, type TaskState, type TaskReason } from "./model-tasks.ts";

export class PostgresModelTaskRepository implements ModelTaskRepository {
  readonly #pool: ModelSettingsPool;
  constructor(pool: ModelSettingsPool) { this.#pool = pool; }
  scanStoryKnowledge(workspaceId: string, mode: TaskScanMode, page: TaskPageRequest) {
    return this.#scan(workspaceId,mode,page,"story_knowledge");
  }
  scanEpisodePlans(workspaceId: string, mode: TaskScanMode, page: TaskPageRequest) {
    return this.#scan(workspaceId,mode,page,"episodePlan");
  }
  #scan(workspaceId: string, mode: TaskScanMode, page: TaskPageRequest, kind: "story_knowledge" | "episodePlan") {
    validateTaskScan(mode, page);
    return this.#transaction(workspaceId, async client => {
      const eligibility = mode === "run" ? "state='queued'" : "((state='running' and (lease_expires_at is null or lease_expires_at<=clock_timestamp())) or (state='paused' and reason='EXECUTION_UNCERTAIN'))";
      const taskKind = kind === "episodePlan" ? "payload->'input'->>'stage'='script' and payload->'input'->>'resultType'='episodePlan'" : "payload->'input'->>'stage'='story_knowledge'";
      const rows = (await client.query(`select payload,state,revision,reason,result_json,lease_expires_at from model_tasks
        where workspace_id=$1 and ${taskKind} and ${eligibility}
          and ($2::text is null or id collate "C">$2::text collate "C") order by id collate "C" limit $3`,
        [workspaceId,page.cursor,page.limit+1])).rows;
      const tasks = rows.slice(0, page.limit).map(decode);
      return { tasks, nextCursor: rows.length > page.limit ? tasks.at(-1)!.id : null };
    });
  }
  listStoryKnowledge(workspaceId: string, projectId: string, chapterId: string, page: TaskPageRequest) {
    return this.#list(workspaceId,projectId,chapterId,page,"story_knowledge");
  }
  listEpisodePlans(workspaceId: string, projectId: string, chapterId: string, page: TaskPageRequest) {
    return this.#list(workspaceId,projectId,chapterId,page,"episodePlan");
  }
  #list(workspaceId: string, projectId: string, chapterId: string, page: TaskPageRequest, kind: "story_knowledge" | "episodePlan") {
    validateTaskPage(page);
    return this.#transaction(workspaceId, async client => {
      const taskKind = kind === "episodePlan" ? "payload->'input'->>'stage'='script' and payload->'input'->>'resultType'='episodePlan'" : "payload->'input'->>'stage'='story_knowledge'";
      const rows = (await client.query(`select payload,state,revision,reason,result_json,lease_expires_at from model_tasks
        where workspace_id=$1 and payload->>'projectId'=$2 and payload->>'chapterId'=$3
          and ${taskKind} and ($4::text is null or id collate "C">$4::text collate "C")
        order by id collate "C" limit $5`, [workspaceId,projectId,chapterId,page.cursor,page.limit+1])).rows;
      const tasks = rows.slice(0, page.limit).map(decode);
      return { tasks, nextCursor: rows.length > page.limit ? tasks.at(-1)!.id : null };
    });
  }
  find(workspaceId: string, id: string) {
    return this.#transaction(workspaceId, async client => {
      const row = (await client.query("select payload,state,revision,reason,result_json,lease_expires_at from model_tasks where workspace_id=$1 and id=$2", [workspaceId,id])).rows[0];
      return row ? decode(row) : null;
    });
  }
  insert(task: ModelTask) {
    return this.#transaction(task.workspaceId, async client => {
      if (task.state !== "queued" || task.revision !== 0 || task.reason !== null || task.result !== null || task.leaseExpiresAt !== null) throw new ModelTaskError("STATE_CONFLICT");
      const { state, revision, reason, result, leaseExpiresAt, ...payload } = task;
      const row = (await client.query(`insert into model_tasks(workspace_id,id,parent_task_id,payload,state,revision,reason)
        values($1,$2,$3,$4::jsonb,$5,$6,$7) returning payload,state,revision,reason,result_json,lease_expires_at`,
        [task.workspaceId,task.id,task.parentTaskId,JSON.stringify(payload),state,revision,reason])).rows[0]!;
      return decode(row);
    });
  }
  transition(workspaceId: string, id: string, expectedRevision: number, state: TaskState, reason: TaskReason | null, result: TaskResult | null = null) {
    validateTaskStatus(state, reason);
    validateTaskResult(state, result);
    return this.#transaction(workspaceId, async client => {
      const row = (await client.query(`update model_tasks set state=$4,reason=$5,result_json=$6::jsonb,revision=revision+1,
        lease_expires_at=case when $4='running' then clock_timestamp()+interval '10 minutes' else null end
        where workspace_id=$1 and id=$2 and revision=$3
          and ((state='queued' and $4='running') or (state='running' and $4 in ('paused','failed','succeeded')))
        returning payload,state,revision,reason,result_json,lease_expires_at`, [workspaceId,id,expectedRevision,state,reason,result === null ? null : JSON.stringify(result)])).rows[0];
      if (!row) throw new ModelTaskError("STATE_CONFLICT");
      return decode(row);
    });
  }
  recover(workspaceId: string, id: string, revision: number, result: TaskResult | null) {
    validateTaskResult("succeeded", result);
    return this.#transaction(workspaceId, async client => {
      const row = (await client.query(`update model_tasks set state=$4,reason=$5,result_json=$6::jsonb,
        lease_expires_at=null,revision=revision+1 where workspace_id=$1 and id=$2 and revision=$3
        and ((state='running' and (lease_expires_at is null or lease_expires_at<=clock_timestamp()))
          or (state='paused' and reason='EXECUTION_UNCERTAIN' and $6::jsonb is not null))
        returning payload,state,revision,reason,result_json,lease_expires_at`,
        [workspaceId,id,revision,result ? "succeeded" : "paused",result ? null : "EXECUTION_UNCERTAIN",result ? JSON.stringify(result) : null])).rows[0];
      if (!row) throw new ModelTaskError("STATE_CONFLICT");
      return decode(row);
    });
  }
  async #transaction<T>(workspaceId: string, action: (client: ModelSettingsClient) => Promise<T>): Promise<T> {
    let client: ModelSettingsClient | undefined;
    try {
      client = await this.#pool.connect(); await client.query("begin isolation level read committed"); await client.query("set local statement_timeout='5s'");
      await client.query("select set_config('app.model_workspace_id',$1,true)", [workspaceId]);
      const result = await action(client); await client.query("commit"); return result;
    } catch (error) {
      try { await client?.query("rollback"); } catch { /* Sanitized below. */ }
      if (error instanceof ModelTaskError) throw error;
      if (typeof error === "object" && error !== null && "code" in error) {
        const capacity = { PZ001: "TASK_LIMITS_UNAVAILABLE", PZ002: "TASK_QUEUE_FULL", PZ003: "TASK_EXECUTION_FULL" } as const;
        const code = String(error.code) as keyof typeof capacity;
        if (capacity[code]) throw new ModelTaskError(capacity[code]);
      }
      if (typeof error === "object" && error !== null && "code" in error && ["23505", "P0001"].includes(String(error.code))) throw new ModelTaskError("STATE_CONFLICT");
      throw new ModelTaskError("STORAGE_UNAVAILABLE");
    } finally { client?.release(); }
  }
}
function decode(row: Record<string, unknown>): ModelTask {
  const expiry = row.lease_expires_at;
  return structuredClone({ ...(row.payload as Omit<ModelTask,"state" | "revision" | "reason" | "result" | "leaseExpiresAt">), state: row.state as TaskState, revision: Number(row.revision), reason: row.reason as TaskReason | null, result: (row.result_json ?? null) as TaskResult | null,
    leaseExpiresAt: expiry == null ? null : new Date(expiry as string).toISOString() });
}
