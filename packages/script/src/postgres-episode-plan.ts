import { ScriptError, ScriptUpstreamChangedError, type Actor, type EpisodePlanVersion, type ScriptRepository } from "./index.ts";
import type { ModelSettingsPool, ModelSettingsClient } from "./postgres-model-settings.ts";

export class PostgresScriptRepository implements ScriptRepository {
  readonly #pool: ModelSettingsPool;
  constructor(pool: ModelSettingsPool) { this.#pool = pool; }
  findEpisodePlanVersion(actor: Actor, projectId: string, chapterId: string, id: string) {
    return this.#transaction(actor, async client => decode((await client.query("select version_json from episode_plan_versions where workspace_id=$1 and project_id=$2 and chapter_id=$3 and id=$4", [actor.workspaceId,projectId,chapterId,id])).rows[0]));
  }
  findActiveEpisodePlan(actor: Actor, projectId: string, chapterId: string) { return this.#head(actor,projectId,chapterId,false); }
  findConfirmedEpisodePlan(actor: Actor, projectId: string, chapterId: string) { return this.#head(actor,projectId,chapterId,true); }
  #head(actor: Actor, projectId: string, chapterId: string, confirmed: boolean) {
    return this.#transaction(actor, async client => decode((await client.query(`select v.version_json from episode_plan_heads h join episode_plan_versions v on v.workspace_id=h.workspace_id and v.project_id=h.project_id and v.chapter_id=h.chapter_id and v.id=h.${confirmed ? "confirmed_version_id" : "active_version_id"} where h.workspace_id=$1 and h.project_id=$2 and h.chapter_id=$3`, [actor.workspaceId,projectId,chapterId])).rows[0]));
  }
  findOperationResult(actor: Actor, projectId: string, chapterId: string, key: string) {
    return this.#transaction(actor, client => operationResult(client,actor,projectId,chapterId,key));
  }
  saveEpisodePlan(actor: Actor, version: EpisodePlanVersion, expected?: string | null, operation?: { key: string; fingerprint: string }) {
    return this.#transaction(actor, async client => {
      const params = [actor.workspaceId,version.projectId,version.chapterId];
      // Same lock order as story writes: chapter, knowledge head, plan head. No external call under lock.
      const chapter = (await client.query("select active_source_version_id from chapters where project_id=$1 and id=$2 for share", [version.projectId,version.chapterId])).rows[0];
      if (!chapter) throw new ScriptError("FORBIDDEN", "章节不存在或无权访问");
      await client.query("select set_config('app.story_knowledge_operation',case when can_review_project($1) then 'confirm' else 'candidate' end,true)", [version.projectId]);
      const knowledge = (await client.query("select h.confirmed_version_id,v.source_version_id from story_knowledge_heads h left join story_knowledge_versions v on v.workspace_id=h.workspace_id and v.project_id=h.project_id and v.chapter_id=h.chapter_id and v.id=h.confirmed_version_id where h.workspace_id=$1 and h.project_id=$2 and h.chapter_id=$3 for share of h",params)).rows[0];
      if (!knowledge?.confirmed_version_id) throw new ScriptError("CONFIRMED_STORY_BIBLE_NOT_FOUND", "请先确认故事知识");
      if (chapter.active_source_version_id !== version.sourceVersionId || knowledge.confirmed_version_id !== version.storyBibleVersionId || knowledge.source_version_id !== version.sourceVersionId) throw new ScriptUpstreamChangedError();
      await client.query("insert into episode_plan_heads(workspace_id,project_id,chapter_id) values($1,$2,$3) on conflict do nothing",params);
      const head = (await client.query("select active_version_id from episode_plan_heads where workspace_id=$1 and project_id=$2 and chapter_id=$3 for update",params)).rows[0]!;
      if (operation) {
        const replay = await operationResult(client,actor,version.projectId,version.chapterId,operation.key);
        if (replay) { if (replay.fingerprint !== operation.fingerprint) throw new ScriptError("INVALID_EPISODE_PLAN", "重复操作内容不一致"); return replay.version; }
      }
      const current = head.active_version_id ?? null;
      if (expected !== undefined && current !== expected || version.parentVersionId !== current) throw new ScriptError("VERSION_CONFLICT", "拆集方案版本冲突");
      if (current) {
        const old = decode((await client.query("select version_json from episode_plan_versions where workspace_id=$1 and project_id=$2 and chapter_id=$3 and id=$4", [...params,current])).rows[0]);
        if (old?.status === "confirmed") throw new ScriptError("CONFIRMED_PLAN_REQUIRES_SUGGESTION", "已确认方案不可覆盖");
      }
      if (version.createdBy !== actor.userId || version.status === "confirmed" && (version.confirmedBy !== actor.userId || !version.parentVersionId || version.majorAdaptationProposals.some(p => !p.decision))) throw new ScriptError("INVALID_EPISODE_PLAN", "确认元数据或改编裁决无效");
      await client.query("insert into episode_plan_versions(workspace_id,project_id,chapter_id,id,parent_version_id,source_version_id,story_bible_version_id,status,created_by,version_json) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)", [...params,version.id,version.parentVersionId,version.sourceVersionId,version.storyBibleVersionId,version.status,version.createdBy,JSON.stringify(version)]);
      await client.query("update episode_plan_heads set active_version_id=$4,confirmed_version_id=case when $5='confirmed' then $4 else confirmed_version_id end where workspace_id=$1 and project_id=$2 and chapter_id=$3", [...params,version.id,version.status]);
      if (operation) await client.query("insert into episode_plan_operations(workspace_id,project_id,chapter_id,operation_key,fingerprint,version_id) values($1,$2,$3,$4,$5,$6)", [...params,operation.key,operation.fingerprint,version.id]);
      return structuredClone(version);
    });
  }
  async #transaction<T>(actor: Actor, action: (client: ModelSettingsClient) => Promise<T>): Promise<T> {
    let client: ModelSettingsClient | undefined;
    try {
      client = await this.#pool.connect(); await client.query("begin"); await client.query("set local statement_timeout='5s'");
      await client.query("select set_config('app.current_user_id',$1,true),set_config('app.current_workspace_id',$2,true)", [actor.userId,actor.workspaceId]);
      const value = await action(client); await client.query("commit"); return value;
    } catch (error) {
      try { await client?.query("rollback"); } catch { /* Retain sanitized error. */ }
      if (error instanceof ScriptError) throw error;
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (code === "42501") throw new ScriptError("FORBIDDEN", "无权操作拆集方案");
      if (["23505", "23503"].includes(code)) throw new ScriptError("VERSION_CONFLICT", "拆集引用或版本变化");
      throw new ScriptError("STORAGE_UNAVAILABLE", "拆集存储暂时不可用");
    } finally { client?.release(); }
  }
}
function decode(row: Record<string, unknown> | undefined): EpisodePlanVersion | null { return row ? structuredClone(row.version_json) as EpisodePlanVersion : null; }
async function operationResult(client: ModelSettingsClient, actor: Actor, projectId: string, chapterId: string, key: string) {
  const row = (await client.query("select o.fingerprint,v.version_json from episode_plan_operations o join episode_plan_versions v on v.workspace_id=o.workspace_id and v.project_id=o.project_id and v.chapter_id=o.chapter_id and v.id=o.version_id where o.workspace_id=$1 and o.project_id=$2 and o.chapter_id=$3 and o.operation_key=$4", [actor.workspaceId,projectId,chapterId,key])).rows[0];
  return row ? { fingerprint: String(row.fingerprint), version: decode(row)! } : null;
}
