import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';

const schema = 'source_ingest_d1b_fixture_v1';
const writer = 'source_ingest_d1b_initialize_write_v1';
const material = 'source_ingest_d1b_initialize_material_v1';
const tables = ['collection', 'source_version', 'task_source_link', 'snapshot_source_link',
  'ingest_receipt', 'receipt_source_member', 'workspace_budget'];

export async function testInitializeWrite(admin: Pool, runtime: Pool, login: string, command: object) {
  assert.match(login, /^initialize_access_test_login$/);
  const readDraft = (name: string) => readFile(
    new URL(`../../../../docs/sql-drafts/evidence-source-d1b-initialize-${name}.sql`, import.meta.url), 'utf8');
  const draft = await readDraft('write');
  const guards = await admin.query<{ definition: string }>(
    `select pg_get_functiondef(fn::regprocedure) definition
      from unnest($1::text[]) fn`, [[`${schema}.deny_draft_write()`, `${schema}.guard_test_business()`]]);
  // Restore the original trigger definitions after the disposable writer test.
  await admin.query(await readDraft('material'));
  let installed = false;
  try {
    await admin.query(draft);
    installed = true;
    await admin.query(`grant usage on schema ${writer} to ${login};
      grant execute on function ${writer}.initialize_source_collection(jsonb,text,text) to ${login}`);
    const read = async () => (await admin.query(`select
      array[${tables.slice(0,-1).map(table => `(select count(*)::int from ${schema}.${table} where workspace_id='studio')`).join(',')}] counts,
      receipt_count,receipt_bytes,source_count,source_bytes,business_count,business_bytes
      from ${schema}.workspace_budget where workspace_id='studio'`)).rows[0];
    const original = await read();
    assert.deepEqual(original.counts,[0,0,0,0,0,0]);
    const invoke = `select ${writer}.initialize_source_collection($1,$2,'rule-v1') receipt`;
    await assert.rejects(runtime.query(invoke,[command,'init-hidden']),{code:'42501',message:'FORBIDDEN'});
    await assert.rejects(runtime.query(`select * from ${schema}.collection`),{code:'42501'});
    await assert.rejects(runtime.query(`insert into ${schema}.collection default values`),{code:'42501'});
    await assert.rejects(runtime.query('set role novel_d1b_initializer'),{code:'42501'});
    await assert.rejects(runtime.query(`select ${material}.prepare(null,null,null,null)`),{code:'42501'});

    await admin.query(`alter table ${schema}.ingest_receipt add constraint test_reject_receipt check(false) not valid`);
    try {
      await assert.rejects(runtime.query(invoke,[command,'init-collector']),{message:'UNAVAILABLE'});
      assert.deepEqual(await read(),original);
    } finally {
      await admin.query(`alter table ${schema}.ingest_receipt drop constraint test_reject_receipt`);
    }

    const client = await runtime.connect();
    try {
      await client.query('begin');
      const {receipt} = (await client.query(invoke,[command,'init-collector'])).rows[0];
      assert.equal(receipt.status,'initialized');
      assert.deepEqual(receipt.sourceReferences.map((reference: {kind: string})=>reference.kind),['task','snapshot']);
      assert.deepEqual(await read(),original);
      await client.query('commit');
      const stored = await read();
      assert.deepEqual(stored.counts,[1,2,1,1,1,2]);
      assert.equal(stored.receipt_count,original.receipt_count+1);
      assert.equal(stored.source_count,original.source_count+2);
      assert.equal(stored.business_count,original.business_count);
      assert.equal(stored.business_bytes,original.business_bytes);
      const persisted = (await admin.query(`select r.receipt,r.accounted_bytes,c.package_bytes
        from ${schema}.ingest_receipt r join ${schema}.collection c using (workspace_id,collection_id)
        where r.workspace_id='studio'`)).rows[0];
      assert.deepEqual(persisted.receipt,receipt);
      assert.equal(Number(stored.source_bytes)-Number(original.source_bytes),Number(persisted.package_bytes));
      assert.equal(Number(stored.receipt_bytes)-Number(original.receipt_bytes),persisted.accounted_bytes);
      await assert.rejects(client.query(invoke,[command,'init-collector']),{message:'CONFLICT'});
      assert.deepEqual(await read(),stored);
    } finally {
      try { await client.query('rollback'); } finally { client.release(); }
    }
  } finally {
    await admin.query('rollback');
    if (installed) {
      for (const table of tables) {
        await admin.query(`drop policy initialize_insert on ${schema}.${table}`);
      }
      for (const {definition} of guards.rows) await admin.query(definition);
      await admin.query(`drop schema ${writer} cascade`);
    }
    await admin.query(`drop schema ${material} cascade`);
  }
}
