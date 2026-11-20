import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool } from 'pg';
import { createEpisodeSettlement } from '../../api/src/episode-settlement.ts';
import { PostgresEvidenceMaterialRepository } from '../src/postgres-evidence.ts';
import { CreditLedgerService } from '../src/index.ts';
import { PostgresCreditLedgerRepository } from '../src/postgres-ledger.ts';
import { ModelTaskService } from '../../script/src/model-tasks.ts';
import { InMemoryModelSettingsRepository, WorkspaceModelSettings } from '../../script/src/model-settings.ts';
import { assertEpisodeOutboxDatabase } from '../../api/src/episode-outbox-database-readiness.ts';
import { EpisodeOutboxConsumer } from '../../api/src/episode-outbox-consumer.ts';
import { createEpisodeSubmissionRepository } from '../../api/src/episode-submission.ts';

test('拆集请求同事务保存任务、冻结额度及 Outbox', {
  skip: !process.env.TEST_EPISODE_SUBMISSION_DATABASE_URL,
}, async () => {
  const url=new URL(process.env.TEST_EPISODE_SUBMISSION_DATABASE_URL!);
  const socket=url.searchParams.get('host');
  assert.match(socket ?? '',/^\/private\/tmp\/source-d1b\.[A-Za-z0-9]{6}$/);
  assert.equal(url.pathname,'/postgres');
  assert.equal(url.password,'');
  const admin=new Pool({connectionString:url.href,max:1});
  let pool: Pool | undefined;
  let workerPool: Pool | undefined;
  try {
    assert.equal((await admin.query('show data_directory')).rows[0].data_directory,`${socket}/data`);
    assert.equal((await admin.query('show listen_addresses')).rows[0].listen_addresses,'');
    await admin.query('create role novel_app nologin; create role episode_submission login; create role episode_outbox_worker login');
    for (const file of ['../migrations/0001_credit_ledger.sql','../migrations/0002_evidence_material.sql','../../script/migrations/0003_model_tasks.sql',
      '../../script/migrations/0004_model_task_results.sql','../../script/migrations/0005_model_task_recovery.sql',
      '../migrations/0003_episode_submission_outbox.sql','../migrations/0004_episode_outbox_consumer.sql']) {
      await admin.query(await readFile(new URL(file,import.meta.url),'utf8'));
    }
    await admin.query('grant novel_app,novel_billing,novel_evidence,novel_episode_submission,novel_episode_outbox_consumer to episode_submission');
    await admin.query('grant novel_episode_outbox_consumer to episode_outbox_worker');
    url.username='episode_submission';
    pool=new Pool({connectionString:url.href,max:3});
    await assertEpisodeOutboxDatabase(pool);
    await assert.rejects(assertEpisodeOutboxDatabase(admin),{message:'EPISODE_OUTBOX_DATABASE_NOT_READY'});
    const actor={workspaceId:'studio',userId:'owner'};
    const billingActor={workspaceId:'studio',serviceId:'episode-test'};
    const ledger=new CreditLedgerService({repository:new PostgresCreditLedgerRepository(pool),
      access:{authorize:async()=>true},clock:()=>new Date()});
    await ledger.grant(billingActor,{eventId:'seed',grantId:'seed',amount:10,source:'fixture'});
    const settings=new WorkspaceModelSettings({repository:new InMemoryModelSettingsRepository(),
      encryptionKey:new Uint8Array(32).fill(7), access:{read:async()=>({owner:true,advanced:true})},
      idGenerator:(()=>{let id=0;return ()=>`config-${++id}`;})(),
      probe:{processingRegion:()=> 'mainland',test:async()=>({modelIds:['m','byok'],processingRegion:'mainland'})}});
    const config=await settings.configure(actor,{expectedVersionId:null,providerId:'deepseek',apiKey:'fixture-key'});
    const verified=await settings.testConnection(actor,config.id);
    const quote={workspaceId:'studio',configurationVersionId:verified.id,providerId:'deepseek',modelId:'m',
      quoteId:'fixture-quote',priceVersion:'fixture-v1',reserved:7};
    assert.throws(()=>createEpisodeSubmissionRepository(pool!,{
      serviceId:'episode-test',workspaceIds:['studio'],platformQuotes:[quote,quote],
    }),{message:'EPISODE_QUOTE_CONFIG_INVALID'});
    const repository=createEpisodeSubmissionRepository(pool,{
      serviceId:'episode-test',workspaceIds:['studio'],platformQuotes:[quote],
    });
    const service=new ModelTaskService({settings,repository,
      contextReader:{read:async()=>({stage:'script',resultType:'episodePlan',sourceVersionId:'source-1',
        upstreamConfirmedVersionIds:['bible-1'],generationParameters:{targetDurationSeconds:180,aspectRatio:'9:16',narrativeMode:'narration'}})},
      generationPolicy:{isAllowed:async()=>true},episodeAdmission:{workspaceIds:['studio'],providerIds:['deepseek']},
      idGenerator:()=> 'unused'});
    quote.reserved=99; // The running repository retains its server-side configuration snapshot.
    const submit=(requestId: string,modelId='m')=>service.submitEpisodePlan(actor,{projectId:'p',chapterId:'c',
      configurationVersionId:verified.id,modelId,requestId});
    const counts=async ()=>(await admin.query(`select
      (select count(*)::int from model_tasks) tasks,
      (select count(*)::int from credit_ledger_versions) ledger_versions,
      (select count(*)::int from episode_submission_outbox) outbox`)).rows[0];
    const original=await counts();
    await admin.query('alter table episode_submission_outbox add constraint fail_insert check(false)');
    await assert.rejects(submit('same-request'),{code:'STORAGE_UNAVAILABLE'});
    assert.deepEqual(await counts(),original);
    await admin.query('alter table episode_submission_outbox drop constraint fail_insert');
    const [first,second]=await Promise.all([submit('same-request'),submit('same-request')]);
    assert.deepEqual(second,first);
    assert.equal(first.dispatchOwner,'outbox');
    const platformBilling=await ledger.task(billingActor,first.id);
    assert.equal(platformBilling.snapshot.quoteId,'fixture-quote');
    assert.equal(platformBilling.snapshot.priceVersion,'fixture-v1');
    assert.equal(platformBilling.snapshot.responsibility,'platform');
    assert.deepEqual(await counts(),{tasks:1,ledger_versions:2,outbox:1});
    assert.deepEqual((await ledger.entries(billingActor)).map(entry=>[entry.operation,entry.amount]),[['grant',10],['reserve',7]]);
    await assert.rejects(submit('no-balance'),{code:'INSUFFICIENT_CREDITS'});
    assert.deepEqual(await counts(),{tasks:1,ledger_versions:2,outbox:1});
    const available=await ledger.balance(billingActor);
    const byok=await submit('byok-request','byok');
    assert.deepEqual(await ledger.balance(billingActor),available);
    const byokBilling=await ledger.task(billingActor,byok.id);
    assert.equal(byokBilling.snapshot.responsibility,'byok');
    assert.deepEqual(byokBilling.units.map(unit=>[unit.state,unit.reserved]),[['exempt',0]]);
    assert.deepEqual((await pool.query('select task_id from public.episode_submission_outbox')).rows,[]);
    const connection=await pool.connect();
    try {
      await connection.query("begin; set local app.model_workspace_id='studio'; set local app.billing_workspace_id='different'");
      await assert.rejects(connection.query(
        'insert into public.episode_submission_outbox(workspace_id,task_id) values($1,$2)',['studio',byok.id]),{code:'42501'});
    } finally {
      try {await connection.query('rollback');} finally {connection.release();}
    }
    assert.deepEqual((await ledger.entries(billingActor)).map(entry=>entry.operation),['grant','reserve']);
    assert.deepEqual(await counts(),{tasks:2,ledger_versions:3,outbox:2});
    assert.deepEqual(await submit('byok-request','byok'),byok);
    assert.deepEqual(await counts(),{tasks:2,ledger_versions:3,outbox:2});

    url.username='episode_outbox_worker';
    workerPool=new Pool({connectionString:url.href,max:3});
    const consumer=new EpisodeOutboxConsumer(workerPool,['studio']);
    const delivered: string[]=[];
    const dispatch=async ({taskId}: {taskId:string})=>{delivered.push(taskId);};
    await assert.rejects(consumer.tick('different',dispatch),{message:'FORBIDDEN'});
    let interruptedTask: string | undefined;
    assert.equal(await consumer.tick('studio',async ({taskId})=>{
      interruptedTask=taskId;
      throw new Error('simulated failure after dispatch');
    }),false);
    assert.ok(interruptedTask);
    await Promise.all([consumer.tick('studio',dispatch),consumer.tick('studio',dispatch)]);
    assert.equal(delivered.length,1);
    assert.equal(await consumer.tick('studio',dispatch),false);
    await admin.query(`update episode_submission_outbox set lease_until=clock_timestamp()-interval '1 second'
      where dispatched_at is null`);
    const stale=await consumer.claim('studio');
    assert.ok(stale);
    await admin.query(`update episode_submission_outbox set lease_until=clock_timestamp()-interval '1 second'
      where dispatched_at is null`);
    assert.equal(await consumer.tick('studio',async item=>{
      assert.equal(item.taskId,interruptedTask);
      assert.equal(await consumer.acknowledge(stale),false);
      await dispatch(item);
    }),true);
    assert.equal(await consumer.acknowledge(stale),false);
    assert.equal(await consumer.tick('studio',dispatch),false);
    assert.deepEqual(new Set(delivered),new Set([first.id,byok.id]));
    assert.equal(delivered.length,2);
    assert.deepEqual((await workerPool.query('select task_id from episode_submission_outbox')).rows,[]);
    await assert.rejects(workerPool.query('select * from model_tasks'),{code:'42501'});
    await assert.rejects(workerPool.query('delete from episode_submission_outbox'),{code:'42501'});
    await ledger.grant(billingActor,{eventId:'settlement-seed',grantId:'settlement-seed',amount:21,source:'fixture'});
    const evidence=new PostgresEvidenceMaterialRepository(pool);
    const settle=createEpisodeSettlement({repository,ledgerRepository:new PostgresCreditLedgerRepository(pool),
      source:evidence,serviceId:billingActor.serviceId,workspaceIds:['studio']});
    for (const outcome of ['succeeded','failed','unknown'] as const) {
      const task=await submit(`settle-${outcome}`);
      const running=await repository.transition('studio',task.id,0,'running',null);
      if (outcome==='succeeded') await repository.transition('studio',task.id,running.revision,'succeeded',null,
        {candidateVersionId:'candidate-1',extractionStatus:'succeeded'});
      if (outcome==='failed') await repository.transition('studio',task.id,running.revision,'failed','INVALID_RESPONSE');
      const binding={workspaceId:'studio',taskId:task.id,unitId:'episode-plan',projectId:'p',chapterId:'c',
        sourceVersionId:'source-1',upstreamVersionIds:['bible-1']};
      const material={id:`evidence-${outcome}`,formatVersion:1,ruleVersion:'test-rule',binding,
        snapshot:{binding,responsibility:'platform',quoteId:'fixture-quote',priceVersion:'fixture-v1',reserved:7},
        execution:{binding,id:'execution',state:outcome==='succeeded'?'completed':outcome==='failed'?'invalid_response':'unknown',
          closed:outcome!=='unknown'},
        results:outcome==='succeeded'?[{binding,id:'candidate-1',executionId:'execution',original:true,persisted:true,
          validation:'passed',ruleVersion:'test-rule'}]:[],
        pricing:outcome==='succeeded'?{binding,id:'price',resultVersionId:'candidate-1',
          quoteId:'fixture-quote',priceVersion:'fixture-v1',origin:'quote',amount:5}:null};
      await evidence.append('studio',material);
      if (outcome==='succeeded') {
        await assert.rejects(settle('studio',task.id,'missing'),{code:'INVALID_EVIDENCE'});
        await evidence.append('studio',{...material,id:'other-price',pricing:{...material.pricing,quoteId:'wrong'},
          snapshot:{...material.snapshot,quoteId:'wrong'}});
        await assert.rejects(settle('studio',task.id,'other-price'),{code:'INVALID_EVIDENCE'});
        await evidence.append('studio',{...material,id:'wrong-result',results:[{...material.results[0],id:'other-candidate'}],
          pricing:{...material.pricing,resultVersionId:'other-candidate'}});
        await assert.rejects(settle('studio',task.id,'wrong-result'),{code:'INVALID_EVIDENCE'});
      }
      const [receipt,replay]=await Promise.all([settle('studio',task.id,material.id),settle('studio',task.id,material.id)]);
      assert.deepEqual(receipt,replay);
      if (outcome==='unknown') assert.equal(receipt.reason,'EXECUTION_UNKNOWN');
      const entries=(await ledger.entries(billingActor)).filter(entry=>entry.evidenceId===material.id);
      assert.deepEqual(entries.map(entry=>[entry.operation,entry.amount]),
        outcome==='succeeded'?[['consume',5],['release',2]]:outcome==='failed'?[['release',7]]:[]);
      const {units}=await ledger.task(billingActor,task.id);
      assert.equal(units[0]?.state,outcome==='succeeded'?'closed':outcome==='failed'?'released':'reconciling');
    }
    assert.equal((await ledger.balance(billingActor)).reserved,14);
  } finally {
    await workerPool?.end();
    await pool?.end();
    await admin.end();
  }
});
