import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client, Pool } from 'pg';
import { checkInitializeWritePool } from './source-initialize-write-profile.ts';
import { createIsolatedInitializer, InitializeCommitUnknown } from './source-initialize-transaction.ts';
import { createIsolatedSourceBusinessLoader } from './source-business-loader.ts';
import { sourceBusinessFixture } from './source-business-fixture.ts';
import { setTimeout as delay } from 'node:timers/promises';

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
  const inspectorUrl = new URL(runtime.options.connectionString!);
  inspectorUrl.username = 'codec_inspector';
  const inspector = new Pool({connectionString:inspectorUrl.toString(),max:1,
    options:'-c search_path=pg_catalog,pg_temp -c statement_timeout=5000'});
  let installed = false;
  try {
    await admin.query(draft);
    installed = true;
    await admin.query(`grant usage on schema ${writer} to ${login};
      grant execute on function ${writer}.initialize_source_collection(jsonb,text,text) to ${login}`);
    const checkedPool = await checkInitializeWritePool(inspector,runtime);
    const initializer = createIsolatedInitializer(checkedPool,'init-collector','rule-v1');
    for (const [change,restore] of [
      [`alter table ${schema}.collection disable trigger draft_closed_row`,
        `alter table ${schema}.collection enable always trigger draft_closed_row`],
      [`grant execute on function ${writer}.replay_initialize(jsonb,bytea) to codec_inspector`,
        `revoke execute on function ${writer}.replay_initialize(jsonb,bytea) from codec_inspector`],
      [`alter policy initialize_replay on ${schema}.ingest_receipt using (true)`,
        `alter policy initialize_replay on ${schema}.ingest_receipt using (${writer}.can_initialize_workspace(workspace_id))`],
    ] as const) {
      await admin.query(change);
      try {
        await assert.rejects(checkInitializeWritePool(inspector,runtime),{message:'INITIALIZE_WRITE_PROFILE_NOT_READY'});
        await assert.rejects(initializer.initializeSourceCollection(command),{message:'UNAVAILABLE'});
      } finally { await admin.query(restore); }
    }
    await assert.rejects(checkInitializeWritePool(runtime,runtime),{message:'INITIALIZE_WRITE_PROFILE_NOT_READY'});
    await assert.rejects(inspector.query(`select * from ${schema}.collection`),{code:'42501'});
    await assert.rejects(inspector.query(`select ${writer}.initialize_source_collection(null,null,null)`),{code:'42501'});
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

    async function interruptedCommit(commitOnServer: boolean, input: object) {
      let attempts=0;
      let discarded=false;
      let terminated=false;
      let committedReceipt: unknown;
      const initializer=createIsolatedInitializer({
        async connect() {
          const connection=await checkedPool.connect();
          if (++attempts>1) return connection;
          return {
            async query(sql: string, values?: unknown[]) {
              if (sql==='commit') {
                const pid=(await connection.query('select pg_backend_pid() pid')).rows[0].pid;
                if (commitOnServer) await connection.query(sql);
                connection.on('error',()=>{});
                terminated=(await admin.query('select pg_terminate_backend($1,2000) stopped',[pid])).rows[0].stopped===true;
                throw new Error('test connection terminated during COMMIT');
              }
              const result=await connection.query(sql,values);
              if (values) committedReceipt=result.rows[0]?.receipt;
              return result;
            },
            release(destroy?: boolean) {
              discarded=destroy===true;
              connection.release(destroy);
            },
          };
        },
      },'init-collector','rule-v1');
      let unknown: InitializeCommitUnknown | undefined;
      await assert.rejects(initializer.initializeSourceCollection(input), error => {
        if (!(error instanceof InitializeCommitUnknown)) return false;
        unknown=error;
        return error.message==='UNAVAILABLE';
      });
      assert.equal(attempts,1);
      assert.equal(discarded,true);
      assert.equal(terminated,true);
      assert.ok(committedReceipt);
      return {unknown:unknown!,committedReceipt,retryCount:()=>attempts};
    }

    const client = await runtime.connect();
    try {
      await client.query('begin');
      const {receipt} = (await client.query(invoke,[command,'init-collector'])).rows[0];
      assert.equal(receipt.status,'initialized');
      assert.deepEqual(receipt.sourceReferences.map((reference: {kind: string})=>reference.kind),['task','snapshot']);
      assert.deepEqual(await read(),original);
      const contender = new Client(runtime.options);
      await contender.connect();
      try {
        const leaderPid = (await client.query('select pg_backend_pid() pid')).rows[0].pid;
        const contenderPid = (await contender.query('select pg_backend_pid() pid')).rows[0].pid;
        const waiting = contender.query(invoke,[command,'init-collector']).then(
          result => ({result}), error => ({error}));
        try {
          let blocked = false;
          for (let attempt=0; attempt<100 && !blocked; attempt++) {
            blocked = (await admin.query('select $1::int=any(pg_blocking_pids($2)) blocked',
              [leaderPid,contenderPid])).rows[0].blocked;
            if (!blocked) await delay(10);
          }
          assert.equal(blocked,true,'retry must wait for the first transaction');
          assert.deepEqual(await read(),original);
          await client.query('commit');
          const outcome = await waiting;
          if ('error' in outcome) throw outcome.error;
          assert.deepEqual(outcome.result.rows[0].receipt,receipt);
        } finally {
          await client.query('rollback');
          await waiting;
        }
      } finally {
        await contender.end();
      }
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
      const budgetLock = await admin.connect();
      try {
        await budgetLock.query('begin');
        await budgetLock.query(`select workspace_id from ${schema}.workspace_budget where workspace_id='studio' for update`);
        await client.query("set lock_timeout='250ms'");
        assert.deepEqual((await client.query(invoke,[command,'init-collector'])).rows[0].receipt,receipt);
      } finally {
        try { await budgetLock.query('rollback'); } finally { budgetLock.release(); }
      }
      await assert.rejects(client.query(invoke,[{...command,unitId:'changed-unit'},'init-collector']),{message:'CONFLICT'});
      await assert.rejects(client.query(invoke,[command,'init-hidden']),{code:'42501',message:'FORBIDDEN'});
      await admin.query(`select ${schema}.set_test_grant_enabled('studio','init-collector',3,false)`);
      try {
        await assert.rejects(client.query(invoke,[command,'init-collector']),{code:'42501',message:'FORBIDDEN'});
      } finally {
        await admin.query(`select ${schema}.set_test_grant_enabled('studio','init-collector',4,true)`);
      }
      assert.deepEqual(await read(),stored);
    } finally {
      try { await client.query('rollback'); } finally { client.release(); }
    }
    const committed = (await admin.query(`select receipt from ${schema}.ingest_receipt where workspace_id='studio'`)).rows[0].receipt;
    assert.deepEqual(await initializer.initializeSourceCollection(command),committed);
    const beforeDuplicate=await read();
    const duplicate={...command,ingestId:'duplicate-1'};
    const {receipt: duplicateReceipt}=(await runtime.query(invoke,[duplicate,'init-collector'])).rows[0];
    assert.equal(duplicateReceipt.status,'already_registered');
    assert.equal(duplicateReceipt.headRevisionAtCommit,1);
    const afterDuplicate=await read();
    assert.deepEqual(afterDuplicate.counts,[1,2,1,1,2,4]);
    assert.equal(afterDuplicate.source_count,beforeDuplicate.source_count);
    assert.equal(afterDuplicate.source_bytes,beforeDuplicate.source_bytes);
    const receiptCost=Number(afterDuplicate.receipt_bytes)-Number(beforeDuplicate.receipt_bytes);
    assert.ok(receiptCost>0);
    assert.deepEqual((await runtime.query(invoke,[duplicate,'init-collector'])).rows[0].receipt,duplicateReceipt);
    await assert.rejects(runtime.query(invoke,[{...duplicate,ingestId:'duplicate-2',
      taskReference:{id:'task',version:'v2'}},'init-collector']),{message:'CONFLICT'});
    assert.deepEqual(await read(),afterDuplicate);

    const seedBudget=async (bytes: number)=>{
      await admin.query(`begin; alter table ${schema}.workspace_budget disable trigger test_business_row;
        update ${schema}.workspace_budget set receipt_count=1023,receipt_bytes=${bytes} where workspace_id='studio';
        alter table ${schema}.workspace_budget enable always trigger test_business_row; commit`);
    };
    await seedBudget(16777216-receiptCost+1);
    const beforeOverflow=await read();
    const boundary={...command,ingestId:'duplicate-2'};
    await assert.rejects(runtime.query(invoke,[boundary,'init-collector']),{message:'CAPACITY'});
    assert.deepEqual(await read(),beforeOverflow);
    await seedBudget(16777216-receiptCost);
    assert.equal((await runtime.query(invoke,[boundary,'init-collector'])).rows[0].receipt.status,'already_registered');
    const full=await read();
    assert.equal(full.receipt_count,1024);
    assert.equal(Number(full.receipt_bytes),16777216);
    assert.deepEqual(full.counts,[1,2,1,1,3,6]);
    await assert.rejects(runtime.query(invoke,[{...boundary,ingestId:'duplicate-3'},'init-collector']),{message:'CAPACITY'});
    assert.deepEqual((await runtime.query(invoke,[duplicate,'init-collector'])).rows[0].receipt,duplicateReceipt);
    assert.deepEqual(await read(),full);

    const recoveryWorkspace='recovery';
    const fixture=sourceBusinessFixture();
    fixture.tasks[0].binding.workspaceId=recoveryWorkspace;
    await createIsolatedSourceBusinessLoader(admin,{workspaceId:recoveryWorkspace,allowedProducerServiceIds:['producer']}).load(fixture);
    for (const workspace of [recoveryWorkspace,'parallel']) {
      await admin.query(`select ${schema}.prepare_test_access($1,'init-collector',$2,true,true,true,array['task'],array['producer'],array['init-collector'])`,[login,workspace]);
    }
    const recoveryState=async (workspace: string)=>(await admin.query(`select receipt_count,source_count,
      (select count(*)::int from ${schema}.ingest_receipt where workspace_id=$1) receipts
      from ${schema}.workspace_budget where workspace_id=$1`,[workspace])).rows[0];

    const rolledBack=await interruptedCommit(false,{...command,workspaceId:recoveryWorkspace});
    assert.deepEqual(await recoveryState(recoveryWorkspace),{receipt_count:0,source_count:0,receipts:0});
    const recovered=await rolledBack.unknown.retry();
    assert.equal(rolledBack.retryCount(),2);
    assert.notDeepEqual(recovered,rolledBack.committedReceipt);
    assert.deepEqual(await recoveryState(recoveryWorkspace),{receipt_count:1,source_count:2,receipts:1});

    const parallel={...command,workspaceId:'parallel'};
    const missingResponse=await interruptedCommit(true,parallel);
    parallel.workspaceId='changed-after-first-attempt';
    assert.deepEqual(await missingResponse.unknown.retry(),missingResponse.committedReceipt);
    assert.equal(missingResponse.retryCount(),2);
    assert.deepEqual(await recoveryState('parallel'),{receipt_count:1,source_count:2,receipts:1});

  } finally {
    await inspector.end();
    await admin.query('rollback');
    if (installed) {
      for (const table of tables) {
        await admin.query(`drop policy initialize_insert on ${schema}.${table}`);
      }
      for (const table of ['ingest_receipt','receipt_source_member','collection','source_version','task_source_link','snapshot_source_link']) {
        await admin.query(`drop policy initialize_replay on ${schema}.${table}`);
      }
      for (const {definition} of guards.rows) await admin.query(definition);
      await admin.query(`drop schema ${writer} cascade`);
    }
    await admin.query(`drop schema ${material} cascade`);
  }
}
