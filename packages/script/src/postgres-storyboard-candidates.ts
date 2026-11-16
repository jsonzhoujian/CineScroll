import type { Actor } from "./index.ts";
import type { ModelSettingsClient, ModelSettingsPool } from "./postgres-model-settings.ts";
import { validateStoryboardShot, type StoryboardResponseIdentity } from "./storyboard-content.ts";
import { StoryboardUpstreamError, type ConfirmedStoryboardHandoff } from "./storyboard-handoff.ts";
import type { StoryboardCandidate, StoryboardCandidateRepository } from "./storyboard-runner.ts";

export class StoryboardStorageError extends Error {
  constructor(code: "FORBIDDEN" | "INVALID_CANDIDATE" | "POLICY_RESTRICTED" | "STORAGE_UNAVAILABLE") {
    super(code);
    this.code = code;
  }
  readonly code: "FORBIDDEN" | "INVALID_CANDIDATE" | "POLICY_RESTRICTED" | "STORAGE_UNAVAILABLE";
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

  submitReview(actor: Actor, projectId: string, chapterId: string, jobId: string) {
    return this.transaction(actor, async client => {
      const key = [actor.workspaceId,projectId,chapterId,jobId];
      const inserted = (await client.query(`insert into storyboard_review_submissions(workspace_id,project_id,chapter_id,job_id)
        values($1,$2,$3,$4) on conflict(workspace_id,project_id,chapter_id,job_id) do nothing returning id`,key)).rows[0];
      const row = inserted ?? (await client.query(`select id from storyboard_review_submissions
        where (workspace_id,project_id,chapter_id,job_id)=($1,$2,$3,$4) and submitted_by=$5`,[...key,actor.userId])).rows[0];
      if (!row) throw new StoryboardStorageError("FORBIDDEN");
      return { id: row.id as string };
    });
  }

  listReviews(actor: Actor, projectId: string, chapterId: string, cursor: string | null) {
    return this.transaction(actor, async client => {
      const rows = (await client.query(`select id,submitted_at::text from storyboard_review_submissions
        where (workspace_id,project_id,chapter_id)=($1,$2,$3) and ($4::uuid is null or id>$4) order by id limit 21`,
      [actor.workspaceId,projectId,chapterId,cursor])).rows;
      const reviews = rows.slice(0,20).map(row => ({ id: row.id as string, submittedAt: row.submitted_at as string }));
      return { reviews, nextCursor: rows.length > 20 ? reviews.at(-1)!.id : null };
    });
  }

  findReview(actor: Actor, projectId: string, chapterId: string, reviewId: string) {
    return this.transaction(actor, async client => {
      const row = (await client.query(`select v.version_json from storyboard_review_submissions r
        join storyboard_candidate_versions v using(workspace_id,project_id,chapter_id,job_id)
        where (r.workspace_id,r.project_id,r.chapter_id,r.id)=($1,$2,$3,$4)`,
      [actor.workspaceId,projectId,chapterId,reviewId])).rows[0];
      return row ? structuredClone(row.version_json) as StoryboardCandidate : null;
    });
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
      await client.query("select set_config('app.current_user_id',$1,true),set_config('app.current_workspace_id',$2,true),set_config('app.model_workspace_id',$2,true)", [actor.userId, actor.workspaceId]);
      const result = await action(client);
      await client.query("commit");
      return result;
    } catch (error) {
      try { await client?.query("rollback"); } catch { /* Preserve the original error. */ }
      if (error instanceof StoryboardStorageError) throw error;
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code === "P7001") throw new StoryboardUpstreamError();
      throw new StoryboardStorageError(code === "42501" ? "FORBIDDEN" : code === "P7002" ? "INVALID_CANDIDATE" : code === "P7003" ? "POLICY_RESTRICTED" : "STORAGE_UNAVAILABLE");
    } finally {
      client?.release();
    }
  }
}
