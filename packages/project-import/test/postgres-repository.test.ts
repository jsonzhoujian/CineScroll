import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Pool, type PoolClient, type QueryResultRow } from "pg";

import { ProjectImportService } from "../src/index.ts";
import { PostgresProjectImportRepository } from "../src/postgres-repository.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const actor = { userId: "usr_pg-owner", workspaceId: "wsp_pg-studio" } as const;

integrationTest("PostgreSQL 持久化版本历史、事务回滚并执行租户隔离", async () => {
  const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
  let pool: Pool | undefined;
  try {
    const migration = await readFile(new URL("../migrations/0001_project_import.sql", import.meta.url), "utf8");
    await adminPool.query(migration);
    await adminPool.query("truncate table projects cascade");
    await adminPool.query("drop role if exists novel_app_test");
    await adminPool.query("create role novel_app_test login password 'test-only-password' in role novel_app");
    const applicationUrl = new URL(databaseUrl!);
    applicationUrl.username = "novel_app_test";
    applicationUrl.password = "test-only-password";
    pool = new Pool({ connectionString: applicationUrl.toString(), max: 4 });
    const repository = new PostgresProjectImportRepository(pool);
    const service = createService(repository);
    const project = await service.createProject(actor, {
      title: "数据库项目",
      rightsDeclared: true,
      aspectRatio: "16:9",
      targetDurationSeconds: 300,
      narrativeMode: "dialogue",
    });
    const imported = await service.importText(actor, project.id, {
      fileName: "第一章.txt",
      text: "第1章 初见\n第一段。\n\n第二段。",
      selectedChapterIndex: 0,
    });

    const restartedService = createService(new PostgresProjectImportRepository(pool));
    const persisted = await restartedService.getChapter(actor, project.id, imported.chapter.id);
    assert.deepEqual(persisted.versions.map(({ ordinal }) => ordinal), [1]);
    assert.equal(persisted.versions[0]!.text, "第一段。\n\n第二段。");

    await assert.rejects(
      () => repository.transactProject(actor, project.id, (draft) => {
        draft.title = "不应提交";
        throw new Error("rollback");
      }),
      /rollback/,
    );
    const afterRollback = await repository.findProject(actor, project.id);
    assert.equal(afterRollback!.title, "数据库项目");

    await adminPool.query(
      "insert into project_members (project_id, workspace_id, user_id, role) values ($1,$2,$3,'reviewer')",
      [project.id, actor.workspaceId, "usr_pg-reviewer"],
    );
    await adminPool.query(
      "insert into project_members (project_id, workspace_id, user_id, role) values ($1,$2,$3,'editor')",
      [project.id, actor.workspaceId, "usr_pg-editor"],
    );
    const reviewer = { userId: "usr_pg-reviewer", workspaceId: actor.workspaceId };
    const reviewerService = createService(new PostgresProjectImportRepository(pool));
    assert.equal((await reviewerService.getChapter(reviewer, project.id, imported.chapter.id)).id, imported.chapter.id);
    await assert.rejects(
      () => reviewerService.reimportText(reviewer, project.id, imported.chapter.id, {
        fileName: "reviewer.txt", text: "审核人不能修改", selectedChapterIndex: 0,
      }),
      { code: "PROJECT_WRITE_FORBIDDEN" },
    );

    const outsider = { userId: "usr_pg-other", workspaceId: "wsp_pg-other" };
    assert.equal(await repository.findProject(outsider, project.id), null);
    await assert.rejects(
      () => restartedService.getChapter(outsider, project.id, imported.chapter.id),
      { code: "PROJECT_NOT_FOUND" },
    );
    const hiddenCounts = await withActor(pool, outsider, async (client) => {
      const tables = ["chapters", "source_versions", "source_fragments", "source_version_fragments"] as const;
      const counts: number[] = [];
      for (const table of tables) {
        const result = await client.query<{ count: string } & QueryResultRow>(`select count(*) from ${table}`);
        counts.push(Number(result.rows[0]!.count));
      }
      return counts;
    });
    assert.deepEqual(hiddenCounts, [0, 0, 0, 0]);

    await assert.rejects(
      () => withActor(pool!, outsider, (client) => client.query(
        "insert into project_members (project_id, workspace_id, user_id, role) values ($1,$2,$3,'owner')",
        [project.id, outsider.workspaceId, outsider.userId],
      )),
      /row-level security|foreign key/,
    );

    const reviewerUpdate = await withActor(pool, reviewer, (client) => client.query(
      "update chapters set title = '越权修改' where id = $1",
      [imported.chapter.id],
    ));
    assert.equal(reviewerUpdate.rowCount, 0);

    const editor = { userId: "usr_pg-editor", workspaceId: actor.workspaceId };
    const editorUpdate = await withActor(pool, editor, (client) => client.query(
      "update chapters set title = '编辑可修改' where id = $1",
      [imported.chapter.id],
    ));
    assert.equal(editorUpdate.rowCount, 1);
    await assert.rejects(
      () => withActor(pool!, editor, (client) => client.query(
        "insert into project_members (project_id, workspace_id, user_id, role) values ($1,$2,$3,'reviewer')",
        [project.id, editor.workspaceId, "usr_editor-added"],
      )),
      /row-level security/,
    );

    await withActor(pool, actor, (client) => client.query(
      "insert into project_members (project_id, workspace_id, user_id, role) values ($1,$2,$3,'reviewer')",
      [project.id, actor.workspaceId, "usr_owner-added"],
    ));

    await assert.rejects(
      () => withActor(pool!, actor, (client) => client.query("delete from source_versions where id = $1", [imported.sourceVersion.id])),
      /permission denied|immutable source records/,
    );
  } finally {
    await pool?.end();
    await adminPool.end();
  }
});

function createService(repository: PostgresProjectImportRepository) {
  let sequence = 0;
  return new ProjectImportService({
    repository,
    idGenerator: (prefix) => `${prefix}_pg-${++sequence}`,
    clock: () => new Date("2026-09-22T08:00:00.000Z"),
  });
}

async function withActor<T>(pool: Pool, requestActor: typeof actor | { userId: string; workspaceId: string }, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.current_user_id', $1, true)", [requestActor.userId]);
    await client.query("select set_config('app.current_workspace_id', $1, true)", [requestActor.workspaceId]);
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
