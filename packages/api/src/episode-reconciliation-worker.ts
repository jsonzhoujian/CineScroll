import type { Pool } from "pg";
import { validateTaskPage } from "@novel-adaptation/script/model-tasks";
import { createEpisodeReconciliation } from "./episode-reconciliation.ts";
import { StoryKnowledgeTaskWorker } from "./story-knowledge-task-worker.ts";

type ReconciliationOptions = Parameters<typeof createEpisodeReconciliation>[0];
type Alert = Parameters<ReconciliationOptions["alert"]>[0];

/** The checkpoint pool uses the dedicated state role. Evidence and ledger ports use their own pools. */
export function createEpisodeReconciliationWorker(options:Omit<ReconciliationOptions,"alert"> & {
  pool:Pool;
  enabled?:boolean;
  pageSize?:number;
  intervalMs?:number;
}) {
  const {pool,enabled,intervalMs}=options;
  const limit=options.pageSize ?? 20;
  const workspaceIds=[...options.workspaceIds];
  const allowed=new Set(workspaceIds);
  validateTaskPage({limit,cursor:null});

  async function tick(workspaceId:string) {
    if (!allowed.has(workspaceId)) throw new Error("FORBIDDEN");
    const client=await pool.connect().catch(()=>{throw new Error("EPISODE_RECONCILIATION_STORE_UNAVAILABLE");});
    let committing=false;
    let discard=false;
    try {
      await client.query("begin; set local statement_timeout='5s'; set local lock_timeout='2s'; set local idle_in_transaction_session_timeout='5min'");
      await client.query("select set_config('app.episode_reconciliation_workspace_id',$1,true)",[workspaceId]);
      await client.query("insert into public.episode_reconciliation_checkpoints(workspace_id) values($1) on conflict do nothing",[workspaceId]);
      const checkpoint=(await client.query<{cursor:string|null}>(
        "select cursor from public.episode_reconciliation_checkpoints where workspace_id=$1 for update",[workspaceId])).rows[0];
      if (!checkpoint) throw new Error();
      const alerts:Pick<Alert,"taskId"|"code">[]=[];
      const reconcile=createEpisodeReconciliation({...options,workspaceIds,alert:async ({taskId,code})=>{alerts.push({taskId,code});}});
      const result=await reconcile(workspaceId,{limit,cursor:checkpoint.cursor});
      if (alerts.length) {
        await client.query(`insert into public.episode_reconciliation_alerts(workspace_id,task_id,code)
          select $1,"taskId",code from jsonb_to_recordset($2::jsonb) as alert("taskId" text,code text)
          on conflict do nothing`,[workspaceId,JSON.stringify(alerts)]);
      }
      await client.query("update public.episode_reconciliation_checkpoints set cursor=$2 where workspace_id=$1",[workspaceId,result.nextCursor]);
      committing=true;
      if ((await client.query("commit")).command!=="COMMIT") throw new Error();
      return result;
    } catch {
      discard=committing;
      if (!committing) try { await client.query("rollback"); } catch { discard=true; }
      throw new Error("EPISODE_RECONCILIATION_STORE_UNAVAILABLE");
    } finally { client.release(discard); }
  }

  const worker=new StoryKnowledgeTaskWorker({
    workspaceIds,enabled:enabled===true,...(intervalMs===undefined ? {} : {intervalMs}),
    dispatcher:{async tick(workspaceId,mode) {
      if (mode==="recover") return {items:[],nextCursor:null};
      const page=await tick(workspaceId);
      if (page.items.some(item=>item.code==="RECONCILIATION_UNAVAILABLE")) throw new Error("RECONCILIATION_UNAVAILABLE");
      return {items:[],nextCursor:null};
    }},
  });
  return {worker,tick};
}
