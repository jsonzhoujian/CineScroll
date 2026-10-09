import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { assertSourceIngestDraftDatabase } from "../src/evidence-source-d1b-readiness.ts";
import { createIsolatedSourceBusinessLoader } from "./support/source-business-loader.ts";
import { sourceBusinessFixture } from "./support/source-business-fixture.ts";
import { assertIsolatedBusinessFixtureDatabase } from "./support/source-business-readiness.ts";
import { createIsolatedSourceBusinessReader } from "./support/source-business-reader.ts";
import { createIsolatedSourceBusinessAssembly } from "./support/source-business-assembly.ts";
import { assertIsolatedCombinedSourceDatabase } from "./support/source-combined-readiness.ts";
import { assertIsolatedCodecDatabase } from "./support/source-codec-readiness.ts";

const schema = "source_ingest_d1b_fixture_v1";
const roles = ["novel_d1b_owner", "novel_d1b_locker", "novel_d1b_mutator", "novel_d1b_reader", "novel_d1b_inspector"];

test("D1b closed draft creates atomically in a fresh socket-only PG16 instance", {
  skip: !process.env.TEST_SOURCE_D1B_DATABASE_URL,
}, async t => {
  const url = new URL(process.env.TEST_SOURCE_D1B_DATABASE_URL!);
  const socket = url.searchParams.get("host");
  assert.match(socket ?? "", /^\/private\/tmp\/source-d1b\.[A-Za-z0-9]{6}$/);
  assert.equal(url.pathname, "/postgres");
  assert.equal(url.password, "");
  const admin = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 2000 });
  const suffix = randomUUID().replaceAll("-", "");
  const database = `d1b_${suffix}`, login = `d1b_login_${suffix}`, inspectorLogin = `d1b_login_inspector_${suffix}`;
  let databaseCreated = false, draftCreated = false, loginCreated = false, inspectorCreated = false, authFixtureCreated = false, businessFixtureCreated = false;
  let codecInspectorCreated=false;
  let setup: Pool | undefined, runtime: Pool | undefined, inspector: Pool | undefined;
  try {
    assert.equal((await admin.query("show data_directory")).rows[0].data_directory, `${socket}/data`);
    assert.equal((await admin.query("show listen_addresses")).rows[0].listen_addresses, "");
    assert.equal(Math.floor(Number((await admin.query("show server_version_num")).rows[0].server_version_num) / 10000), 16);
    assert.equal((await admin.query("select count(*)::int as n from pg_roles where rolname=any($1)", [roles])).rows[0].n, 0);
    await admin.query(`create database ${database} encoding 'UTF8' template template0`); databaseCreated = true;
    url.pathname = `/${database}`;
    setup = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 2000 });
    const draft = await readFile(new URL("../../../docs/sql-drafts/evidence-source-d1b.sql", import.meta.url), "utf8");
    await t.test("an error before COMMIT rolls back the entire draft and its cluster roles", async () => {
      assert.match(draft, /\ncommit;\s*$/);
      const failedDraft = draft.replace(/\ncommit;\s*$/, "\nselect * from d1b_intentionally_missing;\ncommit;");
      await assert.rejects(setup!.query(failedDraft), { code: "42P01" });
      await setup!.query("rollback");
      assert.equal((await setup!.query("select to_regnamespace($1) as namespace", [schema])).rows[0].namespace, null);
      assert.equal((await admin.query("select count(*)::int as n from pg_roles where rolname=any($1)", [roles])).rows[0].n, 0);
    });
    await setup.query(draft); draftCreated = true;
    await t.test("all thirteen tables have FORCE RLS and both ALWAYS closed guards", async () => {
      const rows = (await setup!.query(`select c.relname,c.relrowsecurity,c.relforcerowsecurity,
        (select count(*)::int from pg_trigger g where g.tgrelid=c.oid and not g.tgisinternal and g.tgenabled='A') as guards
        from pg_class c where c.relnamespace=$1::regnamespace and c.relkind='r' order by c.relname`, [schema])).rows;
      assert.deepEqual(rows.map(row => row.relname), ["collection", "execution_identity", "fixed_quote", "fixed_snapshot", "ingest_receipt",
        "receipt_source_member", "service_principal", "snapshot_source_link", "source_version", "task_revision", "task_source_link",
        "workspace_budget", "workspace_service_grant"]);
      for (const row of rows) { assert.equal(row.relrowsecurity, true); assert.equal(row.relforcerowsecurity, true); assert.equal(row.guards, 2); }
    });
    await t.test("reapplying the strict draft rejects existing objects without changing the installed schema", async () => {
      await assert.rejects(setup!.query(draft), { code: "42710" });
      await setup!.query("rollback");
      assert.equal((await setup!.query("select count(*)::int as n from pg_class where relnamespace=$1::regnamespace and relkind='r'", [schema])).rows[0].n, 13);
    });
    await t.test("column UPDATE enables empty authorization FOR SHARE queries without granting permission edits", async () => {
      const client = await setup!.connect();
      try {
        await client.query("begin; set local role novel_d1b_locker");
        for (const table of ["service_principal", "workspace_service_grant"])
          assert.deepEqual((await client.query(`select * from ${schema}.${table} for share`)).rows, []);
        await assert.rejects(client.query(`update ${schema}.workspace_service_grant set enabled=true`), { code: "42501" });
      } finally { await client.query("rollback"); client.release(); }
      // No rows were prepared, so this proves lock privileges, not a held-row/revocation race.
      await setup!.query(`revoke update(lock_token) on ${schema}.workspace_service_grant from novel_d1b_locker`);
      const restricted = await setup!.connect();
      try {
        await restricted.query("begin; set local role novel_d1b_locker");
        await assert.rejects(restricted.query(`select * from ${schema}.workspace_service_grant for share`), { code: "42501" });
      } finally {
        await restricted.query("rollback"); restricted.release();
        await setup!.query(`grant update(lock_token) on ${schema}.workspace_service_grant to novel_d1b_locker`);
      }
    });
    await t.test("only the internal locker can select authorization rows and lock the designated column", async () => {
      const attributes = (await admin.query("select rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolreplication from pg_roles where rolname=any($1)", [roles])).rows;
      assert.equal(attributes.length, 5);
      for (const role of attributes) for (const property of ["rolcanlogin", "rolsuper", "rolcreatedb", "rolcreaterole", "rolbypassrls", "rolreplication"])
        assert.equal(role[property], false);
      for (const table of ["service_principal", "workspace_service_grant"]) {
        const permission = (await setup!.query(`select has_table_privilege('novel_d1b_locker',$1,'SELECT') as readable,
          has_table_privilege('novel_d1b_locker',$1,'UPDATE') as updatable,
          has_column_privilege('novel_d1b_locker',$1,'lock_token','UPDATE') as lockable,
          has_column_privilege('novel_d1b_locker',$1,'enabled','UPDATE') as authorizable`, [`${schema}.${table}`])).rows[0];
        assert.deepEqual(permission, { readable: true, updatable: false, lockable: true, authorizable: false });
      }
      const policies = (await setup!.query("select tablename,cmd,roles::text[] as roles from pg_policies where schemaname=$1 order by tablename,cmd", [schema])).rows;
      assert.equal(policies.length, 4);
      for (const policy of policies) { assert.ok(["service_principal", "workspace_service_grant"].includes(policy.tablename)); assert.deepEqual(policy.roles, ["novel_d1b_locker"]); }
      const helper = (await setup!.query(`select p.prosecdef,r.rolname as owner,p.proconfig,
        exists(select 1 from aclexplode(p.proacl) a where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute
        from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid=$1::regprocedure`, [`${schema}.lock_authorization(text,text,text)`])).rows[0];
      assert.deepEqual(helper, { prosecdef: true, owner: "novel_d1b_locker", proconfig: ["search_path=pg_catalog, pg_temp"], public_execute: false });
      assert.equal((await setup!.query("select has_schema_privilege('novel_d1b_locker',$1,'CREATE') as allowed", [schema])).rows[0].allowed, false);
      for (const role of roles.filter(role => role !== "novel_d1b_owner")) {
        // Function owners retain implicit EXECUTE; locker is NOLOGIN and unreachable by the test login.
        const expected = ["novel_d1b_locker", "novel_d1b_mutator", "novel_d1b_reader"].includes(role);
        assert.equal((await setup!.query("select has_function_privilege($1,$2,'EXECUTE') as allowed", [role, `${schema}.lock_authorization(text,text,text)`])).rows[0].allowed, expected);
      }
    });
    await t.test("the restricted inspector accepts only the frozen closed profile and rejects drift without repair", async profileTest => {
      await admin.query(`create role ${inspectorLogin} login noinherit nosuperuser nocreatedb nocreaterole nobypassrls noreplication`); inspectorCreated = true;
      await admin.query(`grant novel_d1b_inspector to ${inspectorLogin}`);
      await admin.query(`revoke temporary on database ${database} from public`);
      const inspectorUrl = new URL(url); inspectorUrl.username = inspectorLogin;
      inspector = new Pool({ connectionString: inspectorUrl.toString(), options: "-c role=novel_d1b_inspector", max: 1, connectionTimeoutMillis: 2000 });
      await assertSourceIngestDraftDatabase(inspector);
      await assert.rejects(assertSourceIngestDraftDatabase(setup!), { message: "SOURCE_INGEST_DRAFT_DATABASE_NOT_READY" });
      const guard = draft.match(/create function source_ingest_d1b_fixture_v1\.deny_draft_write\(\)[\s\S]*?\$body\$;/)![0].replace("create function", "create or replace function");
      const cases: [string, string, string][] = [
        ["BYPASSRLS login", `alter role ${inspectorLogin} bypassrls`, `alter role ${inspectorLogin} nobypassrls`],
        ["reachable owner", `grant novel_d1b_owner to ${inspectorLogin}`, `revoke novel_d1b_owner from ${inspectorLogin}`],
        ["login-capable locker", "alter role novel_d1b_locker login", "alter role novel_d1b_locker nologin"],
        ["database TEMP", `grant temporary on database ${database} to public`, `revoke temporary on database ${database} from public`],
        ["missing table", `alter table ${schema}.collection rename to drift_collection`, `alter table ${schema}.drift_collection rename to collection`],
        ["unexpected column", `alter table ${schema}.collection add column drift text`, `alter table ${schema}.collection drop column drift`],
        ["domain nullability changed", `alter domain ${schema}.identifier set not null`, `alter domain ${schema}.identifier drop not null`],
        ["FORCE RLS removed", `alter table ${schema}.collection no force row level security`, `alter table ${schema}.collection force row level security`],
        ["permissive policy", `create policy drift on ${schema}.collection using(true)`, `drop policy drift on ${schema}.collection`],
        ["inspector table access", `grant select on ${schema}.collection to novel_d1b_inspector`, `revoke select on ${schema}.collection from novel_d1b_inspector`],
        ["login column access", `grant select(binding) on ${schema}.collection to ${inspectorLogin}`, `revoke select(binding) on ${schema}.collection from ${inspectorLogin}`],
        ["locker edits authorization", `grant update(enabled) on ${schema}.workspace_service_grant to novel_d1b_locker`, `revoke update(enabled) on ${schema}.workspace_service_grant from novel_d1b_locker`],
        ["locker schema CREATE", `grant create on schema ${schema} to novel_d1b_locker`, `revoke create on schema ${schema} from novel_d1b_locker`],
        ["weakened budget", `alter table ${schema}.workspace_budget drop constraint workspace_budget_receipt_count_check; alter table ${schema}.workspace_budget add constraint workspace_budget_receipt_count_check check(true)`,
          `alter table ${schema}.workspace_budget drop constraint workspace_budget_receipt_count_check; alter table ${schema}.workspace_budget add constraint workspace_budget_receipt_count_check check(receipt_count between 0 and 1024)`],
        ["immediate circular FK", `alter table ${schema}.fixed_snapshot alter constraint fixed_snapshot_task_fk not deferrable initially immediate`, `alter table ${schema}.fixed_snapshot alter constraint fixed_snapshot_task_fk deferrable initially deferred`],
        ["missing index", `drop index ${schema}.source_enumeration`, `create index source_enumeration on ${schema}.source_version(workspace_id,collection_id,introduced_generation,kind,id,revision)`],
        ["extra index", `create index drift on ${schema}.source_version(workspace_id)`, `drop index ${schema}.drift`],
        ["closed row guard disabled", `alter table ${schema}.collection disable trigger draft_closed_row`, `alter table ${schema}.collection enable always trigger draft_closed_row`],
        ["internal FK guard disabled", `alter table ${schema}.receipt_source_member disable trigger all`, `alter table ${schema}.receipt_source_member enable trigger all; alter table ${schema}.receipt_source_member enable always trigger draft_closed_row; alter table ${schema}.receipt_source_member enable always trigger draft_closed_truncate`],
        ["guard body changed", `create or replace function ${schema}.deny_draft_write() returns trigger language plpgsql set search_path=pg_catalog,pg_temp as $$begin return new; end$$`, guard],
        ["helper search path", `alter function ${schema}.lock_authorization(text,text,text) set search_path=public`, `alter function ${schema}.lock_authorization(text,text,text) set search_path=pg_catalog,pg_temp`],
        ["helper PUBLIC EXECUTE", `grant execute on function ${schema}.lock_authorization(text,text,text) to public`, `revoke execute on function ${schema}.lock_authorization(text,text,text) from public`],
        ["future PUBLIC execution", `alter default privileges for role novel_d1b_owner in schema ${schema} grant execute on functions to public`, `alter default privileges for role novel_d1b_owner in schema ${schema} revoke execute on functions from public`],
        ["extra function", `create function ${schema}.drift() returns integer language sql as $$select 1$$`, `drop function ${schema}.drift()`],
        ["DML rewrite rule", `create rule drift as on insert to ${schema}.collection do instead nothing`, `drop rule drift on ${schema}.collection`],
      ];
      for (const [name, change, restore] of cases) {
        await profileTest.test(`preflight refuses ${name}`, async () => {
          await setup!.query(change);
          try {
            await assert.rejects(assertSourceIngestDraftDatabase(inspector!), { message: "SOURCE_INGEST_DRAFT_DATABASE_NOT_READY" });
            await assert.rejects(assertSourceIngestDraftDatabase(inspector!), { message: "SOURCE_INGEST_DRAFT_DATABASE_NOT_READY" });
          } finally { await setup!.query(restore); }
          await assertSourceIngestDraftDatabase(inspector!);
        });
      }
      await inspector.end(); inspector = undefined;
      await admin.query(`drop role ${inspectorLogin}`); inspectorCreated = false;
    });
    await admin.query(`create role ${login} login noinherit nosuperuser nocreatedb nocreaterole nobypassrls noreplication`); loginCreated = true;
    await setup.query(`grant usage on schema ${schema} to ${login}`);
    url.username = login;
    runtime = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 2000 });
    await t.test("a login cannot read, write, truncate, create objects, call helpers or assume an owner role", async () => {
      for (const table of ["collection", "ingest_receipt", "source_version", "service_principal", "workspace_service_grant"]) {
        for (const sql of [`select * from ${schema}.${table}`, `insert into ${schema}.${table} default values`,
          `delete from ${schema}.${table}`, `truncate ${schema}.${table}`])
          await assert.rejects(runtime!.query(sql), { code: "42501" });
      }
      await assert.rejects(runtime!.query(`update ${schema}.workspace_service_grant set enabled=true`), { code: "42501" });
      await assert.rejects(runtime!.query(`create table ${schema}.unauthorized()`), { code: "42501" });
      await assert.rejects(runtime!.query(`select ${schema}.lock_authorization('studio','initialize',null)`), { code: "42501" });
      for (const role of roles) await assert.rejects(runtime!.query(`set role ${role}`), { code: "42501" });
    });
    await t.test("helper invocation without a principal rejects with a sanitized error even after a test-only EXECUTE grant", async () => {
      await setup!.query(`grant execute on function ${schema}.lock_authorization(text,text,text) to ${login}`);
      try {
        await runtime!.query("set app.service_id='spoof'; set app.workspace_id='studio'");
        for (const args of [["studio", "initialize", null], ["studio", "register", "task"], ["studio", "receipt_read", null], ["studio", "register", "execution"]])
          await assert.rejects(runtime!.query(`select ${schema}.lock_authorization($1,$2,$3)`, args), { code: "42501", message: "FORBIDDEN" });
      } finally { await setup!.query(`revoke execute on function ${schema}.lock_authorization(text,text,text) from ${login}`); }
    });
    await t.test("closed row and truncate guards reject even the isolated administrator", async () => {
      const tables = (await setup!.query("select relname from pg_class where relnamespace=$1::regnamespace and relkind='r' order by relname", [schema])).rows;
      for (const { relname } of tables)
        await assert.rejects(setup!.query(`insert into ${schema}.${relname} default values`), { code: "P0001", message: "D1B_STORAGE_CLOSED" });
      await assert.rejects(setup!.query(`truncate ${tables.map(({ relname }) => `${schema}.${relname}`).join(",")}`), { code: "P0001", message: "D1B_STORAGE_CLOSED" });
    });
    await t.test("nullable identifiers and Unicode structural limits match representable protocol text", async () => {
      assert.equal((await setup!.query(`select null::${schema}.identifier as id`)).rows[0].id, null);
      for (const value of ["角色", "a".repeat(256), "😀".repeat(128)])
        assert.equal((await setup!.query(`select ${schema}.valid_id($1) as valid`, [value])).rows[0].valid, true);
      for (const value of ["", " name", "name\t", "name\u00a0", "\ufeffname", "https://secret.invalid", "name?", "*", "😀".repeat(129), "a".repeat(257)])
        assert.equal((await setup!.query(`select ${schema}.valid_id($1) as valid`, [value])).rows[0].valid, false);
      for (const value of [[], ["task"], ["task", "snapshot"]])
        assert.equal((await setup!.query(`select ${schema}.valid_ids($1) as valid`, [value])).rows[0].valid, true);
      for (const value of [["task", "task"], [null], [" bad"]])
        assert.equal((await setup!.query(`select ${schema}.valid_ids($1) as valid`, [value])).rows[0].valid, false);
    });
    await t.test("controlled test preparation binds a login without granting direct authorization writes", async () => {
      const extension = await readFile(new URL("../../../docs/sql-drafts/evidence-source-d1b-auth-fixture.sql", import.meta.url), "utf8");
      await setup!.query(extension); authFixtureCreated = true;
      await admin.query(`create role ${inspectorLogin} login noinherit nosuperuser nocreatedb nocreaterole nobypassrls noreplication`); inspectorCreated = true;
      await admin.query(`grant novel_d1b_inspector to ${inspectorLogin}`);
      const inspectorUrl = new URL(url); inspectorUrl.username = inspectorLogin;
      inspector = new Pool({ connectionString: inspectorUrl.toString(), options: "-c role=novel_d1b_inspector", max: 1, connectionTimeoutMillis: 2000 });
      assert.equal((await inspector.query("select current_user as role")).rows[0].role, "novel_d1b_inspector");
      await assert.rejects(assertSourceIngestDraftDatabase(inspector!), { message: "SOURCE_INGEST_DRAFT_DATABASE_NOT_READY" });
      const prepare = `select ${schema}.prepare_test_access($1,'collector','studio',true,true,true,array['task'],array['business-producer'],array['collector']) as access`;
      const access = (await setup!.query(prepare, [login])).rows[0].access;
      assert.deepEqual(access, { serviceId: "collector", workspaceId: "studio", principalRevision: 1, grantRevision: 1, principalEnabled: true, grantEnabled: true });
      assert.deepEqual((await setup!.query(prepare, [login])).rows[0].access, access);
      await setup!.query(`grant execute on function ${schema}.probe_test_access(text,text,text) to ${login}`);
      const result = (await runtime!.query(`select ${schema}.probe_test_access('studio','register','task') as access`)).rows[0].access;
      assert.equal(result.serviceId, "collector");
      assert.deepEqual(result.allowedBusinessProducerServiceIds, ["business-producer"]);
      assert.deepEqual(result.allowedReceiptProducerServiceIds, ["collector"]);
      await assert.rejects(runtime!.query(`select ${schema}.probe_test_access('studio','register','snapshot')`), { code: "42501", message: "FORBIDDEN" });
      await assert.rejects(runtime!.query(prepare, [login]), { code: "42501" });
      await assert.rejects(runtime!.query(`select ${schema}.set_test_grant_enabled('studio','collector',1,false)`), { code: "42501" });
    });
    await t.test("prepared authorization preserves isolation and forbids real-row lock-token writes", async () => {
      await assert.rejects(runtime!.query(`select ${schema}.probe_test_access('other','initialize',null)`), { code: "42501", message: "FORBIDDEN" });
      assert.equal((await runtime!.query(`select ${schema}.probe_test_access('studio','receipt_read',null) as access`)).rows[0].access.serviceId, "collector");
      await assert.rejects(setup!.query(`select ${schema}.prepare_test_access($1,'changed','studio',true,true,true,array['task'],array['business-producer'],array['collector'])`, [login]), { message: "TEST_ACCESS_CONFLICT" });
      await assert.rejects(setup!.query(`select ${schema}.prepare_test_access($1,'collector','studio',true,false,true,array['snapshot'],array['other-producer'],array['collector'])`, [login]), { message: "TEST_ACCESS_CONFLICT" });
      await assert.rejects(setup!.query(`select ${schema}.prepare_test_access($1,'collector','studio',true,true,true,array['unknown'],array['business-producer'],array['collector'])`, [login]), { message: "INVALID_TEST_ACCESS" });
      await assert.rejects(runtime!.query(`set role novel_d1b_auth_fixture`), { code: "42501" });
      const client = await setup!.connect();
      try {
        for (const table of ["service_principal", "workspace_service_grant"]) {
          await client.query("begin; set local role novel_d1b_locker");
          await assert.rejects(client.query(`update ${schema}.${table} set lock_token=lock_token`), { code: "42501", message: "FORBIDDEN" });
          await client.query("rollback");
        }
      } finally { await client.query("rollback"); client.release(); }
    });
    await t.test("real authorization locks serialize both read-before-revoke and revoke-before-read", async () => {
      const reader = await runtime!.connect(), manager = await setup!.connect();
      const revoke = `select ${schema}.set_test_grant_enabled('studio','collector',$1,$2) as revision`;
      const probe = `select ${schema}.probe_test_access('studio','register','task') as access`;
      const waitBlocked = async (blocked: number, blocker: number) => {
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          if ((await admin.query("select $2::int=any(pg_blocking_pids($1::int)) as blocked", [blocked, blocker])).rows[0].blocked) return;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.fail("expected real-row lock contention");
      };
      try {
        await reader.query("set statement_timeout='5s'");
        await manager.query("set statement_timeout='5s'");
        const readerPid = (await reader.query("select pg_backend_pid() as pid")).rows[0].pid;
        const managerPid = (await manager.query("select pg_backend_pid() as pid")).rows[0].pid;
        await reader.query("begin; set local statement_timeout='5s'");
        await reader.query(probe);
        await manager.query("begin; set local statement_timeout='5s'");
        const pendingRevoke = manager.query(revoke, [1, false]).then(result => ({ result }), error => ({ error }));
        await waitBlocked(managerPid, readerPid);
        await reader.query("commit");
        const revoked = await pendingRevoke;
        assert.ok("result" in revoked);
        assert.equal(revoked.result.rows[0].revision, "2");
        await manager.query("commit");
        await assert.rejects(reader.query(probe), { code: "42501", message: "FORBIDDEN" });
        const replay = (await manager.query(`select ${schema}.prepare_test_access($1,'collector','studio',true,true,true,array['task'],array['business-producer'],array['collector']) as access`, [login])).rows[0].access;
        assert.equal(replay.grantEnabled, false);
        assert.equal(replay.grantRevision, 2);
        await assert.rejects(manager.query(revoke, [1, true]), { message: "TEST_ACCESS_CONFLICT" });
        await manager.query(revoke, [2, true]);
        await manager.query("begin; set local statement_timeout='5s'");
        await manager.query(revoke, [3, false]);
        const pendingRead = reader.query(probe).then(result => ({ result }), error => ({ error }));
        await waitBlocked(readerPid, managerPid);
        await manager.query("commit");
        const denied = await pendingRead;
        assert.ok("error" in denied);
        assert.equal(denied.error.code, "42501");
        assert.equal(denied.error.message, "FORBIDDEN");
        assert.equal((await manager.query(revoke, [4, false])).rows[0].revision, "4");
      } finally {
        try { await manager.query("rollback"); }
        finally {
          manager.release(true);
          try { await reader.query("rollback"); }
          finally { reader.release(true); }
        }
      }
    });
    await t.test("controlled business loader atomically saves four immutable records and replays without budget duplication", async () => {
      const extension = await readFile(new URL("../../../docs/sql-drafts/evidence-source-d1b-business-fixture.sql", import.meta.url), "utf8");
      await setup!.query(extension); businessFixtureCreated = true;
      await setup!.query(`revoke execute on function ${schema}.probe_test_access(text,text,text) from ${login}`);
      await setup!.query(`revoke usage on schema ${schema} from ${login}`);
      await assertIsolatedBusinessFixtureDatabase(inspector!);
      const loader = createIsolatedSourceBusinessLoader(setup!, { workspaceId: "studio", allowedProducerServiceIds: ["producer"] });
      assert.deepEqual(await loader.load(sourceBusinessFixture()), { inserted: 4, replayed: 0 });
      assert.deepEqual(await loader.load(sourceBusinessFixture()), { inserted: 0, replayed: 4 });
      const count = (await setup!.query(`select business_count from ${schema}.workspace_budget where workspace_id='studio'`)).rows[0].business_count;
      assert.equal(count, 4);
    });
    await t.test("the frozen combined profile rejects extension privilege and guard drift without repair", async profileTest => {
      const guard = (await setup!.query("select pg_get_functiondef($1::regprocedure) as definition", [`${schema}.guard_test_business()`])).rows[0].definition;
      const cases: [string,string,string][] = [
        ["login-capable business role", "alter role novel_d1b_business_fixture login", "alter role novel_d1b_business_fixture nologin"],
        ["auth BYPASSRLS", "alter role novel_d1b_auth_fixture bypassrls", "alter role novel_d1b_auth_fixture nobypassrls"],
        ["business reachable owner", "grant novel_d1b_owner to novel_d1b_business_fixture", "revoke novel_d1b_owner from novel_d1b_business_fixture"],
        ["extra business update", `grant update on ${schema}.task_revision to novel_d1b_business_fixture`, `revoke update on ${schema}.task_revision from novel_d1b_business_fixture`],
        ["mutable budget scope", `grant update(source_count) on ${schema}.workspace_budget to novel_d1b_business_fixture`, `revoke update(source_count) on ${schema}.workspace_budget from novel_d1b_business_fixture`],
        ["business guard disabled", `alter table ${schema}.fixed_quote disable trigger test_business_row`, `alter table ${schema}.fixed_quote enable always trigger test_business_row`],
        ["auth guard disabled", `alter table ${schema}.service_principal disable trigger test_authorization_row`, `alter table ${schema}.service_principal enable always trigger test_authorization_row`],
        ["function owner", `alter function ${schema}.guard_test_business() owner to ${url.username}`, `alter function ${schema}.guard_test_business() owner to novel_d1b_owner`],
        ["function body", guard.replaceAll("FORBIDDEN", "CHANGED"), guard],
        ["PUBLIC probe", `grant execute on function ${schema}.probe_test_access(text,text,text) to public`, `revoke execute on function ${schema}.probe_test_access(text,text,text) from public`],
        ["temporary probe login", `grant execute on function ${schema}.probe_test_access(text,text,text) to ${login}`, `revoke execute on function ${schema}.probe_test_access(text,text,text) from ${login}`],
        ["temporary schema login", `grant usage on schema ${schema} to ${login}`, `revoke usage on schema ${schema} from ${login}`],
        ["extension global default ACL", "alter default privileges for role novel_d1b_business_fixture revoke execute on functions from public", "alter default privileges for role novel_d1b_business_fixture grant execute on functions to public"],
      ];
      for (const [label,change,restore] of cases) await profileTest.test(label, async () => {
        await setup!.query(change);
        try {
          await assert.rejects(assertIsolatedBusinessFixtureDatabase(inspector!), { message: "BUSINESS_FIXTURE_DATABASE_NOT_READY" });
          await assert.rejects(assertIsolatedBusinessFixtureDatabase(inspector!), { message: "BUSINESS_FIXTURE_DATABASE_NOT_READY" });
        } finally { await setup!.query(restore); }
        await assertIsolatedBusinessFixtureDatabase(inspector!);
      });
      await assert.rejects(assertIsolatedBusinessFixtureDatabase(setup!), { message: "BUSINESS_FIXTURE_DATABASE_NOT_READY" });
      await assert.rejects(assertSourceIngestDraftDatabase(inspector!), { message: "SOURCE_INGEST_DRAFT_DATABASE_NOT_READY" });
    });
    await t.test("business preparation rejects content conflicts and new fixed versions without changing saved rows", async () => {
      const loader = createIsolatedSourceBusinessLoader(setup!, { workspaceId: "studio", allowedProducerServiceIds: ["producer"] });
      const changed = sourceBusinessFixture(); changed.quote.pricingRuleVersion = "other-rule";
      await assert.rejects(loader.load(changed), { code: "CONFLICT", message: "CONFLICT" });
      const revised = sourceBusinessFixture();
      revised.quote.version = "v2"; revised.snapshot.quoteReference.version = "v2";
      await assert.rejects(loader.load(revised), { code: "CONFLICT" });
      const moved = sourceBusinessFixture();
      moved.tasks[0].id = moved.tasks[0].binding.taskId = "task-other";
      moved.tasks[0].binding.unitId = "unit-other"; moved.tasks[0].scopeKeys = ["unit-other"];
      moved.snapshot.id = moved.tasks[0].snapshotReference.id = "snapshot-other";
      moved.execution.id = moved.tasks[0].executionReference.id = "execution-other";
      moved.snapshot.taskAnchorReference.id = "task-other";
      moved.quote.version = moved.snapshot.quoteReference.version = "v2";
      await assert.rejects(loader.load(moved), { code: "CONFLICT" });
      assert.equal((await setup!.query(`select count(*)::int as n from ${schema}.task_revision where id='task-other'`)).rows[0].n, 0);
      assert.equal((await setup!.query(`select business_count from ${schema}.workspace_budget where workspace_id='studio'`)).rows[0].business_count, 4);
      assert.deepEqual(await loader.load(sourceBusinessFixture()), { inserted: 0, replayed: 4 });
    });
    await t.test("loaded business rows remain immutable, runtime cannot load, and producer scope is fixed", async () => {
      const input = sourceBusinessFixture();
      const forbidden = createIsolatedSourceBusinessLoader(runtime!, { workspaceId: "studio", allowedProducerServiceIds: ["producer"] });
      await assert.rejects(forbidden.load(input), { code: "FORBIDDEN" });
      const config = { workspaceId: "studio", allowedProducerServiceIds: ["another"] };
      const scoped = createIsolatedSourceBusinessLoader(setup!, config); config.allowedProducerServiceIds.push("producer");
      await assert.rejects(scoped.load(input), { code: "FORBIDDEN" });
      for (const table of ["task_revision", "fixed_snapshot", "execution_identity", "fixed_quote"]) {
        await assert.rejects(setup!.query(`update ${schema}.${table} set version=version`), { code: "42501", message: "FORBIDDEN" });
        await assert.rejects(setup!.query(`delete from ${schema}.${table}`), { code: "42501", message: "FORBIDDEN" });
        await assert.rejects(setup!.query(`truncate ${schema}.${table} cascade`), { code: "P0001", message: "D1B_STORAGE_CLOSED" });
        await assert.rejects(runtime!.query(`select * from ${schema}.${table}`), { code: "42501" });
      }
      await assert.rejects(runtime!.query("set role novel_d1b_business_fixture"), { code: "42501" });
      await assert.rejects(assertSourceIngestDraftDatabase(inspector!), { message: "SOURCE_INGEST_DRAFT_DATABASE_NOT_READY" });
    });
    await t.test("parallel preparations serialize at the workspace budget and a later task revision only adds its own row", async () => {
      const second = new Pool({ connectionString: setup!.options.connectionString, max: 1, connectionTimeoutMillis: 2000 });
      try {
        const input = sourceBusinessFixture(); input.tasks[0].binding.workspaceId = "parallel";
        const config = { workspaceId: "parallel", allowedProducerServiceIds: ["producer"] };
        const results = await Promise.all([createIsolatedSourceBusinessLoader(setup!, config).load(input), createIsolatedSourceBusinessLoader(second, config).load(input)]);
        assert.deepEqual(results.sort((a,b) => a.inserted-b.inserted), [{ inserted: 0, replayed: 4 }, { inserted: 4, replayed: 0 }]);
        input.tasks.push({ ...structuredClone(input.tasks[0]), version: "v2", revision: 2, predecessorVersion: "v1", recordedAt: "2026-10-08T00:00:01.000Z" });
        assert.deepEqual(await createIsolatedSourceBusinessLoader(setup!, config).load(input), { inserted: 1, replayed: 4 });
        assert.equal((await setup!.query(`select business_count from ${schema}.workspace_budget where workspace_id='parallel'`)).rows[0].business_count, 5);
      } finally { await second.end(); }
    });
    await t.test("an independent connection sees no partial group while the preparation transaction is in flight", async () => {
      const observerPool = new Pool({ connectionString: setup!.options.connectionString, max: 1, connectionTimeoutMillis: 2000 });
      let observer: PoolClient | undefined;
      const key = 521741;
      let pending: Promise<unknown> | undefined;
      try {
        observer = await observerPool.connect();
        await observer.query(`create function ${schema}.pause_business_fixture() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(${key}); return NEW; end $$`);
        await observer.query(`create trigger pause_business_fixture before insert on ${schema}.fixed_snapshot for each row execute function ${schema}.pause_business_fixture()`);
        await observer.query("select pg_advisory_lock($1)", [key]);
        const input = sourceBusinessFixture(); input.tasks[0].binding.workspaceId = "visibility";
        pending = createIsolatedSourceBusinessLoader(setup!, { workspaceId: "visibility", allowedProducerServiceIds: ["producer"] }).load(input);
        // Attach rejection immediately while polling, so a timed-out test does not leak an unhandled promise.
        const outcome = pending.then(result => ({ result }), error => ({ error }));
        const deadline = Date.now() + 700;
        let blocked = false;
        while (Date.now() < deadline) {
          blocked = (await observer.query("select exists(select 1 from pg_locks where locktype='advisory' and objid=$1 and not granted) as blocked", [key])).rows[0].blocked;
          if (blocked) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(blocked, true);
        for (const table of ["task_revision", "fixed_snapshot", "execution_identity", "fixed_quote", "workspace_budget"])
          assert.equal((await observer.query(`select count(*)::int as n from ${schema}.${table} where workspace_id='visibility'`)).rows[0].n, 0);
        await observer.query("select pg_advisory_unlock($1)", [key]);
        const completed = await outcome;
        assert.ok("result" in completed);
        assert.deepEqual(completed.result, { inserted: 4, replayed: 0 });
        for (const table of ["task_revision", "fixed_snapshot", "execution_identity", "fixed_quote"])
          assert.equal((await observer.query(`select count(*)::int as n from ${schema}.${table} where workspace_id='visibility'`)).rows[0].n, 1);
      } finally {
        const failures: string[] = [];
        const cleanup = async (stage: string, action: () => Promise<unknown>) => {
          try { await action(); } catch { failures.push(stage); }
        };
        try {
          if (observer) {
            await cleanup("unlock", () => observer!.query("select pg_advisory_unlock($1)", [key]));
            if (pending) await pending.catch(() => {});
            await cleanup("trigger", () => observer!.query(`drop trigger if exists pause_business_fixture on ${schema}.fixed_snapshot`));
            await cleanup("function", () => observer!.query(`drop function if exists ${schema}.pause_business_fixture()`));
          }
        } finally {
          try { observer?.release(true); }
          finally { await cleanup("observer-pool", () => observerPool.end()); }
        }
        assert.deepEqual(failures, [], "BUSINESS_OBSERVER_CLEANUP_FAILED");
      }
    });
    await t.test("exhausted workspace budget rolls back newly inserted business rows", async () => {
      for (const [workspace, count, bytes] of [["capacity-count",4096,0], ["capacity-bytes",0,16777216]] as const) {
        await setup!.query("begin; set local role novel_d1b_business_fixture");
        try {
          await setup!.query(`insert into ${schema}.workspace_budget values($1,0,0,0,0,0,0)`, [workspace]);
          await setup!.query(`update ${schema}.workspace_budget set business_count=$2,business_bytes=$3 where workspace_id=$1`, [workspace,count,bytes]);
          await setup!.query("commit");
        } finally { await setup!.query("rollback"); }
        const input = sourceBusinessFixture(); input.tasks[0].binding.workspaceId = workspace;
        const loader = createIsolatedSourceBusinessLoader(setup!, { workspaceId: workspace, allowedProducerServiceIds: ["producer"] });
        await assert.rejects(loader.load(input), { code: "CAPACITY_EXCEEDED", message: "CAPACITY_EXCEEDED" });
        for (const table of ["task_revision", "fixed_snapshot", "execution_identity", "fixed_quote"])
          assert.equal((await setup!.query(`select count(*)::int as n from ${schema}.${table} where workspace_id=$1`, [workspace])).rows[0].n, 0);
      }
    });
    await t.test("administrator reads exact saved versions without falling back to a newer task", async () => {
      const reader = createIsolatedSourceBusinessReader(setup!, { workspaceId: "parallel", allowedProducerServiceIds: ["producer"] });
      const refs = { taskReference: { id: "task", version: "v1" }, snapshotReference: { id: "snapshot", version: "v1" }, executionReference: { id: "execution", version: "v1" } };
      const first = await reader.read(refs);
      assert.equal(first.records.length, 4);
      assert.equal(first.records[0]!.version, "v1");
      const second = await reader.read({ ...refs, taskReference: { id: "task", version: "v2" } });
      assert.equal(second.records.length, 5);
      await assert.rejects(reader.read({ ...refs, taskReference: { id: "task", version: "missing" } }), { code: "NOT_FOUND" });
      first.records[0]!.document.binding.workspaceId = "changed";
      assert.equal((await reader.read(refs)).records[0]!.document.binding.workspaceId, "parallel");
    });
    await t.test("integrity reader rejects getter commands and does not accept overwritten command metadata", async () => {
      const reader = createIsolatedSourceBusinessReader(setup!, { workspaceId: "parallel", allowedProducerServiceIds: ["producer"] });
      const refs = { taskReference: { id: "task", version: "v1" }, snapshotReference: { id: "snapshot", version: "v1" }, executionReference: { id: "execution", version: "v1" } };
      await assert.rejects(reader.read({ ...refs, workspaceId: "secret-workspace" }), { code: "INVALID_COMMAND" });
      await assert.rejects(reader.read({ ...refs, taskReference: { id: "bad\u0000id", version: "v1" } }), { code: "INVALID_COMMAND" });
      let calls = 0;
      const getter = { ...refs }; Object.defineProperty(getter, "taskReference", { enumerable: true, get() { calls++; return refs.taskReference; } });
      await assert.rejects(reader.read(getter), { code: "INVALID_COMMAND" });
      assert.equal(calls, 0);
    });
    await t.test("reader detects saved projection and noncanonical byte corruption without repairing rows", async corruptionTest => {
      const refs = { taskReference: { id: "task", version: "v1" }, snapshotReference: { id: "snapshot", version: "v1" }, executionReference: { id: "execution", version: "v1" } };
      const reader = createIsolatedSourceBusinessReader(setup!, { workspaceId: "parallel", allowedProducerServiceIds: ["producer"] });
      const baseline = (await setup!.query(`select canonical,business_fingerprint,price_version from ${schema}.fixed_quote where workspace_id='parallel'`)).rows[0];
      for (const [label,change] of [
        ["SQL projection", `update ${schema}.fixed_quote set price_version='changed' where workspace_id='parallel'`],
        ["noncanonical bytes and matching digest", `update ${schema}.fixed_quote set canonical=convert_to(' '||convert_from(canonical,'UTF8'),'UTF8'),business_fingerprint=encode(sha256(convert_to(' '||convert_from(canonical,'UTF8'),'UTF8')),'hex') where workspace_id='parallel'`],
      ]) await corruptionTest.test(label!, async () => {
        await setup!.query(`alter table ${schema}.fixed_quote disable trigger test_business_row`);
        try {
          await setup!.query(change!);
          await assert.rejects(reader.read(refs), { code: "INTEGRITY_CONFLICT", message: "INTEGRITY_CONFLICT" });
          await assert.rejects(reader.read(refs), { code: "INTEGRITY_CONFLICT" });
        } finally {
          try { await setup!.query(`update ${schema}.fixed_quote set canonical=$1,business_fingerprint=$2,price_version=$3 where workspace_id='parallel'`, [baseline.canonical,baseline.business_fingerprint,baseline.price_version]); }
          finally { await setup!.query(`alter table ${schema}.fixed_quote enable always trigger test_business_row`); }
        }
        assert.equal((await reader.read(refs)).records.length, 4);
        await assertIsolatedBusinessFixtureDatabase(inspector!);
      });
      const forbidden = createIsolatedSourceBusinessReader(runtime!, { workspaceId: "parallel", allowedProducerServiceIds: ["producer"] });
      await assert.rejects(forbidden.read(refs), { code: "FORBIDDEN" });
      const config = { workspaceId: "parallel", allowedProducerServiceIds: ["other"] };
      const hidden = createIsolatedSourceBusinessReader(setup!, config); config.allowedProducerServiceIds.push("producer");
      await assert.rejects(hidden.read(refs), { code: "NOT_FOUND" });
      await assert.rejects(createIsolatedSourceBusinessReader(setup!, { workspaceId: "unknown", allowedProducerServiceIds: ["producer"] }).read(refs), { code: "NOT_FOUND" });
    });
    await t.test("assembled reader binds a single endpoint and rechecks the directory for every read", async () => {
      const assembly = createIsolatedSourceBusinessAssembly({ connectionString: setup!.options.connectionString!, inspectorLogin,
        workspaceId: "parallel", allowedProducerServiceIds: ["producer"] });
      const refs = { taskReference: { id: "task", version: "v1" }, snapshotReference: { id: "snapshot", version: "v1" }, executionReference: { id: "execution", version: "v1" } };
      try {
        assert.equal((await assembly.read(refs)).records.length, 4);
        await setup!.query(`alter table ${schema}.fixed_quote disable trigger test_business_row`);
        try { await assert.rejects(assembly.read(refs), { code: "NOT_READY", message: "NOT_READY" }); }
        finally { await setup!.query(`alter table ${schema}.fixed_quote enable always trigger test_business_row`); }
        assert.equal((await assembly.read(refs)).records.length, 4);
      } finally { await assembly.close(); }
      await assert.rejects(assembly.read(refs), { code: "CLOSED" });
    });
    await t.test("assembly snapshots configuration and commands and cannot accept a second reader endpoint", async () => {
      const config = { connectionString: setup!.options.connectionString!, inspectorLogin, workspaceId: "parallel", allowedProducerServiceIds: ["producer"] };
      assert.throws(() => createIsolatedSourceBusinessAssembly({ ...config, readerConnectionString: "postgresql://other@localhost/d1b_other" }), { code: "INVALID_CONFIG" });
      const assembly = createIsolatedSourceBusinessAssembly(config);
      const refs = { taskReference: { id: "task", version: "v1" }, snapshotReference: { id: "snapshot", version: "v1" }, executionReference: { id: "execution", version: "v1" } };
      config.workspaceId = "unknown"; config.allowedProducerServiceIds.length = 0;
      config.connectionString = "postgresql://other@localhost/d1b_other";
      try {
        const pending = assembly.read(refs);
        refs.taskReference.version = "missing";
        assert.equal((await pending).records[0]!.version, "v1");
        await assert.rejects(assembly.read(refs), { code: "NOT_FOUND" });
      } finally { await assembly.close(); }
      await assembly.close();
    });
    await t.test('pure codec and business metadata compose without relaxing either frozen catalog',async()=>{
      assert.equal((await setup!.query('select session_user actor')).rows[0].actor,'codec_admin');
      await admin.query('create role codec_inspector login nosuperuser nocreatedb nocreaterole nobypassrls noreplication');codecInspectorCreated=true;
      await setup!.query(await readFile(new URL('../../../docs/sql-drafts/evidence-source-d1b-codec.sql',import.meta.url),'utf8'));
      await assertIsolatedBusinessFixtureDatabase(inspector!);
      await assertIsolatedCombinedSourceDatabase(inspector!);
      const codecUrl=new URL(url);codecUrl.username='codec_inspector';
      const codecPool=new Pool({connectionString:codecUrl.toString(),options:'-c search_path=pg_catalog,pg_temp',max:1});
      try{await assert.rejects(assertIsolatedCodecDatabase(codecPool),{message:'CODEC_DATABASE_NOT_READY'});}finally{await codecPool.end();}
      for(const [mutate,restore] of [
        ["alter function source_ingest_d1b_codec_v1.quote_string(text) stable","alter function source_ingest_d1b_codec_v1.quote_string(text) immutable"],
        [`grant select on ${schema}.task_revision to novel_d1b_inspector`,`revoke select on ${schema}.task_revision from novel_d1b_inspector`],
      ]){
        await setup!.query(mutate!);
        try{await assert.rejects(assertIsolatedCombinedSourceDatabase(inspector!),{message:'COMBINED_SOURCE_DATABASE_NOT_READY'});}
        finally{await setup!.query(restore!);}
        await assertIsolatedCombinedSourceDatabase(inspector!);
      }
    });
  } finally {
    const failures: string[] = [];
    const cleanup = async (stage: string, action: () => Promise<unknown>) => {
      try { await action(); } catch { failures.push(stage); }
    };
    if (runtime) await cleanup("runtime-pool", () => runtime!.end());
    if (inspector) await cleanup("inspector-pool", () => inspector!.end());
    if (setup) {
      await setup.query("rollback").catch(() => {});
      await cleanup("setup-pool", () => setup!.end());
    }
    if (databaseCreated) await cleanup("test-database", () => admin.query(`drop database ${database}`));
    if (loginCreated) await cleanup("test-login", () => admin.query(`drop role ${login}`));
    if (inspectorCreated) await cleanup("inspector-login", () => admin.query(`drop role ${inspectorLogin}`));
    if (codecInspectorCreated) await cleanup('codec-inspector',()=>admin.query('drop role codec_inspector'));
    if (authFixtureCreated) await cleanup("auth-fixture-owner", () => admin.query("drop role novel_d1b_auth_fixture"));
    if (businessFixtureCreated) await cleanup("business-fixture-role", () => admin.query("drop role novel_d1b_business_fixture"));
    if (draftCreated) for (const role of roles.toReversed()) await cleanup(role, () => admin.query(`drop role ${role}`));
    await cleanup("admin-pool", () => admin.end());
    assert.deepEqual(failures, [], "SOURCE_D1B_TEST_CLEANUP_FAILED");
  }
});
