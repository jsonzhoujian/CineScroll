import type { Actor } from "./index.ts";
import type { ModelSettingsClient, ModelSettingsPool } from "./postgres-model-settings.ts";
import { validateStoryboardShot, type StoryboardResponseIdentity } from "./storyboard-content.ts";
import { StoryboardUpstreamError, type ConfirmedStoryboardHandoff } from "./storyboard-handoff.ts";
import type { StoryboardCandidate, StoryboardCandidateRepository } from "./storyboard-runner.ts";

export class StoryboardStorageError extends Error {
  constructor(code: "FORBIDDEN" | "INVALID_CANDIDATE" | "STORAGE_UNAVAILABLE") {
    super(code);
    this.code = code;
  }
  readonly code: "FORBIDDEN" | "INVALID_CANDIDATE" | "STORAGE_UNAVAILABLE";
}

export class PostgresStoryboardCandidateRepository implements StoryboardCandidateRepository {
  private readonly pool: ModelSettingsPool;
  private readonly handoff: Pick<ConfirmedStoryboardHandoff, "read">;

  constructor(pool: ModelSettingsPool, handoff: Pick<ConfirmedStoryboardHandoff, "read">) {
    this.pool = pool;
    this.handoff = handoff;
  }

  findGeneration(actor: Actor, identity: StoryboardResponseIdentity) {
    return this.transaction(actor, client => this.find(client, actor, identity));
  }

  private async find(client: ModelSettingsClient, actor: Actor, identity: StoryboardResponseIdentity) {
    const row = (await client.query(`select version_json from storyboard_candidate_versions
      where workspace_id=$1 and project_id=$2 and chapter_id=$3 and job_id=$4 and created_by=$5
        and version_json->>'sourceVersionId'=$6 and version_json->'upstreamConfirmedVersionIds'=$7::jsonb`,
    [actor.workspaceId, identity.projectId, identity.chapterId, identity.jobId, actor.userId,
      identity.sourceVersionId, JSON.stringify(identity.upstreamConfirmedVersionIds)])).rows[0];
    return row ? structuredClone(row.version_json) as StoryboardCandidate : null;
  }

  async saveGeneration(actor: Actor, input: StoryboardCandidate) {
    const candidate = structuredClone(input);
    if (candidate.createdBy !== actor.userId) throw new StoryboardStorageError("FORBIDDEN");
    const upstream = await this.handoff.read(actor, candidate.projectId, candidate.chapterId);
    if (upstream.sourceVersionId !== candidate.sourceVersionId
      || upstream.upstreamConfirmedVersionIds.length !== candidate.upstreamConfirmedVersionIds.length
      || upstream.upstreamConfirmedVersionIds.some((id, i) => id !== candidate.upstreamConfirmedVersionIds[i])) throw new StoryboardUpstreamError();
    if (new Set(candidate.shots.map(shot => shot.id)).size !== candidate.shots.length
      || candidate.shots.some(shot => !validateStoryboardShot(shot, upstream.context))) throw new StoryboardStorageError("INVALID_CANDIDATE");

    return this.transaction(actor, async client => {
      const key = [actor.workspaceId, candidate.projectId, candidate.chapterId, candidate.jobId];
      const inserted = (await client.query(`insert into storyboard_candidate_versions(workspace_id,project_id,chapter_id,job_id,created_by,version_json)
        values($1,$2,$3,$4,$5,$6::jsonb) on conflict do nothing returning job_id`, [...key, actor.userId, JSON.stringify(candidate)])).rows[0];
      if (!inserted) {
        const original = await this.find(client, actor, candidate);
        if (!original) throw new StoryboardStorageError("FORBIDDEN");
        return original;
      }
      return candidate;
    });
  }

  private async transaction<T>(actor: Actor, action: (client: ModelSettingsClient) => Promise<T>) {
    let client: ModelSettingsClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query("begin");
      await client.query("set local statement_timeout='5s'");
      await client.query("select set_config('app.current_user_id',$1,true),set_config('app.current_workspace_id',$2,true)", [actor.userId, actor.workspaceId]);
      const result = await action(client);
      await client.query("commit");
      return result;
    } catch (error) {
      try { await client?.query("rollback"); } catch { /* Preserve the original error. */ }
      if (error instanceof StoryboardStorageError) throw error;
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code === "P7001") throw new StoryboardUpstreamError();
      throw new StoryboardStorageError(code === "42501" ? "FORBIDDEN" : "STORAGE_UNAVAILABLE");
    } finally {
      client?.release();
    }
  }
}
