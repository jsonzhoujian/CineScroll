import type { Pool, PoolClient, QueryResultRow } from "pg";
import { isDeepStrictEqual } from "node:util";

import type {
  Actor,
  StoryBible,
  StoryKnowledgeRepository,
  StoryKnowledgeVersion,
} from "./index.ts";
import { StoryKnowledgeError, StoryKnowledgeSourceChangedError, StoryKnowledgeGenerationRestrictedError } from "./index.ts";

type VersionRow = QueryResultRow & { version_json: StoryKnowledgeVersion };
type BibleRow = QueryResultRow & { bible_json: StoryBible };
type ResultRow = QueryResultRow & { fingerprint: string; version_json: StoryKnowledgeVersion; bible_json?: StoryBible };

export class PostgresStoryKnowledgeRepository implements StoryKnowledgeRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }
  async findInitialExtraction(actor: Actor, projectId: string, chapterId: string, jobId: string): Promise<StoryKnowledgeVersion | null> {
    return this.inTransaction(actor, async client => {
      const result = await client.query<VersionRow>(`select version_json from story_knowledge_versions
        where workspace_id=$1 and project_id=$2 and chapter_id=$3 and extraction_job_id=$4 and parent_version_id is null limit 2`,
        [actor.workspaceId, projectId, chapterId, jobId]);
      if (result.rows.length > 1) throw new StoryKnowledgeError("VERSION_CONFLICT", "任务结果存在歧义");
      return cloneOrNull(result.rows[0]?.version_json);
    });
  }

  async saveCandidate(actor: Actor, version: StoryKnowledgeVersion, expectedActiveVersionId?: string | null, requireCurrentSource = false): Promise<StoryKnowledgeVersion> {
    return this.inTransaction(actor, async (client) => {
      await setOperation(client, "candidate");
      if (requireCurrentSource) {
        // SHARE conflicts with all chapter updates, including non-key active-source changes.
        // Keep this lock until candidate insertion and head CAS have committed.
        const source = await client.query<{ active_source_version_id: string | null } & QueryResultRow>(
          "select active_source_version_id from chapters where project_id=$1 and id=$2 for share",
          [version.projectId, version.chapterId],
        );
        if (!source.rows[0]) throw new StoryKnowledgeError("SOURCE_VERSION_NOT_FOUND", "章节不存在或无权访问");
        if (source.rows[0].active_source_version_id !== version.sourceVersionId) throw new StoryKnowledgeSourceChangedError();
        const policy = await client.query("select public.generation_allowed_locked($1,$2,$3,$4) as allowed",
          [actor.workspaceId,version.projectId,version.chapterId,version.sourceVersionId]);
        if (policy.rows[0]?.allowed !== true) throw new StoryKnowledgeGenerationRestrictedError();
      }
      await lockHead(client, actor, version.projectId, version.chapterId);
      if (expectedActiveVersionId !== undefined) await assertActive(client, actor, version.projectId, version.chapterId, expectedActiveVersionId);
      await insertVersion(client, actor, version);
      await setHead(client, actor, version.projectId, version.chapterId, version.id);
      return structuredClone(version);
    });
  }

  async findActive(actor: Actor, projectId: string, chapterId: string): Promise<StoryKnowledgeVersion | null> {
    return this.inTransaction(actor, async (client) => {
      const result = await client.query<VersionRow>(
        `select v.version_json from story_knowledge_heads h
         join story_knowledge_versions v on v.workspace_id = h.workspace_id and v.project_id = h.project_id
           and v.chapter_id = h.chapter_id and v.id = h.active_version_id
         where h.workspace_id = $1 and h.project_id = $2 and h.chapter_id = $3`,
        [actor.workspaceId, projectId, chapterId],
      );
      return cloneOrNull(result.rows[0]?.version_json);
    });
  }

  async findVersion(actor: Actor, projectId: string, chapterId: string, versionId: string): Promise<StoryKnowledgeVersion | null> {
    return this.inTransaction(actor, async (client) => {
      const result = await client.query<VersionRow>(
        `select version_json from story_knowledge_versions
         where workspace_id = $1 and project_id = $2 and chapter_id = $3 and id = $4`,
        [actor.workspaceId, projectId, chapterId, versionId],
      );
      return cloneOrNull(result.rows[0]?.version_json);
    });
  }

  async findRetryResult(actor: Actor, projectId: string, chapterId: string, idempotencyKey: string): Promise<{ fingerprint: string; version: StoryKnowledgeVersion } | null> {
    return this.inTransaction(actor, async (client) => {
      const result = await loadRetry(client, actor, projectId, chapterId, idempotencyKey);
      return result ? { fingerprint: result.fingerprint, version: structuredClone(result.version_json) } : null;
    });
  }

  async saveRetryCandidate(actor: Actor, version: StoryKnowledgeVersion, expectedActiveVersionId: string, idempotencyKey: string, fingerprint: string): Promise<StoryKnowledgeVersion> {
    return this.inTransaction(actor, async (client) => {
      await setOperation(client, "retry");
      await lockHead(client, actor, version.projectId, version.chapterId);
      const existing = await loadRetry(client, actor, version.projectId, version.chapterId, idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new StoryKnowledgeError("INVALID_RETRY", "相同重试任务返回了不同内容");
        return structuredClone(existing.version_json);
      }
      await assertActive(client, actor, version.projectId, version.chapterId, expectedActiveVersionId);
      await insertVersion(client, actor, version);
      await setHead(client, actor, version.projectId, version.chapterId, version.id);
      await client.query(
        `insert into story_knowledge_retry_results
         (workspace_id, project_id, chapter_id, idempotency_key, fingerprint, version_id)
         values ($1,$2,$3,$4,$5,$6)`,
        [actor.workspaceId, version.projectId, version.chapterId, idempotencyKey, fingerprint, version.id],
      );
      return structuredClone(version);
    });
  }

  async saveConfirmed(actor: Actor, version: StoryKnowledgeVersion, storyBible: StoryBible, expectedActiveVersionId: string, confirmation?: { candidateVersionId: string; fingerprint: string }): Promise<{ version: StoryKnowledgeVersion; storyBible: StoryBible }> {
    return this.inTransaction(actor, async (client) => {
      await setOperation(client, "confirm");
      await lockHead(client, actor, version.projectId, version.chapterId);
      if (confirmation) {
        const existing = await loadConfirmation(client, actor, version.projectId, version.chapterId, confirmation.candidateVersionId);
        if (existing) {
          if (existing.fingerprint !== confirmation.fingerprint) throw new StoryKnowledgeError("INVALID_CONFIRMATION", "同一候选版本收到了不同的确认命令");
          if (!existing.bible_json) throw new Error("Confirmation result is missing its story bible");
          return { version: structuredClone(existing.version_json), storyBible: structuredClone(existing.bible_json) };
        }
      }
      assertConfirmationAggregate(version, storyBible);
      await assertActive(client, actor, version.projectId, version.chapterId, expectedActiveVersionId);
      await insertVersion(client, actor, version);
      await client.query(
        `insert into story_bibles (id, workspace_id, project_id, chapter_id, version_id, bible_json)
         values ($1,$2,$3,$4,$5,$6::jsonb)`,
        [storyBible.id, actor.workspaceId, storyBible.projectId, storyBible.chapterId, storyBible.versionId, JSON.stringify(storyBible)],
      );
      await setHead(client, actor, version.projectId, version.chapterId, version.id, version.id);
      if (confirmation) await client.query(
        `insert into story_knowledge_confirmation_results
         (workspace_id, project_id, chapter_id, candidate_version_id, fingerprint, version_id)
         values ($1,$2,$3,$4,$5,$6)`,
        [actor.workspaceId, version.projectId, version.chapterId, confirmation.candidateVersionId, confirmation.fingerprint, version.id],
      );
      return { version: structuredClone(version), storyBible: structuredClone(storyBible) };
    });
  }

  async findConfirmedStoryBible(actor: Actor, projectId: string, chapterId: string): Promise<StoryBible | null> {
    return this.inTransaction(actor, async (client) => {
      const result = await client.query<BibleRow>(
        `select b.bible_json from story_knowledge_heads h
         join story_bibles b on b.workspace_id = h.workspace_id and b.project_id = h.project_id
           and b.chapter_id = h.chapter_id and b.version_id = h.confirmed_version_id
         where h.workspace_id = $1 and h.project_id = $2 and h.chapter_id = $3`,
        [actor.workspaceId, projectId, chapterId],
      );
      return cloneOrNull(result.rows[0]?.bible_json);
    });
  }

  async findConfirmationResult(actor: Actor, projectId: string, chapterId: string, candidateVersionId: string): Promise<{ fingerprint: string; version: StoryKnowledgeVersion; storyBible: StoryBible } | null> {
    return this.inTransaction(actor, async (client) => {
      const result = await loadConfirmation(client, actor, projectId, chapterId, candidateVersionId);
      return result?.bible_json ? {
        fingerprint: result.fingerprint,
        version: structuredClone(result.version_json),
        storyBible: structuredClone(result.bible_json),
      } : null;
    });
  }

  private async inTransaction<T>(actor: Actor, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("set local statement_timeout = '5s'");
      await client.query("select set_config('app.current_user_id', $1, true)", [actor.userId]);
      await client.query("select set_config('app.current_workspace_id', $1, true)", [actor.workspaceId]);
      const result = await operation(client);
      await client.query("commit");
      return result;
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // Preserve the operation error if rollback also fails on a broken connection.
      }
      throw mapDatabaseError(error);
    } finally {
      client.release();
    }
  }
}

async function setOperation(client: PoolClient, operation: "candidate" | "retry" | "confirm"): Promise<void> {
  await client.query("select set_config('app.story_knowledge_operation', $1, true)", [operation]);
}

async function lockHead(client: PoolClient, actor: Actor, projectId: string, chapterId: string): Promise<void> {
  await client.query(
    `insert into story_knowledge_heads (workspace_id, project_id, chapter_id)
     values ($1,$2,$3) on conflict (workspace_id, project_id, chapter_id) do nothing`,
    [actor.workspaceId, projectId, chapterId],
  );
  await client.query(
    `select active_version_id from story_knowledge_heads
     where workspace_id = $1 and project_id = $2 and chapter_id = $3 for update`,
    [actor.workspaceId, projectId, chapterId],
  );
}

async function assertActive(client: PoolClient, actor: Actor, projectId: string, chapterId: string, expected: string | null): Promise<void> {
  const result = await client.query<{ active_version_id: string | null } & QueryResultRow>(
    `select active_version_id from story_knowledge_heads
     where workspace_id = $1 and project_id = $2 and chapter_id = $3`,
    [actor.workspaceId, projectId, chapterId],
  );
  if ((result.rows[0]?.active_version_id ?? null) !== expected) {
    throw new StoryKnowledgeError("VERSION_CONFLICT", "故事知识已被其他操作更新，请刷新后重试");
  }
}

async function setHead(client: PoolClient, actor: Actor, projectId: string, chapterId: string, activeVersionId: string, confirmedVersionId?: string): Promise<void> {
  await client.query(
    `update story_knowledge_heads set active_version_id = $1,
       confirmed_version_id = coalesce($2, confirmed_version_id)
     where workspace_id = $3 and project_id = $4 and chapter_id = $5`,
    [activeVersionId, confirmedVersionId ?? null, actor.workspaceId, projectId, chapterId],
  );
}

async function insertVersion(client: PoolClient, actor: Actor, version: StoryKnowledgeVersion): Promise<void> {
  await client.query(
    `insert into story_knowledge_versions
     (id, workspace_id, project_id, chapter_id, parent_version_id, source_version_id, extraction_job_id,
      created_at, created_by, extraction_status, status, version_json)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
    [version.id, actor.workspaceId, version.projectId, version.chapterId, version.parentVersionId,
      version.sourceVersionId, version.extractionJobId, version.createdAt, version.createdBy,
      version.extractionStatus, version.status, JSON.stringify(version)],
  );
}

async function loadRetry(client: PoolClient, actor: Actor, projectId: string, chapterId: string, idempotencyKey: string): Promise<ResultRow | undefined> {
  const result = await client.query<ResultRow>(
    `select r.fingerprint, v.version_json from story_knowledge_retry_results r
     join story_knowledge_versions v on v.workspace_id = r.workspace_id and v.project_id = r.project_id
       and v.chapter_id = r.chapter_id and v.id = r.version_id
     where r.workspace_id = $1 and r.project_id = $2 and r.chapter_id = $3 and r.idempotency_key = $4`,
    [actor.workspaceId, projectId, chapterId, idempotencyKey],
  );
  return result.rows[0];
}

async function loadConfirmation(client: PoolClient, actor: Actor, projectId: string, chapterId: string, candidateVersionId: string): Promise<ResultRow | undefined> {
  const result = await client.query<ResultRow>(
    `select r.fingerprint, v.version_json, b.bible_json from story_knowledge_confirmation_results r
     join story_knowledge_versions v on v.workspace_id = r.workspace_id and v.project_id = r.project_id
       and v.chapter_id = r.chapter_id and v.id = r.version_id
     join story_bibles b on b.workspace_id = r.workspace_id and b.project_id = r.project_id
       and b.chapter_id = r.chapter_id and b.version_id = r.version_id
     where r.workspace_id = $1 and r.project_id = $2 and r.chapter_id = $3 and r.candidate_version_id = $4`,
    [actor.workspaceId, projectId, chapterId, candidateVersionId],
  );
  return result.rows[0];
}

function cloneOrNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : structuredClone(value);
}

function assertConfirmationAggregate(version: StoryKnowledgeVersion, storyBible: StoryBible): void {
  const acceptedFacts = version.facts.filter(({ decision }) => decision?.outcome === "accepted");
  if (version.status !== "confirmed"
    || storyBible.versionId !== version.id
    || storyBible.projectId !== version.projectId
    || storyBible.chapterId !== version.chapterId
    || storyBible.confirmedBy !== version.confirmedBy
    || storyBible.confirmedAt !== version.confirmedAt
    || !isDeepStrictEqual(storyBible.facts, acceptedFacts)) {
    throw new StoryKnowledgeError("INVALID_CONFIRMATION", "故事圣经与确认版本不一致");
  }
}

function mapDatabaseError(error: unknown): unknown {
  if (error instanceof StoryKnowledgeError) return error;
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
  if (code === "23505") return new StoryKnowledgeError("VERSION_CONFLICT", "故事知识版本或幂等记录已存在");
  const constraint = typeof error === "object" && error !== null && "constraint" in error
    ? String((error as { constraint?: unknown }).constraint)
    : undefined;
  if (code === "23503" && constraint === "story_knowledge_versions_source_version_fkey") {
    return new StoryKnowledgeError("SOURCE_VERSION_NOT_FOUND", "原文版本不存在或不属于当前章节");
  }
  if (code === "23503" && (constraint?.startsWith("story_bibles_")
    || constraint?.startsWith("story_knowledge_confirmation_results_"))) {
    return new StoryKnowledgeError("INVALID_CONFIRMATION", "故事圣经或确认记录引用了无效版本");
  }
  if (code === "23503" && constraint === "story_knowledge_versions_parent_version_fkey") {
    return new StoryKnowledgeError("VERSION_CONFLICT", "故事知识父版本已失效");
  }
  if (code === "23503") return new StoryKnowledgeError("STAGE_RESULT_NOT_FOUND", "故事知识所属项目或章节不存在");
  if (code === "42501") return new StoryKnowledgeError("FORBIDDEN", "当前项目角色无权执行此故事知识操作");
  return error;
}
