import type { Pool } from "pg";

export type EpisodeExecutionEvent =
  | {kind:"dispatch_started" | "not_sent" | "invalid_response" | "unknown"}
  | {kind:"completed"; candidateId:string};

export interface EpisodeExecutionJournal {
  record(workspaceId:string,taskId:string,event:EpisodeExecutionEvent):Promise<void>;
}

/** Append-only metadata. A dispatch marker authorizes at most one transport attempt. */
export class PostgresEpisodeExecutionJournal implements EpisodeExecutionJournal {
  readonly #pool: Pool; constructor(pool:Pool) { this.#pool=pool; }
  async record(workspaceId:string,taskId:string,event:EpisodeExecutionEvent):Promise<void> {
    const client=await this.#pool.connect();
    let discard=false;
    try {
      await client.query("begin; set local statement_timeout='5s'");
      await client.query("select set_config('app.model_workspace_id',$1,true)",[workspaceId]);
      const candidateId=event.kind==="completed" ? event.candidateId : null;
      const inserted=await client.query(`insert into public.episode_execution_events(workspace_id,task_id,kind,candidate_id)
        select t.workspace_id,t.id,$3,$4 from public.model_tasks t
        where t.workspace_id=$1 and t.id=$2 and t.payload->>'dispatchOwner'='outbox'
          and ($3<>'dispatch_started' or (state='running' and lease_expires_at>clock_timestamp()))
          and ($3<>'not_sent' or not exists(select 1 from public.episode_execution_events
            where workspace_id=$1 and task_id=$2 and kind='dispatch_started'))
        for share of t
        on conflict do nothing`,[workspaceId,taskId,event.kind,candidateId]);
      if (inserted.rowCount!==1) {
        const existing=event.kind==="dispatch_started" ? null : (await client.query(`select candidate_id
          from public.episode_execution_events where workspace_id=$1 and task_id=$2 and kind=$3`,
        [workspaceId,taskId,event.kind])).rows[0];
        if (!existing || existing.candidate_id!==candidateId) throw new Error();
      }
      discard=true;
      if ((await client.query("commit")).command!=="COMMIT") throw new Error();
      discard=false;
    } catch {
      if (!discard) try { await client.query("rollback"); } catch { discard=true; }
      throw new Error("EPISODE_EXECUTION_JOURNAL_UNAVAILABLE");
    } finally { client.release(discard); }
  }
}
