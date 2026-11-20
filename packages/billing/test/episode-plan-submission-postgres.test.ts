import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool } from 'pg';
import { CreditLedgerService } from '../src/index.ts';
import { PostgresCreditLedgerRepository } from '../src/postgres-ledger.ts';
import { ModelTaskService } from '../../script/src/model-tasks.ts';
import { InMemoryModelSettingsRepository, WorkspaceModelSettings } from '../../script/src/model-settings.ts';
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
  try {
    assert.equal((await admin.query('show data_directory')).rows[0].data_directory,`${socket}/data`);
    assert.equal((await admin.query('show listen_addresses')).rows[0].listen_addresses,'');
    await admin.query('create role novel_app nologin; create role episode_submission login');
    for (const file of ['../migrations/0001_credit_ledger.sql','../../script/migrations/0003_model_tasks.sql',
      '../../script/migrations/0004_model_task_results.sql','../../script/migrations/0005_model_task_recovery.sql',
      '../migrations/0003_episode_submission_outbox.sql']) {
      await admin.query(await readFile(new URL(file,import.meta.url),'utf8'));
    }
    await admin.query('grant novel_app,novel_billing,novel_episode_submission to episode_submission');
    url.username='episode_submission';
    pool=new Pool({connectionString:url.href,max:3});
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
    const service=new ModelTaskService({settings,repository:createEpisodeSubmissionRepository(pool,{
      serviceId:'episode-test',workspaceIds:['studio'],platformQuotes:[quote],
    }),
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
    await assert.rejects(pool.query('select * from public.episode_submission_outbox'),{code:'42501'});
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
  } finally {
    await pool?.end();
    await admin.end();
  }
});
