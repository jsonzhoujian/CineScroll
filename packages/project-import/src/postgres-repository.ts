import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  Actor,
  Chapter,
  ChapterHead,
  Project,
  ProjectAccess,
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

  async findProjectAccess(actor: Actor, projectId: string): Promise<ProjectAccess | null> {
    return this.inTransaction(actor, async (client) => {
      const result = await client.query<MemberRow>(
        `select user_id, role from project_members
         where project_id = $1 and workspace_id = $2 and user_id = $3`,
        [projectId, actor.workspaceId, actor.userId],
      );
      return result.rows[0] ? { role: result.rows[0].role } : null;
    });
  }

  async findChapter(actor: Actor, projectId: string, chapterId: string): Promise<Chapter | null> {
    return this.inTransaction(actor, async (client) => {
      const result = await client.query<ChapterRow>(
        "select id, title, active_source_version_id from chapters where project_id = $1 and id = $2",
        [projectId, chapterId],
      );
      return result.rows[0] ? loadChapter(client, projectId, result.rows[0]) : null;
    });
  }

  async createChapter(actor: Actor, projectId: string, chapter: Chapter): Promise<Chapter> {
    return this.inTransaction(actor, async (client) => {
      const project = await client.query("select id from projects where id = $1 for key share", [projectId]);
      if (project.rowCount === 0) throw new ProjectImportError("PROJECT_NOT_FOUND", "项目不存在或无权访问");
      await insertChapter(client, projectId, chapter, new Set());
      return structuredClone(chapter);
    });
  }

  async appendSourceVersion(
    actor: Actor,
    projectId: string,
    chapterId: string,
    mutation: (latestVersion: SourceVersion) => { title: string; sourceVersion: SourceVersion },
  ): Promise<{ chapter: ChapterHead; previousVersion: SourceVersion; sourceVersion: SourceVersion }> {
    return this.inTransaction(actor, async (client) => {
      const chapterResult = await client.query<ChapterRow>(
        `select id, title, active_source_version_id from chapters
         where project_id = $1 and id = $2 for update`,
        [projectId, chapterId],
      );
      const chapter = chapterResult.rows[0];
      if (!chapter) throw new ProjectImportError("CHAPTER_NOT_FOUND", "章节不存在或无权访问");
      const versionResult = await client.query<SourceVersionRow>(
        "select * from source_versions where project_id = $1 and chapter_id = $2 and id = $3",
        [projectId, chapterId, chapter.active_source_version_id],
      );
      const latestRow = versionResult.rows[0];
      if (!latestRow) throw new ProjectImportError("CHAPTER_NOT_FOUND", "章节活动版本不存在");
      const previousVersion = await loadSourceVersion(client, latestRow);
      const change = mutation(structuredClone(previousVersion));
      if (change.sourceVersion.ordinal !== previousVersion.ordinal + 1) {
        throw new Error("Source version ordinal must increment by one");
      }
      const knownFragmentIds = new Set(previousVersion.fragments.map(({ id }) => id));
      await insertSourceVersion(client, projectId, chapterId, change.sourceVersion, knownFragmentIds);
      await client.query(
        "update chapters set title = $1, active_source_version_id = $2 where project_id = $3 and id = $4",
        [change.title, change.sourceVersion.id, projectId, chapterId],
      );
      return {
        chapter: {
          id: chapterId,
          title: change.title,
          activeSourceVersionId: change.sourceVersion.id,
        },
        previousVersion,
        sourceVersion: structuredClone(change.sourceVersion),
      };
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
    const existing = await client.query("select 1 from source_fragments where id = $1", [fragment.id]);
    if (existing.rowCount === 0) {
      await client.query(
        "insert into source_fragments (id, project_id, chapter_id, text_content, content_hash) values ($1,$2,$3,$4,$5)",
        [fragment.id, projectId, chapterId, fragment.text, fragment.contentHash],
      );
    }
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
  const chapters: Chapter[] = [];
  for (const chapter of chapterRows.rows) chapters.push(await loadChapter(client, projectId, chapter));
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
  const loadedVersions: SourceVersion[] = [];
  for (const version of versions.rows) loadedVersions.push(await loadSourceVersion(client, version));
  return {
    id: chapter.id,
    title: chapter.title,
    activeSourceVersionId: chapter.active_source_version_id,
    versions: loadedVersions,
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
