import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

type Dispatch = Readonly<{workspaceId: string; taskId: string}>;
type Lease = Dispatch & Readonly<{token: string}>;

/** Server-only consumer. Dispatch must tolerate delivery again after an unacknowledged attempt. */
export class EpisodeOutboxConsumer {
  readonly #pool: Pool;
  readonly #workspaces: ReadonlySet<string>;

  constructor(pool: Pool, workspaceIds: readonly string[]) {
    this.#pool=pool;
    this.#workspaces=new Set(workspaceIds);
  }

  claim(workspaceId: string): Promise<Lease | null> {
    return this.#transaction(workspaceId,async client=>{
      const token=randomUUID();
      const result=await client.query<{task_id:string}>(`
        with next as (
          select workspace_id,task_id from public.episode_submission_outbox
          where workspace_id=$1 and dispatched_at is null
            and (lease_until is null or lease_until<=clock_timestamp())
          order by created_at,task_id
          limit 1 for update skip locked
        )
        update public.episode_submission_outbox as outbox
        set lease_token=$2,lease_until=clock_timestamp()+interval '10 minutes'
        from next where outbox.workspace_id=next.workspace_id and outbox.task_id=next.task_id
        returning outbox.task_id`,[workspaceId,token]);
      return result.rows[0] ? {workspaceId,taskId:result.rows[0].task_id,token} : null;
    });
  }

  acknowledge({workspaceId,taskId,token}: Lease): Promise<boolean> {
    return this.#transaction(workspaceId,async client=>{
      const result=await client.query(`
        update public.episode_submission_outbox
        set dispatched_at=clock_timestamp(),lease_token=null,lease_until=null
        where workspace_id=$1 and task_id=$2 and lease_token=$3 and dispatched_at is null
          and lease_until>clock_timestamp()`,[workspaceId,taskId,token]);
      return result.rowCount===1;
    });
  }

  async tick(workspaceId: string, dispatch: (item: Dispatch)=>Promise<void>): Promise<boolean> {
    const lease=await this.claim(workspaceId);
    if (!lease) return false;
    try { await dispatch({workspaceId:lease.workspaceId,taskId:lease.taskId}); }
    catch { return false; } // Leave the persisted lease for recovery after expiry.
    return this.acknowledge(lease);
  }

  async #transaction<T>(workspaceId: string, run: (client: PoolClient)=>Promise<T>): Promise<T> {
    if (!this.#workspaces.has(workspaceId)) throw new Error('FORBIDDEN');
    const client=await this.#pool.connect().catch(()=>{throw new Error('UNAVAILABLE');});
    let committing=false;
    let discard=false;
    try {
      await client.query("begin; set local statement_timeout='5s'; set local lock_timeout='2s'");
      await client.query("select set_config('app.episode_outbox_workspace_id',$1,true)",[workspaceId]);
      const result=await run(client);
      committing=true;
      if ((await client.query('commit')).command!=='COMMIT') throw new Error('UNAVAILABLE');
      return result;
    } catch {
      discard=committing;
      if (!committing) {
        try { await client.query('rollback'); } catch { discard=true; }
      }
      throw new Error('UNAVAILABLE');
    } finally { client.release(discard); }
  }
}
