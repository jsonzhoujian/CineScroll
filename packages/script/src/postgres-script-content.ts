import { ScriptContentError, type ScriptContentRepository, type ScriptContentVersion } from "./script-content.ts";
import type { Actor } from "./index.ts";
import type { ModelSettingsClient, ModelSettingsPool } from "./postgres-model-settings.ts";

/** Internal server repository. Membership is enforced by forced database RLS. */
export class PostgresScriptContentRepository implements ScriptContentRepository {
  private readonly pool: ModelSettingsPool;
  constructor(pool: ModelSettingsPool) { this.pool = pool; }
  findActive(actor: Actor, projectId: string, chapterId: string) {
    return this.transaction(actor,async client => decode((await client.query(`select v.version_json from script_content_heads h
      join script_content_versions v using(workspace_id,project_id,chapter_id)
      where h.workspace_id=$1 and h.project_id=$2 and h.chapter_id=$3 and v.id=h.active_version_id`,[actor.workspaceId,projectId,chapterId])).rows[0]));
  }
  findGeneration(actor: Actor, projectId: string, chapterId: string, jobId: string) {
    return this.transaction(actor,async client => decode((await client.query(`select v.version_json from script_content_generations g
      join script_content_versions v on v.workspace_id=g.workspace_id and v.project_id=g.project_id and v.chapter_id=g.chapter_id and v.id=g.version_id
      where g.workspace_id=$1 and g.project_id=$2 and g.chapter_id=$3 and g.job_id=$4`,[actor.workspaceId,projectId,chapterId,jobId])).rows[0]));
  }
  save(actor: Actor, input: ScriptContentVersion, expected: string | null) {
    const version = structuredClone(input);
    return this.transaction(actor,async client => {
      const key = [actor.workspaceId,version.projectId,version.chapterId];
      const chapter = (await client.query("select active_source_version_id from chapters where project_id=$1 and id=$2 for share",[version.projectId,version.chapterId])).rows[0];
      await client.query("select set_config('app.story_knowledge_operation',case when can_review_project($1) then 'confirm' else 'candidate' end,true)",[version.projectId]);
      const knowledge = (await client.query("select confirmed_version_id from story_knowledge_heads where workspace_id=$1 and project_id=$2 and chapter_id=$3 for share",key)).rows[0];
      const plan = (await client.query(`select h.confirmed_version_id,v.source_version_id,v.story_bible_version_id from episode_plan_heads h
        join episode_plan_versions v on v.workspace_id=h.workspace_id and v.project_id=h.project_id and v.chapter_id=h.chapter_id and v.id=h.confirmed_version_id
        where h.workspace_id=$1 and h.project_id=$2 and h.chapter_id=$3 for share of h`,key)).rows[0];
      if (!chapter || !plan || chapter.active_source_version_id !== version.sourceVersionId || plan.source_version_id !== version.sourceVersionId
        || plan.confirmed_version_id !== version.planVersionId || knowledge?.confirmed_version_id !== plan.story_bible_version_id) throw new ScriptContentError("CONTEXT_NOT_FOUND","剧本上游已变化");
      // This ticket only exposes generation writes; review/confirmation gets its own workflow.
      if (version.status !== "candidate" || version.createdBy !== actor.userId || version.parentVersionId !== expected) throw new ScriptContentError("INVALID_GENERATION","候选元数据无效");
      await client.query("insert into script_content_heads(workspace_id,project_id,chapter_id) values($1,$2,$3) on conflict do nothing",key);
      const head = (await client.query("select active_version_id from script_content_heads where workspace_id=$1 and project_id=$2 and chapter_id=$3 for update",key)).rows[0];
      if ((head?.active_version_id ?? null) !== expected) throw new ScriptContentError("VERSION_CONFLICT","剧本已更新");
      await client.query(`insert into script_content_versions(workspace_id,project_id,chapter_id,id,parent_version_id,source_version_id,plan_version_id,job_id,created_by,version_json)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,[...key,version.id,version.parentVersionId,version.sourceVersionId,version.planVersionId,version.jobId,version.createdBy,JSON.stringify(version)]);
      await client.query("insert into script_content_generations(workspace_id,project_id,chapter_id,job_id,version_id) values($1,$2,$3,$4,$5) on conflict do nothing",[...key,version.jobId,version.id]);
      await client.query("update script_content_heads set active_version_id=$4 where workspace_id=$1 and project_id=$2 and chapter_id=$3",[...key,version.id]);
      return version;
    });
  }
  private async transaction<T>(actor: Actor, action: (client: ModelSettingsClient) => Promise<T>) {
    let client: ModelSettingsClient | undefined;
    try {
      client = await this.pool.connect(); await client.query("begin"); await client.query("set local statement_timeout='5s'");
      await client.query("select set_config('app.current_user_id',$1,true),set_config('app.current_workspace_id',$2,true)",[actor.userId,actor.workspaceId]);
      const result = await action(client); await client.query("commit"); return result;
    } catch (error) {
      try { await client?.query("rollback"); } catch { /* Preserve sanitized failure. */ }
      if (error instanceof ScriptContentError) throw error;
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (["23505","23503"].includes(code)) throw new ScriptContentError("VERSION_CONFLICT","剧本引用或版本变化");
      if (code === "42501") throw new ScriptContentError("FORBIDDEN","无权访问剧本");
      throw new ScriptContentError("STORAGE_UNAVAILABLE","剧本存储暂不可用");
    } finally { client?.release(); }
  }
}
function decode(row: Record<string,unknown> | undefined): ScriptContentVersion | null { return row ? structuredClone(row.version_json) as ScriptContentVersion : null; }
