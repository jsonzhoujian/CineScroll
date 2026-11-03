import type { Actor } from "./index.ts";
import type { ModelSettingsClient,ModelSettingsPool } from "./postgres-model-settings.ts";
import type { ConfirmedScriptHandoff } from "./script-handoff.ts";
import { SettingsGenerationError,type SettingsCandidate,type SettingsCandidateRepository } from "./settings-runner.ts";

/** Initial generation is append-only. Chapter locking serializes empty-head creation and replay. */
export class PostgresSettingsCandidateRepository implements SettingsCandidateRepository {
  private readonly pool: ModelSettingsPool;
  private readonly handoff: Pick<ConfirmedScriptHandoff,"read">;
  constructor(pool: ModelSettingsPool,handoff: Pick<ConfirmedScriptHandoff,"read">) { this.pool = pool;this.handoff = handoff; }
  findGeneration(a: Actor,p: string,c: string,jobId: string) {
    return this.transaction(a,client => this.generation(client,a,p,c,jobId));
  }
  findActive(a: Actor,p: string,c: string) {
    return this.transaction(a,async client => decode((await client.query(`select v.version_json from settings_candidate_heads h
      join settings_candidate_versions v on v.workspace_id=h.workspace_id and v.project_id=h.project_id and v.chapter_id=h.chapter_id and v.id=h.active_version_id
      where h.workspace_id=$1 and h.project_id=$2 and h.chapter_id=$3`,[a.workspaceId,p,c])).rows[0]));
  }
  private async generation(client: ModelSettingsClient,a: Actor,p: string,c: string,jobId: string) {
    return decode((await client.query("select version_json from settings_candidate_versions where workspace_id=$1 and project_id=$2 and chapter_id=$3 and job_id=$4",[a.workspaceId,p,c,jobId])).rows[0]);
  }
  async saveGeneration(a: Actor,input: SettingsCandidate) {
    const v = structuredClone(input);
    const current = await this.handoff.read(a,v.projectId,v.chapterId);
    return this.transaction(a,async client => {
      const key = [a.workspaceId,v.projectId,v.chapterId];
      // Same lock order as script saves. Every authority pointer stays stable until dependencies commit.
      const project = (await client.query("select target_duration_seconds,aspect_ratio,narrative_mode from projects where workspace_id=$1 and id=$2 for share",[a.workspaceId,v.projectId])).rows[0];
      const chapter = (await client.query("select active_source_version_id from chapters where project_id=$1 and id=$2 for update",[v.projectId,v.chapterId])).rows[0];
      if (!chapter) throw new SettingsGenerationError("UPSTREAM_CHANGED");
      await client.query("select set_config('app.story_knowledge_operation',case when can_review_project($1) then 'confirm' else 'candidate' end,true)",[v.projectId]);
      const authority = new Map<string,unknown>();
      for (const table of ["story_knowledge_heads","episode_plan_heads","script_content_heads"]) {
        authority.set(table,(await client.query(`select confirmed_version_id from ${table} where workspace_id=$1 and project_id=$2 and chapter_id=$3 for share`,key)).rows[0]?.confirmed_version_id);
      }
      const plan = (await client.query("select version_json from episode_plan_versions where workspace_id=$1 and project_id=$2 and chapter_id=$3 and id=$4",[...key,current.version.planVersionId])).rows[0]?.version_json as Record<string,unknown> | undefined;
      const ids = [current.version.id,...current.upstreamConfirmedVersionIds];
      const lockedIds = [authority.get("script_content_heads"),authority.get("episode_plan_heads"),authority.get("story_knowledge_heads")];
      if (!project || !plan || plan.targetDurationSeconds !== project.target_duration_seconds || plan.aspectRatio !== project.aspect_ratio || plan.narrativeMode !== project.narrative_mode
        || chapter.active_source_version_id !== v.sourceVersionId || v.scriptVersionId !== current.version.id || v.sourceVersionId !== current.version.sourceVersionId
        || ids.length !== v.upstreamConfirmedVersionIds.length || ids.some((id,i) => id !== v.upstreamConfirmedVersionIds[i] || id !== lockedIds[i])) throw new SettingsGenerationError("UPSTREAM_CHANGED");
      if (v.createdBy !== a.userId || v.status !== "candidate") throw new SettingsGenerationError("INVALID_REQUEST");
      const replay = await this.generation(client,a,v.projectId,v.chapterId,v.jobId);
      if (replay) return replay;
      if ((await client.query("select active_version_id from settings_candidate_heads where workspace_id=$1 and project_id=$2 and chapter_id=$3",key)).rows.length) throw new SettingsGenerationError("CANDIDATE_EXISTS");
      await client.query(`insert into settings_candidate_versions(workspace_id,project_id,chapter_id,id,source_version_id,script_version_id,job_id,created_by,version_json)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,[...key,v.id,v.sourceVersionId,v.scriptVersionId,v.jobId,v.createdBy,JSON.stringify(v)]);
      // Canonical assets expose source evidence, not model-invented element IDs. Link only elements sharing that evidence.
      await client.query(`insert into script_downstream_dependencies(workspace_id,project_id,chapter_id,target_stage,target_version_id,target_item_id,script_version_id,script_element_id)
        select distinct s.workspace_id,s.project_id,s.chapter_id,'settings',s.id,asset->>'id',s.script_version_id,element->>'id'
        from settings_candidate_versions s join script_content_versions v on v.workspace_id=s.workspace_id and v.project_id=s.project_id and v.chapter_id=s.chapter_id and v.id=s.script_version_id
        cross join lateral jsonb_array_elements(s.version_json->'assets') asset
        cross join lateral jsonb_array_elements(v.version_json->'elements') element
        cross join lateral jsonb_array_elements(asset->'provenance') ap
        cross join lateral jsonb_array_elements(element->'provenance') ep
        where s.workspace_id=$1 and s.project_id=$2 and s.chapter_id=$3 and s.id=$4
          and ap->>'type'='source_fragment' and ep->>'type'='source_fragment'
          and ap->>'sourceVersionId'=ep->>'sourceVersionId' and ap->>'fragmentId'=ep->>'fragmentId'`,[...key,v.id]);
      await client.query("insert into settings_candidate_heads(workspace_id,project_id,chapter_id,active_version_id) values($1,$2,$3,$4)",[...key,v.id]);
      return v;
    });
  }
  private async transaction<T>(a: Actor,action: (client: ModelSettingsClient) => Promise<T>) {
    let client: ModelSettingsClient | undefined;
    try {
      client = await this.pool.connect();await client.query("begin");await client.query("set local statement_timeout='5s'");
      await client.query("select set_config('app.current_user_id',$1,true),set_config('app.current_workspace_id',$2,true)",[a.userId,a.workspaceId]);
      const result = await action(client);await client.query("commit");return result;
    } catch (error) {
      try { await client?.query("rollback"); } catch { /* Preserve sanitized failure. */ }
      if (error instanceof SettingsGenerationError) throw error;
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (code === "42501") throw new SettingsGenerationError("FORBIDDEN");
      throw new SettingsGenerationError("STORAGE_UNAVAILABLE");
    } finally { client?.release(); }
  }
}
function decode(row: Record<string,unknown> | undefined): SettingsCandidate | null { return row ? structuredClone(row.version_json) as SettingsCandidate : null; }
