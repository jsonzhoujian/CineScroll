import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  Actor,
  Chapter,
  Project,
  ProjectImportRepository,
  SourceFragment,
  SourceVersion,
} from "./index.ts";
import { ProjectImportError } from "./index.ts";

export class PostgresProjectImportRepository implements ProjectImportRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async saveProject(actor: Actor, project: Project): Promise<Project> {
    return this.inTransaction(actor, async (client) => {
      await insertProject(client, project);
      return structuredClone(project);
    });
  }

  async findProject(actor: Actor, projectId: string): Promise<Project | null> {
    return this.inTransaction(actor, (client) => loadProject(client, projectId, false));
  }

  async transactProject<T>(
    actor: Actor,
    projectId: string,
    operation: (project: Project) => T,
  ): Promise<T> {
    return this.inTransaction(actor, async (client) => {
      const project = await loadProject(client, projectId, true);
      if (!project) throw new ProjectImportError("PROJECT_NOT_FOUND", "项目不存在或无权访问");
      const before = structuredClone(project);
      const result = operation(project);
      await persistProjectChanges(client, before, project);
      return result;
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
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function insertProject(client: PoolClient, project: Project): Promise<void> {
  await client.query(
    `insert into projects (
       id, workspace_id, owner_user_id, title, aspect_ratio,
       target_duration_seconds, narrative_mode, data_region, created_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [project.id, project.workspaceId, project.ownerUserId, project.title, project.aspectRatio,
      project.targetDurationSeconds, project.narrativeMode, project.dataRegion, project.createdAt],
  );
  for (const member of project.members) {
    await client.query(
      "insert into project_members (project_id, workspace_id, user_id, role) values ($1,$2,$3,$4)",
      [project.id, project.workspaceId, member.userId, member.role],
    );
  }
  for (const chapter of project.chapters) await insertChapter(client, project.id, chapter, new Set());
}

async function persistProjectChanges(client: PoolClient, before: Project, after: Project): Promise<void> {
  if (before.title !== after.title) {
    await client.query("update projects set title = $1 where id = $2", [after.title, after.id]);
  }
  const previousMemberIds = new Set(before.members.map(({ userId }) => userId));
  for (const member of after.members.filter(({ userId }) => !previousMemberIds.has(userId))) {
    await client.query(
      "insert into project_members (project_id, workspace_id, user_id, role) values ($1,$2,$3,$4)",
      [after.id, after.workspaceId, member.userId, member.role],
    );
  }
  const previousChapters = new Map(before.chapters.map((chapter) => [chapter.id, chapter]));
  const knownFragmentIds = new Set(before.chapters.flatMap((chapter) =>
    chapter.versions.flatMap((version) => version.fragments.map(({ id }) => id))));
  for (const chapter of after.chapters) {
    const previous = previousChapters.get(chapter.id);
    if (!previous) {
      await insertChapter(client, after.id, chapter, knownFragmentIds);
      continue;
    }
    const previousVersionIds = new Set(previous.versions.map(({ id }) => id));
    for (const version of chapter.versions.filter(({ id }) => !previousVersionIds.has(id))) {
      await insertSourceVersion(client, after.id, chapter.id, version, knownFragmentIds);
    }
    if (previous.title !== chapter.title || previous.activeSourceVersionId !== chapter.activeSourceVersionId) {
      await client.query(
        "update chapters set title = $1, active_source_version_id = $2 where id = $3",
        [chapter.title, chapter.activeSourceVersionId, chapter.id],
      );
    }
  }
}

async function insertChapter(
  client: PoolClient,
  projectId: string,
  chapter: Chapter,
  knownFragmentIds: Set<string>,
): Promise<void> {
  await client.query(
    "insert into chapters (id, project_id, title, active_source_version_id) values ($1,$2,$3,null)",
    [chapter.id, projectId, chapter.title],
  );
  for (const version of chapter.versions) {
    await insertSourceVersion(client, projectId, chapter.id, version, knownFragmentIds);
  }
  await client.query(
    "update chapters set active_source_version_id = $1 where id = $2",
    [chapter.activeSourceVersionId, chapter.id],
  );
}

async function insertSourceVersion(
  client: PoolClient,
  projectId: string,
  chapterId: string,
  version: SourceVersion,
  knownFragmentIds: Set<string>,
): Promise<void> {
  await client.query(
    `insert into source_versions
     (id, project_id, chapter_id, ordinal, created_at, created_by, character_count, source_text)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [version.id, projectId, chapterId, version.ordinal, version.createdAt, version.createdBy,
      version.characterCount, version.text],
  );
  for (const fragment of version.fragments) {
    await insertFragment(client, projectId, chapterId, version.id, fragment, knownFragmentIds);
  }
}

async function insertFragment(
  client: PoolClient,
  projectId: string,
  chapterId: string,
  sourceVersionId: string,
  fragment: SourceFragment,
  knownFragmentIds: Set<string>,
): Promise<void> {
  if (!knownFragmentIds.has(fragment.id)) {
    await client.query(
      "insert into source_fragments (id, project_id, chapter_id, text_content, content_hash) values ($1,$2,$3,$4,$5)",
      [fragment.id, projectId, chapterId, fragment.text, fragment.contentHash],
    );
    knownFragmentIds.add(fragment.id);
  }
  await client.query(
    `insert into source_version_fragments
     (source_version_id, fragment_id, project_id, chapter_id, ordinal, start_offset, end_offset)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [sourceVersionId, fragment.id, projectId, chapterId, fragment.ordinal, fragment.startOffset, fragment.endOffset],
  );
}

async function loadProject(client: PoolClient, projectId: string, lock: boolean): Promise<Project | null> {
  const projectResult = await client.query<ProjectRow>(
    `select * from projects where id = $1${lock ? " for update" : ""}`,
    [projectId],
  );
  const row = projectResult.rows[0];
  if (!row) return null;
  const members = await client.query<MemberRow>(
    "select user_id, role from project_members where project_id = $1 order by user_id",
    [projectId],
  );
  const chapterRows = await client.query<ChapterRow>(
    "select id, title, active_source_version_id from chapters where project_id = $1 order by id",
    [projectId],
  );
  const chapters = await Promise.all(chapterRows.rows.map((chapter) => loadChapter(client, projectId, chapter)));
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ownerUserId: row.owner_user_id,
    title: row.title,
    aspectRatio: row.aspect_ratio,
    targetDurationSeconds: row.target_duration_seconds,
    narrativeMode: row.narrative_mode,
    dataRegion: row.data_region,
    createdAt: row.created_at.toISOString(),
    members: members.rows.map((member) => ({ userId: member.user_id, role: member.role })),
    chapters,
  };
}

async function loadChapter(client: PoolClient, projectId: string, chapter: ChapterRow): Promise<Chapter> {
  const versions = await client.query<SourceVersionRow>(
    `select * from source_versions where project_id = $1 and chapter_id = $2 order by ordinal`,
    [projectId, chapter.id],
  );
  return {
    id: chapter.id,
    title: chapter.title,
    activeSourceVersionId: chapter.active_source_version_id,
    versions: await Promise.all(versions.rows.map((version) => loadSourceVersion(client, version))),
  };
}

async function loadSourceVersion(client: PoolClient, version: SourceVersionRow): Promise<SourceVersion> {
  const fragments = await client.query<FragmentRow>(
    `select f.id, vf.ordinal, vf.start_offset, vf.end_offset, f.text_content, f.content_hash
     from source_version_fragments vf
     join source_fragments f on f.id = vf.fragment_id
     where vf.source_version_id = $1 order by vf.ordinal`,
    [version.id],
  );
  return {
    id: version.id,
    ordinal: version.ordinal,
    createdAt: version.created_at.toISOString(),
    createdBy: version.created_by,
    characterCount: version.character_count,
    text: version.source_text,
    fragments: fragments.rows.map((fragment) => ({
      id: fragment.id,
      ordinal: fragment.ordinal,
      startOffset: fragment.start_offset,
      endOffset: fragment.end_offset,
      text: fragment.text_content,
      contentHash: fragment.content_hash,
    })),
  };
}

interface ProjectRow extends QueryResultRow {
  id: string; workspace_id: string; owner_user_id: string; title: string;
  aspect_ratio: Project["aspectRatio"]; target_duration_seconds: Project["targetDurationSeconds"];
  narrative_mode: Project["narrativeMode"]; data_region: "CN"; created_at: Date;
}
interface MemberRow extends QueryResultRow { user_id: string; role: Project["members"][number]["role"] }
interface ChapterRow extends QueryResultRow { id: string; title: string; active_source_version_id: string }
interface SourceVersionRow extends QueryResultRow {
  id: string; ordinal: number; created_at: Date; created_by: string;
  character_count: number; source_text: string;
}
interface FragmentRow extends QueryResultRow {
  id: string; ordinal: number; start_offset: number; end_offset: number;
  text_content: string; content_hash: string;
}
