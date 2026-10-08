import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { assertEvidenceSourceDatabase } from "../src/evidence-source-database-readiness.ts";

test("D1a draft and catalog gate agree in a fresh socket-only PostgreSQL16 instance", {
  skip: !process.env.TEST_SOURCE_D1A_DATABASE_URL,
}, async t => {
  const url = new URL(process.env.TEST_SOURCE_D1A_DATABASE_URL!);
  const socket = url.searchParams.get("host");
  assert.match(socket ?? "", /^\/private\/tmp\/source-d1a\.[A-Za-z0-9]{6}$/);
  assert.equal(url.pathname, "/postgres");
  assert.equal(url.password, "");
  const admin = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 2000 });
  const suffix = randomUUID().replaceAll("-", "");
  const database = `source_${suffix}`, login = `source_login_${suffix}`, extra = `source_extra_${suffix}`;
  let databaseCreated = false, draftCreated = false, loginCreated = false, extraCreated = false;
  let setup: Pool | undefined, restricted: Pool | undefined;
  try {
    const directory = (await admin.query("show data_directory")).rows[0].data_directory;
    assert.equal(directory, `${socket}/data`);
    assert.equal((await admin.query("show listen_addresses")).rows[0].listen_addresses, "");
    assert.equal((await admin.query("select count(*)::int as count from pg_roles where rolname in ('novel_source_draft_owner','novel_source_inspector')")).rows[0].count, 0);
    await admin.query(`create database ${database} encoding 'UTF8' template template0`); databaseCreated = true;
    url.pathname = `/${database}`;
    setup = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 2000 });
    const draft = await readFile(new URL("../../../docs/sql-drafts/evidence-source-d1a.sql", import.meta.url), "utf8");
    await setup.query(draft); draftCreated = true;
    await admin.query(`create role ${login} login nosuperuser nocreatedb nocreaterole nobypassrls noreplication`); loginCreated = true;
    await admin.query(`grant novel_source_inspector to ${login}`);
    await admin.query(`create role ${extra} nologin`); extraCreated = true;
    url.username = login;
    restricted = new Pool({ connectionString: url.toString(), options: "-c role=novel_source_inspector", max: 1, connectionTimeoutMillis: 2000 });
    const trace: { stage: string; ready?: unknown; code?: string }[] = [];
    const checkedPool = { connect: async () => {
      const client = await restricted!.connect();
      return { release: client.release.bind(client), query: async (sql: string, values?: unknown[]) => {
        const stage = /source-d1a:([a-z]+)/.exec(sql)?.[1] ?? "transaction";
        try {
          const result = await client.query(sql, values); if (stage !== "transaction") trace.push({ stage, ready: result.rows[0]?.ready });
          return result;
        } catch (error) { trace.push({ stage, code: (error as { code?: string }).code ?? "UNKNOWN" }); throw error; }
      } };
    } };
    try { assert.equal(await assertEvidenceSourceDatabase(checkedPool), undefined); }
    catch {
      const constraints = (await setup.query("select conname,contype,connoinherit,pg_get_constraintdef(oid) as definition from pg_constraint where connamespace='evidence_source_draft'::regnamespace order by conname")).rows;
      assert.fail(`draft catalog diagnosis: ${JSON.stringify({ trace, constraints })}`);
    }
    await t.test("administrative identity cannot pass as the restricted inspector", async () => {
      await assert.rejects(assertEvidenceSourceDatabase(setup!), { message: "EVIDENCE_SOURCE_DATABASE_NOT_READY" });
    });
    const denyFunction = draft.match(/create function evidence_source_draft\.deny_source_write\(\)[\s\S]*?\$body\$;/)![0].replace("create function", "create or replace function");
    const versionCheck = "CHECK (evidence_source_draft.valid_version(kind, record_id, version, revision, predecessor_version, introduced_generation, payload, canonical, fingerprint, producer_service_id, rule_version))";
    const previousFk = "FOREIGN KEY (workspace_id, collection_id, kind, record_id, predecessor_version) REFERENCES evidence_source_draft.version(workspace_id, collection_id, kind, record_id, version)";
    const cases: [string, string, string][] = [
      ["BYPASSRLS login", `alter role ${login} bypassrls`, `alter role ${login} nobypassrls`],
      ["unexpected inherited role", `grant ${extra} to ${login}`, `revoke ${extra} from ${login}`],
      ["owner role reachable by login", `grant novel_source_draft_owner to ${login}`, `revoke novel_source_draft_owner from ${login}`],
      ["login-capable inspector", "alter role novel_source_inspector login", "alter role novel_source_inspector nologin"],
      ["database create permission", `grant create on database ${database} to ${login}`, `revoke create on database ${database} from ${login}`],
      ["source schema create permission", `grant create on schema evidence_source_draft to ${login}`, `revoke create on schema evidence_source_draft from ${login}`],
      ["missing collection", "alter table evidence_source_draft.collection rename to drift_collection", "alter table evidence_source_draft.drift_collection rename to collection"],
      ["FORCE RLS removed", "alter table evidence_source_draft.collection no force row level security", "alter table evidence_source_draft.collection force row level security"],
      ["permissive RLS policy", "create policy drift_policy on evidence_source_draft.collection using(true)", "drop policy drift_policy on evidence_source_draft.collection"],
      ["table SELECT granted", "grant select on evidence_source_draft.collection to novel_source_inspector", "revoke select on evidence_source_draft.collection from novel_source_inspector"],
      ["column write granted to login", `grant update(binding) on evidence_source_draft.collection to ${login}`, `revoke update(binding) on evidence_source_draft.collection from ${login}`],
      ["unexpected source object", "create table evidence_source_draft.drift_object()", "drop table evidence_source_draft.drift_object"],
      ["unexpected column", "alter table evidence_source_draft.collection add column drift text", "alter table evidence_source_draft.collection drop column drift"],
      ["missing primary index", "alter index evidence_source_draft.collection_pkey rename to drift_pkey", "alter index evidence_source_draft.drift_pkey rename to collection_pkey"],
      ["missing enumeration index", "drop index evidence_source_draft.version_enumeration", "create index version_enumeration on evidence_source_draft.version(workspace_id,collection_id,introduced_generation,kind,record_id,revision)"],
      ["wrong enumeration collation", "drop index evidence_source_draft.version_enumeration; create index version_enumeration on evidence_source_draft.version(workspace_id collate \"default\",collection_id,introduced_generation,kind,record_id,revision)", "drop index evidence_source_draft.version_enumeration; create index version_enumeration on evidence_source_draft.version(workspace_id,collection_id,introduced_generation,kind,record_id,revision)"],
      ["weakened CHECK", "alter table evidence_source_draft.version drop constraint version_shape; alter table evidence_source_draft.version add constraint version_shape check(true)", `alter table evidence_source_draft.version drop constraint version_shape; alter table evidence_source_draft.version add constraint version_shape ${versionCheck}`],
      ["changed CHECK inheritance", `alter table evidence_source_draft.version drop constraint version_shape; alter table evidence_source_draft.version add constraint version_shape ${versionCheck} no inherit`, `alter table evidence_source_draft.version drop constraint version_shape; alter table evidence_source_draft.version add constraint version_shape ${versionCheck}`],
      ["missing version FK", "alter table evidence_source_draft.version drop constraint version_previous", `alter table evidence_source_draft.version add constraint version_previous ${previousFk}`],
      ["deferred FK", "alter table evidence_source_draft.version alter constraint version_previous deferrable initially deferred", "alter table evidence_source_draft.version alter constraint version_previous not deferrable initially immediate"],
      ["row guard disabled", "alter table evidence_source_draft.collection disable trigger source_closed_row", "alter table evidence_source_draft.collection enable always trigger source_closed_row"],
      ["truncate guard disabled", "alter table evidence_source_draft.collection disable trigger source_closed_truncate", "alter table evidence_source_draft.collection enable always trigger source_closed_truncate"],
      ["row guard no longer ALWAYS", "alter table evidence_source_draft.collection enable trigger source_closed_row", "alter table evidence_source_draft.collection enable always trigger source_closed_row"],
      ["guard body changed", "create or replace function evidence_source_draft.deny_source_write() returns trigger language plpgsql set search_path=pg_catalog as $$begin return new; end$$", denyFunction],
      ["unsafe function search_path", "alter function evidence_source_draft.deny_source_write() set search_path=public", "alter function evidence_source_draft.deny_source_write() set search_path=pg_catalog"],
      ["SECURITY DEFINER enabled", "alter function evidence_source_draft.deny_source_write() security definer", "alter function evidence_source_draft.deny_source_write() security invoker"],
      ["PUBLIC function execution", "grant execute on function evidence_source_draft.valid_id(text) to public", "revoke execute on function evidence_source_draft.valid_id(text) from public"],
      ["extra executable function", "create function evidence_source_draft.drift_function() returns integer language sql as $$select 1$$", "drop function evidence_source_draft.drift_function()"],
    ];
    for (const [name, change, restore] of cases) {
      await t.test(`rejects ${name} without repair`, async () => {
        await setup!.query(change);
        try {
          await assert.rejects(assertEvidenceSourceDatabase(restricted!), { message: "EVIDENCE_SOURCE_DATABASE_NOT_READY" });
          // Repeat while the drift remains: the first rejection did not silently repair it.
          await assert.rejects(assertEvidenceSourceDatabase(restricted!), { message: "EVIDENCE_SOURCE_DATABASE_NOT_READY" });
        } finally { await setup!.query(restore); }
        await assertEvidenceSourceDatabase(restricted!);
      });
    }
    await t.test("restricted inspector cannot read, write, truncate or execute source functions", async () => {
      for (const sql of ["select * from evidence_source_draft.collection limit 0", "insert into evidence_source_draft.collection default values",
        "update evidence_source_draft.collection set head_revision=head_revision", "delete from evidence_source_draft.collection",
        "truncate evidence_source_draft.collection", "select evidence_source_draft.valid_id('safe')"]) {
        await assert.rejects(restricted!.query(sql), { code: "42501" });
      }
      await assertEvidenceSourceDatabase(restricted!);
    });
    await t.test("closed guards reject INSERT and TRUNCATE even through the temporary administrator", async () => {
      await assert.rejects(setup!.query("insert into evidence_source_draft.collection default values"), { code: "P0001" });
      await assert.rejects(setup!.query("truncate evidence_source_draft.collection,evidence_source_draft.version,evidence_source_draft.seal,evidence_source_draft.seal_member"), { code: "P0001" });
    });
    await t.test("SQL ID structural checks reject boundary whitespace without pretending to validate full v2 Unicode length", async () => {
      for (const id of ["\tname", "name\t", "\u00a0name", "name\u3000", "\ufeffname", "name\n", "*", "https://example.invalid"]) {
        assert.equal((await setup!.query("select evidence_source_draft.valid_id($1) as valid", [id])).rows[0].valid, false);
      }
      assert.equal((await setup!.query("select evidence_source_draft.valid_id($1) as valid", ["角色"])).rows[0].valid, true);
      const nonBmp = "😀".repeat(200);
      assert.equal(nonBmp.length, 400);
      assert.equal((await setup!.query("select evidence_source_draft.valid_id($1) as valid", [nonBmp])).rows[0].valid, true);
      // SQL's coarse character limit is intentionally not the v2 UTF16 boundary; D1b must also validate the protocol.
    });
  } finally {
    const failures: string[] = [];
    const cleanup = async (stage: string, action: () => Promise<unknown>) => {
      try { await action(); } catch { failures.push(stage); }
    };
    if (restricted) await cleanup("restricted-pool", () => restricted!.end());
    if (setup) {
      await setup.query("rollback").catch(() => {});
      await cleanup("setup-pool", () => setup!.end());
    }
    if (databaseCreated) await cleanup("test-database", () => admin.query(`drop database ${database}`));
    if (loginCreated) await cleanup("test-login", () => admin.query(`drop role ${login}`));
    if (extraCreated) await cleanup("test-extra-role", () => admin.query(`drop role ${extra}`));
    if (draftCreated) {
      await cleanup("draft-inspector", () => admin.query("drop role novel_source_inspector"));
      await cleanup("draft-owner", () => admin.query("drop role novel_source_draft_owner"));
    }
    await cleanup("admin-pool", () => admin.end());
    assert.deepEqual(failures, [], "SOURCE_D1A_TEST_CLEANUP_FAILED");
  }
});
