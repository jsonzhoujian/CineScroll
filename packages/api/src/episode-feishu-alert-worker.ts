import type { Pool } from "pg";
import { createEpisodeFeishuAlertDelivery } from "./episode-feishu-alert-delivery.ts";
import type { createEpisodeFeishuAlertSender } from "./episode-feishu-alert.ts";
import { StoryKnowledgeTaskWorker } from "./story-knowledge-task-worker.ts";

export function createEpisodeFeishuAlertWorker(options:{
  pool:Pool; workspaceIds:readonly string[]; enabled?:boolean;
  send:ReturnType<typeof createEpisodeFeishuAlertSender>;
}) {
  const tick=createEpisodeFeishuAlertDelivery(options.pool,options.workspaceIds,options.send);
  return new StoryKnowledgeTaskWorker({
    enabled:options.enabled===true,workspaceIds:options.workspaceIds,
    dispatcher:{async tick(workspaceId,mode,_,signal) {
      if (mode==="run" && !signal?.aborted) await tick(workspaceId);
      return {items:[],nextCursor:null};
    }},
  });
}

export async function assertEpisodeFeishuAlertDatabase(pool:Pool):Promise<void> {
  try {
    const {rows}=await pool.query(`select current_user='novel_episode_alert_delivery'
      and current_setting('row_security')='on'
      and not exists(select 1 from pg_roles where rolname in (current_user,session_user)
        and (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication))
      and not exists(select 1 from pg_roles where rolname not in(current_user,session_user)
        and pg_has_role(session_user,oid,'MEMBER'))
      and not has_schema_privilege(session_user,'public','CREATE')
      and (select count(*)=2 and bool_and(relrowsecurity and relforcerowsecurity
        and not pg_has_role(session_user,relowner,'MEMBER'))
        from pg_class where oid in ('public.episode_alert_deliveries'::regclass,'public.episode_reconciliation_alerts'::regclass))
      and has_column_privilege(current_user,'public.episode_reconciliation_alerts','code','SELECT')
      and has_column_privilege(current_user,'public.episode_alert_deliveries','channel','INSERT')
      and has_column_privilege(current_user,'public.episode_alert_deliveries','status','UPDATE')
      and not has_table_privilege(session_user,'public.episode_alert_deliveries','DELETE,TRUNCATE')
      and not has_any_column_privilege(session_user,'public.episode_reconciliation_alerts','INSERT,UPDATE')
      and not has_any_column_privilege(session_user,'public.credit_ledger_versions','SELECT,INSERT,UPDATE')
      as ready`);
    if (rows[0]?.ready!==true) throw new Error();
  } catch { throw new Error("EPISODE_FEISHU_DATABASE_NOT_READY"); }
}
