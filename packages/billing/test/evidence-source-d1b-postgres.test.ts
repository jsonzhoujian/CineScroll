import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { assertSourceIngestDraftDatabase } from "../src/evidence-source-d1b-readiness.ts";

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
  let databaseCreated = false, draftCreated = false, loginCreated = false, inspectorCreated = false;
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
    if (draftCreated) for (const role of roles.toReversed()) await cleanup(role, () => admin.query(`drop role ${role}`));
    await cleanup("admin-pool", () => admin.end());
    assert.deepEqual(failures, [], "SOURCE_D1B_TEST_CLEANUP_FAILED");
  }
});
