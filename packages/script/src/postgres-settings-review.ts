import type { Actor } from "./index.ts";
import type { ConfirmedScriptHandoff } from "./script-handoff.ts";
import type { ModelSettingsPool,ModelSettingsClient } from "./postgres-model-settings.ts";
import { SettingsReviewError,type SettingsVersion,type SettingsReviewRepository } from "./settings-review.ts";
/** Review history is separate from immutable generation results. SQL guards enforce transitions and authority. */
export class PostgresSettingsReviewRepository implements SettingsReviewRepository {
  private readonly pool: ModelSettingsPool;
  private readonly handoff: Pick<ConfirmedScriptHandoff,"read">;
  constructor(pool: ModelSettingsPool,handoff: Pick<ConfirmedScriptHandoff,"read">) { this.pool = pool;this.handoff = handoff; }
  findActive(a: Actor,p: string,c: string) { return this.transaction(a,client => this.active(client,a,p,c)); }
  private async active(client: ModelSettingsClient,a: Actor,p: string,c: string) {
    const key = [a.workspaceId,p,c];
    const reviewed = (await client.query("select v.version_json from settings_review_heads h join settings_review_versions v on v.workspace_id=h.workspace_id and v.project_id=h.project_id and v.chapter_id=h.chapter_id and v.id=h.active_version_id where h.workspace_id=$1 and h.project_id=$2 and h.chapter_id=$3",key)).rows[0];
    if (reviewed) return decode(reviewed);
    return decode((await client.query("select v.version_json from settings_candidate_heads h join settings_candidate_versions v on v.workspace_id=h.workspace_id and v.project_id=h.project_id and v.chapter_id=h.chapter_id and v.id=h.active_version_id where h.workspace_id=$1 and h.project_id=$2 and h.chapter_id=$3",key)).rows[0]);
  }
  findConfirmed(a: Actor,p: string,c: string) {
    return this.transaction(a,async client => decode((await client.query("select v.version_json from settings_review_heads h join settings_review_versions v on v.workspace_id=h.workspace_id and v.project_id=h.project_id and v.chapter_id=h.chapter_id and v.id=h.confirmed_version_id where h.workspace_id=$1 and h.project_id=$2 and h.chapter_id=$3",[a.workspaceId,p,c])).rows[0]));
  }
  findVersion(a: Actor,p: string,c: string,id: string) {
    return this.transaction(a,async client => decode((await client.query("select version_json from settings_review_versions where workspace_id=$1 and project_id=$2 and chapter_id=$3 and id=$4 union all select version_json from settings_candidate_versions where workspace_id=$1 and project_id=$2 and chapter_id=$3 and id=$4 limit 1",[a.workspaceId,p,c,id])).rows[0]));
  }
  findOperation(a: Actor,p: string,c: string,id: string) { return this.transaction(a,client => this.operation(client,a,p,c,id)); }
  private async operation(client: ModelSettingsClient,a: Actor,p: string,c: string,id: string) {
    return decode((await client.query("select version_json from settings_review_versions where workspace_id=$1 and project_id=$2 and chapter_id=$3 and created_by=$4 and version_json->'operation'->>'requestId'=$5",[a.workspaceId,p,c,a.userId,id])).rows[0]);
  }
  async save(a: Actor,input: SettingsVersion,expected: string) {
    const v = structuredClone(input);
    const formal = await this.handoff.read(a,v.projectId,v.chapterId),ids = [formal.version.id,...formal.upstreamConfirmedVersionIds];
    if (v.scriptVersionId !== formal.version.id || v.sourceVersionId !== formal.version.sourceVersionId || v.upstreamConfirmedVersionIds.length !== ids.length || ids.some((id,i) => id !== v.upstreamConfirmedVersionIds[i])) throw new SettingsReviewError("UPSTREAM_CHANGED");
    if (!v.operation || v.createdBy !== a.userId || v.parentVersionId !== expected) throw new SettingsReviewError("INVALID_COMMAND");
    return this.transaction(a,async client => {
      const key = [a.workspaceId,v.projectId,v.chapterId];
      // Project/chapter order matches script generation and the database transition guard.
      const authority = (await client.query("select lock_settings_review_authority($1,$2,$3) as authority",key)).rows[0]?.authority as Record<string,unknown> | undefined;
      if (!authority || authority.sourceId !== v.sourceVersionId || authority.scriptId !== ids[0] || authority.planId !== ids[1] || authority.knowledgeId !== ids[2]) throw new SettingsReviewError("UPSTREAM_CHANGED");
      const replay = await this.operation(client,a,v.projectId,v.chapterId,v.operation!.requestId);
      if (replay) { if (replay.operation?.fingerprint !== v.operation!.fingerprint) throw new SettingsReviewError("VERSION_CONFLICT");return replay; }
      const active = await this.active(client,a,v.projectId,v.chapterId);
      if (!active) throw new SettingsReviewError("NOT_FOUND");
      if (active.id !== expected) throw new SettingsReviewError("VERSION_CONFLICT");
      const parent = (await client.query("select id,origin_version_id from settings_review_versions where workspace_id=$1 and project_id=$2 and chapter_id=$3 and id=$4",[...key,expected])).rows[0];
      const origin = parent?.origin_version_id ?? expected;
      await client.query("insert into settings_review_versions(workspace_id,project_id,chapter_id,id,origin_version_id,parent_review_id,created_by,version_json) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",[...key,v.id,origin,parent?.id ?? null,a.userId,JSON.stringify(v)]);
      await client.query(`insert into script_downstream_dependencies(workspace_id,project_id,chapter_id,target_stage,target_version_id,target_item_id,script_version_id,script_element_id)
        select distinct r.workspace_id,r.project_id,r.chapter_id,'settings',r.id,asset->>'id',r.version_json->>'scriptVersionId',element->>'id'
        from settings_review_versions r join settings_candidate_versions s on s.workspace_id=r.workspace_id and s.project_id=r.project_id and s.chapter_id=r.chapter_id and s.id=r.origin_version_id
        join script_content_versions v on v.workspace_id=s.workspace_id and v.project_id=s.project_id and v.chapter_id=s.chapter_id and v.id=r.version_json->>'scriptVersionId'
        cross join lateral jsonb_array_elements(r.version_json->'assets') asset cross join lateral jsonb_array_elements(v.version_json->'elements') element
        cross join lateral jsonb_array_elements(asset->'provenance') ap cross join lateral jsonb_array_elements(element->'provenance') ep
        where r.workspace_id=$1 and r.project_id=$2 and r.chapter_id=$3 and r.id=$4 and ap->>'type'='source_fragment' and ep->>'type'='source_fragment'
          and ap->>'sourceVersionId'=ep->>'sourceVersionId' and ap->>'fragmentId'=ep->>'fragmentId'`,[...key,v.id]);
      if (parent) await client.query("update settings_review_heads set active_version_id=$4 where workspace_id=$1 and project_id=$2 and chapter_id=$3",[...key,v.id]);
      else await client.query("insert into settings_review_heads(workspace_id,project_id,chapter_id,active_version_id) values($1,$2,$3,$4)",[...key,v.id]);
      return v;
    });
  }
  private async transaction<T>(a: Actor,action: (client: ModelSettingsClient) => Promise<T>) {
    let client: ModelSettingsClient | undefined;
    try {
      client = await this.pool.connect();await client.query("begin");await client.query("set local statement_timeout='5s'");
      await client.query("select set_config('app.current_user_id',$1,true),set_config('app.current_workspace_id',$2,true),set_config('app.model_workspace_id',$2,true)",[a.userId,a.workspaceId]);
      const result = await action(client);await client.query("commit");return result;
    } catch (error) {
      try { await client?.query("rollback"); } catch { /* Preserve sanitized failure. */ }
      if (error instanceof SettingsReviewError) throw error;
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (code === "P7001") throw new SettingsReviewError("UPSTREAM_CHANGED");
      if (code === "42501") throw new SettingsReviewError("FORBIDDEN");
      if (["23505","23503"].includes(code)) throw new SettingsReviewError("VERSION_CONFLICT");
      throw new SettingsReviewError("STORAGE_UNAVAILABLE");
    } finally { client?.release(); }
  }
}
function decode(row: Record<string,unknown> | undefined): SettingsVersion | null {
  return row ? structuredClone({ parentVersionId: null,suggestions: [],locks: {},...(row.version_json as Partial<SettingsVersion>) }) as SettingsVersion : null;
}
