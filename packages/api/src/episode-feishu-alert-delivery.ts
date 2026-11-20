import type { Pool,PoolClient } from "pg";
import type { createEpisodeFeishuAlertSender } from "./episode-feishu-alert.ts";

type Sender=ReturnType<typeof createEpisodeFeishuAlertSender>;
type Claim={task_id:string;code:string;attempts:number};

/** Process one delivery per tick. Unknown attempts are deliberately left for reconciliation. */
export function createEpisodeFeishuAlertDelivery(pool:Pool,workspaceIds:readonly string[],send:Sender) {
  const allowed=new Set(workspaceIds);

  async function transaction<T>(workspaceId:string,run:(client:PoolClient)=>Promise<T>):Promise<T> {
    const client=await pool.connect().catch(()=>{throw new Error("EPISODE_ALERT_DELIVERY_UNAVAILABLE");});
    let committing=false;
    let discard=false;
    try {
      await client.query("begin; set local statement_timeout='5s'; set local lock_timeout='2s'");
      await client.query("select set_config('app.episode_alert_delivery_workspace_id',$1,true)",[workspaceId]);
      const result=await run(client);
      committing=true;
      if ((await client.query("commit")).command!=="COMMIT") throw new Error();
      return result;
    } catch {
      discard=committing;
      if (!committing) try { await client.query("rollback"); } catch { discard=true; }
      throw new Error("EPISODE_ALERT_DELIVERY_UNAVAILABLE");
    } finally { client.release(discard); }
  }

  return async (workspaceId:string)=>{
    if (!allowed.has(workspaceId)) throw new Error("FORBIDDEN");
    const claim=await transaction(workspaceId,async client=>(await client.query<Claim>(`
      with next as (
        select a.workspace_id,a.task_id,a.code
        from public.episode_reconciliation_alerts a
        left join public.episode_alert_deliveries d
          on (d.workspace_id,d.task_id,d.code,d.channel)=(a.workspace_id,a.task_id,a.code,'feishu')
        where a.workspace_id=$1 and (d.channel is null or (d.status='retryable' and d.retry_at<=clock_timestamp() and d.attempts<5))
        order by d.retry_at nulls last,a.created_at,a.task_id,a.code limit 1
      )
      insert into public.episode_alert_deliveries as delivery(workspace_id,task_id,code,channel,status,attempts)
        select workspace_id,task_id,code,'feishu','unknown',1 from next
      on conflict(workspace_id,task_id,code,channel) do update
        set status='unknown',attempts=delivery.attempts+1,retry_at=null,attempted_at=clock_timestamp()
        where delivery.status='retryable' and delivery.retry_at<=clock_timestamp() and delivery.attempts<5
      returning task_id,code,attempts`,[workspaceId])).rows[0]);
    if (!claim) return null;

    // The unknown record must be committed before crossing the network boundary.
    const outcome=await send({workspaceId,taskId:claim.task_id,code:claim.code}).catch(()=>"unknown" as const);
    if (outcome==="unknown") return outcome;
    const status=outcome==="retryable" && claim.attempts===5 ? "exhausted" : outcome;
    await transaction(workspaceId,async client=>{
      const result=await client.query(`
        update public.episode_alert_deliveries set status=$4,
          retry_at=case when $4='retryable' then clock_timestamp()+interval '1 minute' else null end
        where workspace_id=$1 and task_id=$2 and code=$3 and channel='feishu' and status='unknown' and attempts=$5`,
      [workspaceId,claim.task_id,claim.code,status,claim.attempts]);
      if (result.rowCount!==1) throw new Error();
    });
    return status;
  };
}
