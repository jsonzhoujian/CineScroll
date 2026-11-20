import type { Pool } from "pg";

const codes=["PLATFORM_SUCCESS_DISABLED","EXECUTION_UNKNOWN","INVALID_EVIDENCE","RECONCILIATION_UNAVAILABLE"] as const;
type Code=typeof codes[number];
export function isEpisodeReconciliationAlertCode(value:unknown):value is Code {
  return typeof value==="string" && codes.some(code=>code===value);
}
type Cursor={taskId:string;code:Code};
type Actor={serviceId:string;workspaceId:string};

const identifier=(value:unknown):value is string=>typeof value==="string" && value.trim()===value
  && value.length>0 && value.length<=256 && !/[\r\n\0]/.test(value);

/** Internal read port. The host supplies an authenticated service identity. */
export function createEpisodeReconciliationAlertReader(pool:Pool,policy:{
  serviceId:string;workspaceIds:readonly string[];
}) {
  const serviceId=policy.serviceId;
  const workspaces=new Set(policy.workspaceIds);
  if (!identifier(serviceId) || [...workspaces].some(id=>!identifier(id))) throw new Error("INVALID_ALERT_READER_CONFIG");
  return async (actor:Actor,page:{limit:number;cursor:Cursor|null})=>{
    const {workspaceId}=actor;
    if (actor.serviceId!==serviceId || !workspaces.has(workspaceId)) throw new Error("FORBIDDEN");
    const {limit,cursor}=structuredClone(page);
    if (!Number.isInteger(limit) || limit<1 || limit>50 || (cursor!==null
      && (!cursor || !identifier(cursor.taskId) || !isEpisodeReconciliationAlertCode(cursor.code)))) throw new Error("INVALID_CURSOR");
    const client=await pool.connect().catch(()=>{throw new Error("EPISODE_ALERTS_UNAVAILABLE");});
    let discard=false;
    try {
      await client.query("begin read only; set local statement_timeout='5s'");
      await client.query("select set_config('app.episode_reconciliation_workspace_id',$1,true)",[workspaceId]);
      const result=await client.query<{task_id:string;code:Code;created_at:Date}>(`
        select task_id,code,created_at from public.episode_reconciliation_alerts
        where workspace_id=$1 and ($2::text is null or (task_id collate "C",code collate "C") > ($2,$3))
        order by task_id collate "C",code collate "C" limit $4`,
      [workspaceId,cursor?.taskId??null,cursor?.code??null,limit+1]);
      const items=result.rows.slice(0,limit).map(row=>({taskId:row.task_id,code:row.code,createdAt:row.created_at.toISOString()}));
      const last=items.at(-1);
      await client.query("commit");
      return {items,nextCursor:result.rows.length>limit && last ? {taskId:last.taskId,code:last.code} : null};
    } catch {
      try { await client.query("rollback"); } catch { discard=true; }
      throw new Error("EPISODE_ALERTS_UNAVAILABLE");
    } finally { client.release(discard); }
  };
}
