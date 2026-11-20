import { createEpisodeFeishuAlertDelivery } from "../../api/src/episode-feishu-alert-delivery.ts";
import { createEpisodeFeishuAlertSender } from "../../api/src/episode-feishu-alert.ts";
import { createEpisodeFeishuAlertWorker } from "../../api/src/episode-feishu-alert-worker.ts";
import { createEpisodeReconciliationAlertReader } from "../../api/src/episode-reconciliation-alerts.ts";
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool } from 'pg';
import { createEpisodeReconciliationWorker } from "../../api/src/episode-reconciliation-worker.ts";
import { createEpisodeReconciliation } from "../../api/src/episode-reconciliation.ts";
import { createEpisodeEvidencePublisher } from "../../api/src/episode-evidence-publisher.ts";
import type { EpisodePlanVersion } from "../../script/src/index.ts";
import { createEpisodeSettlement } from '../../api/src/episode-settlement.ts';
import { PostgresEvidenceMaterialRepository } from '../src/postgres-evidence.ts';
import { CreditLedgerService } from '../src/index.ts';
import { PostgresCreditLedgerRepository } from '../src/postgres-ledger.ts';
import { ModelTaskService } from '../../script/src/model-tasks.ts';
import { InMemoryModelSettingsRepository, WorkspaceModelSettings } from '../../script/src/model-settings.ts';
import { PostgresEpisodeExecutionJournal } from '../../api/src/episode-execution-journal.ts';
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
  let reconciliationPool: Pool | undefined;
  try {
    assert.equal((await admin.query('show data_directory')).rows[0].data_directory,`${socket}/data`);
    assert.equal((await admin.query('show listen_addresses')).rows[0].listen_addresses,'');
    await admin.query('create role novel_app nologin; create role episode_submission login; create role episode_outbox_worker login; create role episode_reconciliation_worker login');
    for (const file of ['../migrations/0001_credit_ledger.sql','../migrations/0002_evidence_material.sql','../../script/migrations/0003_model_tasks.sql',
      '../../script/migrations/0004_model_task_results.sql','../../script/migrations/0005_model_task_recovery.sql',
      '../migrations/0003_episode_submission_outbox.sql','../migrations/0004_episode_outbox_consumer.sql','../migrations/0005_episode_execution_events.sql','../migrations/0006_episode_reconciliation.sql','../migrations/0007_episode_reconciliation_alert_reader.sql','../migrations/0008_episode_alert_delivery.sql']) {
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
    const journal=new PostgresEpisodeExecutionJournal(pool);
    let candidate: EpisodePlanVersion | null=null;
    const publisherOptions={repository,journal,ledgerRepository:new PostgresCreditLedgerRepository(pool),
      evidence,serviceId:billingActor.serviceId,workspaceIds:['studio'],ruleVersion:'test-rule',
      plans:{getEpisodePlanGeneration:async()=>candidate}};
    const publish=createEpisodeEvidencePublisher({...publisherOptions,assessSuccess:async()=>({
      quoteId:'fixture-quote',priceVersion:'fixture-v1',amount:5,
    })});
    for (const outcome of ['succeeded','failed','unknown'] as const) {
      const task=await submit(`settle-${outcome}`);
      const running=await repository.transition('studio',task.id,0,'running',null);
      if (outcome!=='unknown') await journal.record('studio',task.id,{kind:'dispatch_started'});
      if (outcome==='succeeded') await journal.record('studio',task.id,{kind:'completed',candidateId:'candidate-1'});
      else await journal.record('studio',task.id,{kind:outcome==='failed'?'invalid_response':'unknown'});
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
      if (outcome==='succeeded') {
        await assert.rejects(publish('studio',task.id),{code:'INVALID_EVIDENCE'});
        candidate={id:'candidate-1',parentVersionId:null,projectId:'p',chapterId:'c',sourceVersionId:'source-1',
          storyBibleVersionId:'bible-1',targetDurationSeconds:180,aspectRatio:'9:16',narrativeMode:'narration',
          generationJobId:task.id,episodes:[],majorAdaptationProposals:[],status:'candidate',createdBy:'owner',createdAt:'2026-11-20'};
        await assert.rejects(createEpisodeEvidencePublisher(publisherOptions)('studio',task.id),{code:'INVALID_EVIDENCE'});
        await assert.rejects(createEpisodeEvidencePublisher({...publisherOptions,assessSuccess:async()=>({
          quoteId:'wrong',priceVersion:'fixture-v1',amount:5,
        })})('studio',task.id),{code:'INVALID_EVIDENCE'});
      }
      const [publishedId,repeatedId]=await Promise.all([publish('studio',task.id),publish('studio',task.id)]);
      assert.equal(publishedId,repeatedId);
      const published=await evidence.get('studio',publishedId);
      assert.ok(published);
      assert.equal((published.material as {execution:{state:string}}).execution.state,material.execution.state);
      if (outcome==='succeeded') {
        await assert.rejects(createEpisodeEvidencePublisher({...publisherOptions,assessSuccess:async()=>({
          quoteId:'fixture-quote',priceVersion:'fixture-v1',amount:6,
        })})('studio',task.id),{code:'INVALID_EVIDENCE'});
        assert.deepEqual(await evidence.get('studio',publishedId),published);
        await assert.rejects(settle('studio',task.id,'missing'),{code:'INVALID_EVIDENCE'});
        await evidence.append('studio',{...material,id:'other-price',pricing:{...material.pricing,quoteId:'wrong'},
          snapshot:{...material.snapshot,quoteId:'wrong'}});
        await assert.rejects(settle('studio',task.id,'other-price'),{code:'INVALID_EVIDENCE'});
        await evidence.append('studio',{...material,id:'wrong-result',results:[{...material.results[0],id:'other-candidate'}],
          pricing:{...material.pricing,resultVersionId:'other-candidate'}});
        await assert.rejects(settle('studio',task.id,'wrong-result'),{code:'INVALID_EVIDENCE'});
      }
      const [receipt,replay]=await Promise.all([settle('studio',task.id,publishedId),settle('studio',task.id,publishedId)]);
      assert.deepEqual(receipt,replay);
      if (outcome==='unknown') assert.equal(receipt.reason,'EXECUTION_UNKNOWN');
      const entries=(await ledger.entries(billingActor)).filter(entry=>entry.evidenceId===publishedId);
      assert.deepEqual(entries.map(entry=>[entry.operation,entry.amount]),
        outcome==='succeeded'?[['consume',5],['release',2]]:outcome==='failed'?[['release',7]]:[]);
      const {units}=await ledger.task(billingActor,task.id);
      assert.equal(units[0]?.state,outcome==='succeeded'?'closed':outcome==='failed'?'released':'reconciling');
    }
    assert.equal((await ledger.balance(billingActor)).reserved,14);
    await repository.transition('studio',first.id,0,'running',null);
    await journal.record('studio',first.id,{kind:'dispatch_started'});
    await assert.rejects(journal.record('studio',first.id,{kind:'dispatch_started'}),{message:'EPISODE_EXECUTION_JOURNAL_UNAVAILABLE'});
    await assert.rejects(journal.record('studio',first.id,{kind:'not_sent'}),{message:'EPISODE_EXECUTION_JOURNAL_UNAVAILABLE'});
    await journal.record('studio',first.id,{kind:'invalid_response'});
    await repository.transition('studio',byok.id,0,'running',null);
    await journal.record('studio',byok.id,{kind:'not_sent'});
    await repository.transition('studio',byok.id,1,'failed','INVALID_RESPONSE');
    await repository.transition('studio',first.id,1,'failed','INVALID_RESPONSE');
    const missingJournal=await submit('missing-journal','byok');
    await repository.transition('studio',missingJournal.id,0,'running',null);
    await repository.transition('studio',missingJournal.id,1,'failed','INVALID_RESPONSE');
    const alerts: Array<{taskId:string;code:string}>=[];
    const reconciliationOptions={...publisherOptions,alert:async (notice:{taskId:string;code:string})=>{alerts.push(notice);}};
    const reconciliation=createEpisodeReconciliation(reconciliationOptions);
    await assert.rejects(reconciliation('other',{limit:1,cursor:null}),{code:'FORBIDDEN'});
    await assert.rejects(reconciliation('studio',{limit:51,cursor:null}),{code:'INVALID_CONTEXT'});
    const entriesBefore=await ledger.entries(billingActor);
    const firstPage=await reconciliation('studio',{limit:1,cursor:null});
    assert.equal(firstPage.items.length,1);
    assert.ok(firstPage.nextCursor);
    const resumed=createEpisodeReconciliation(reconciliationOptions);
    const rest=await resumed('studio',{limit:50,cursor:firstPage.nextCursor});
    assert.equal(rest.nextCursor,null);
    const scanned=[...firstPage.items,...rest.items];
    assert.equal(scanned.length,6);
    assert.equal(new Set(scanned.map(item=>item.taskId)).size,6);
    assert.ok(scanned.some(item=>item.taskId===byok.id && item.status==='exempt'));
    assert.ok(alerts.some(alert=>alert.code==='EXECUTION_UNKNOWN'));
    assert.ok(alerts.some(alert=>alert.code==='PLATFORM_SUCCESS_DISABLED'));
    assert.ok(alerts.some(alert=>alert.code==='INVALID_EVIDENCE' && alert.taskId===missingJournal.id));
    const entriesAfter=await ledger.entries(billingActor);
    assert.deepEqual(entriesAfter.slice(entriesBefore.length).map(entry=>[entry.taskId,entry.operation,entry.amount]),
      [[first.id,'release',7]]);
    const unreported=createEpisodeReconciliation({...reconciliationOptions,alert:async()=>{throw new Error('alert unavailable');}});
    await assert.rejects(unreported('studio',{limit:50,cursor:null}),{message:'alert unavailable'});
    await resumed('studio',{limit:50,cursor:null});
    assert.deepEqual(await ledger.entries(billingActor),entriesAfter);
    await admin.query('grant novel_episode_reconciliation to episode_reconciliation_worker');
    url.username='episode_reconciliation_worker';
    reconciliationPool=new Pool({connectionString:url.href,max:2});
    const workerOptions={...publisherOptions,pool:reconciliationPool,pageSize:1};
    const initialWorker=createEpisodeReconciliationWorker(workerOptions);
    assert.equal(initialWorker.worker.status().enabled,false);
    await initialWorker.worker.start();
    const checkpoint=async ()=>(await admin.query("select cursor from episode_reconciliation_checkpoints where workspace_id='studio'")).rows[0];
    assert.equal(await checkpoint(),undefined);
    const initial=await initialWorker.tick('studio');
    assert.equal(initial.items.length,1);
    assert.equal((await checkpoint()).cursor,initial.nextCursor);
    await initialWorker.worker.stop();

    await admin.query('alter table episode_reconciliation_alerts add constraint fixture_alert_failure check(false) not valid');
    const restarted=createEpisodeReconciliationWorker({...workerOptions,pageSize:50});
    try {
      await assert.rejects(restarted.tick('studio'),{message:'EPISODE_RECONCILIATION_STORE_UNAVAILABLE'});
      assert.equal((await checkpoint()).cursor,initial.nextCursor);
    } finally {
      await admin.query('alter table episode_reconciliation_alerts drop constraint fixture_alert_failure');
    }
    const continued=await restarted.tick('studio');
    assert.equal(continued.items.length,5);
    assert.equal(continued.nextCursor,null);
    const durableAlerts=async ()=>(await admin.query('select task_id,code from episode_reconciliation_alerts order by task_id,code')).rows;
    const storedAlerts=await durableAlerts();
    await admin.query(`create role episode_alert_reader login; grant novel_episode_alert_reader to episode_alert_reader;
      insert into episode_reconciliation_checkpoints(workspace_id) values('other');
      insert into episode_reconciliation_alerts(workspace_id,task_id,code) values('other','hidden','EXECUTION_UNKNOWN')`);
    url.username='episode_alert_reader';
    const readerPool=new Pool({connectionString:url.href,max:1});
    try {
      const list=createEpisodeReconciliationAlertReader(readerPool,{serviceId:'ops',workspaceIds:['studio']});
      const actor={serviceId:'ops',workspaceId:'studio'};
      await assert.rejects(list({...actor,workspaceId:'other'},{limit:1,cursor:null}),{message:'FORBIDDEN'});
      await assert.rejects(list({...actor,serviceId:'other'},{limit:1,cursor:null}),{message:'FORBIDDEN'});
      await assert.rejects(list(actor,{limit:51,cursor:null}),{message:'INVALID_CURSOR'});
      const page=await list(actor,{limit:1,cursor:null});
      assert.ok(page.nextCursor);
      const tail=await list(actor,{limit:50,cursor:page.nextCursor});
      assert.equal(tail.nextCursor,null);
      assert.deepEqual([...page.items,...tail.items].map(item=>({task_id:item.taskId,code:item.code})),storedAlerts);
      assert.deepEqual((await readerPool.query('select task_id from episode_reconciliation_alerts')).rows,[]);
      await assert.rejects(readerPool.query('delete from episode_reconciliation_alerts'),{code:'42501'});
      await assert.rejects(readerPool.query('select * from episode_reconciliation_checkpoints'),{code:'42501'});
    } finally { await readerPool.end(); }
    await admin.query("create role fixture_alert_delivery login; grant novel_episode_alert_delivery to fixture_alert_delivery");
    url.username='fixture_alert_delivery';
    const deliveryPool=new Pool({connectionString:url.href,max:3});
    try {
      let calls=0;
      const send=createEpisodeFeishuAlertDelivery(deliveryPool,['studio'],async ()=>{
        calls++;
        return calls===1?'retryable':calls===2?'delivered':'unknown';
      });
      await assert.rejects(send('other'),{message:'FORBIDDEN'});
      assert.equal(await send('studio'),'retryable');
      await admin.query("update episode_alert_deliveries set retry_at=clock_timestamp() where status='retryable'");
      const concurrent=await Promise.all([send('studio'),send('studio')]);
      assert.ok(concurrent.includes('delivered'));
      for (let attempt=0;attempt<3;attempt++) { if (!await send('studio')) break; }
      const deliveries=(await admin.query("select status,attempts from episode_alert_deliveries order by status")).rows;
      assert.deepEqual(deliveries,[{status:'delivered',attempts:2},{status:'unknown',attempts:1},{status:'unknown',attempts:1}]);
      assert.equal(await send('studio'),null);
      assert.equal(calls,4);
      assert.deepEqual((await deliveryPool.query('select task_id from episode_alert_deliveries')).rows,[]);
      await assert.rejects(deliveryPool.query('delete from episode_alert_deliveries'),{code:'42501'});
    } finally { await deliveryPool.end(); }
    await admin.query("insert into episode_reconciliation_checkpoints(workspace_id) values('interrupted'); insert into episode_reconciliation_alerts(workspace_id,task_id,code) values('interrupted','interrupted-before-send','EXECUTION_UNKNOWN')");
    const interrupted=spawnSync(process.execPath,['--input-type=module','--eval',`
      import { Pool } from ${JSON.stringify(import.meta.resolve('pg'))};
      import { createEpisodeFeishuAlertWorker } from ${JSON.stringify(new URL('../../api/src/episode-feishu-alert-worker.ts',import.meta.url).href)};
      const pool=new Pool({connectionString:process.argv[1],max:1});
      await createEpisodeFeishuAlertWorker({
        pool,workspaceIds:['interrupted'],enabled:true,
        send:async ()=>process.exit(73),
      }).start();
    `,url.href],{encoding:'utf8',timeout:5000});
    assert.ifError(interrupted.error);
    assert.equal(interrupted.status,73,interrupted.stderr);
    const interruptedDelivery=await admin.query("select status,attempts,retry_at from episode_alert_deliveries where workspace_id='interrupted' and task_id='interrupted-before-send'");
    assert.deepEqual(interruptedDelivery.rows,[{status:'unknown',attempts:1,retry_at:null}]);
    let workerSendCount=0;
    let timeoutRequests=0;
    let rejectedRequests=0;
    const fixtureWebhook='https://open.feishu.cn/open-apis/bot/v2/hook/00000000-0000-0000-0000-000000000000';
    const sendTimeout=createEpisodeFeishuAlertSender(
      fixtureWebhook,
      async ()=>{
        timeoutRequests++;
        throw new DOMException('Request timed out','TimeoutError');
      },
    );
    const sendRejected=createEpisodeFeishuAlertSender(fixtureWebhook,async ()=>{
      rejectedRequests++;
      return new Response(null,{status:403});
    });
    const workerPhases=[
      {name:'restart after process exit',taskId:'interrupted-before-send',status:'unknown',attempts:1,calls:0},
      {name:'initial start',taskId:'hidden',status:'delivered',attempts:1,calls:1},
      {name:'restart after delivery',taskId:'hidden',status:'delivered',attempts:1,calls:1},
      {name:'rate limited',taskId:'rate-limited',status:'retryable',attempts:1,calls:2},
      {name:'restart before retry',taskId:'rate-limited',status:'retryable',attempts:1,calls:2},
      {name:'restart after retry due',taskId:'rate-limited',status:'delivered',attempts:2,calls:3},
      ...[1,2,3,4,5].map(attempts=>({
        name:`continuous rate limit attempt ${attempts}`,taskId:'always-limited',
        status:attempts===5?'exhausted':'retryable',attempts,calls:3+attempts,
      })),
      {name:'restart after exhaustion',taskId:'always-limited',status:'exhausted',attempts:5,calls:8},
      {name:'request timeout',taskId:'timed-out',status:'unknown',attempts:1,calls:9},
      {name:'restart after timeout',taskId:'timed-out',status:'unknown',attempts:1,calls:9},
      {name:'request rejected',taskId:'rejected',status:'rejected',attempts:1,calls:10},
      {name:'restart after rejection',taskId:'rejected',status:'rejected',attempts:1,calls:10},
    ];
    for (const phase of workerPhases) {
      if (['rate limited','continuous rate limit attempt 1','request timeout','request rejected'].includes(phase.name)) {
        await admin.query("insert into episode_reconciliation_alerts(workspace_id,task_id,code) values('other',$1,'EXECUTION_UNKNOWN')",[phase.taskId]);
      }
      if (phase.name==='restart after retry due' || (phase.taskId==='always-limited' && phase.attempts>1 && phase.name!=='restart after exhaustion')) {
        await admin.query("update episode_alert_deliveries set retry_at=clock_timestamp() - interval '1 second' where workspace_id='other' and task_id=$1",[phase.taskId]);
      }
      const workspace=phase.taskId==='interrupted-before-send'?'interrupted':'other';
      const workerPool=new Pool({connectionString:url.href,max:1});
      const worker=createEpisodeFeishuAlertWorker({
        pool:workerPool,workspaceIds:[workspace],enabled:true,
        send:async alert=>{
          workerSendCount++;
          if (alert.taskId==='timed-out') return sendTimeout(alert);
          if (alert.taskId==='rejected') return sendRejected(alert);
          return alert.taskId==='always-limited' || workerSendCount===2?'retryable':'delivered';
        },
      });
      const running=worker.start();
      try {
        for (let attempt=0; attempt<100 && worker.status().backoffMs===0; attempt++) await delay(20);
        assert.ok(worker.status().lastScanAt,phase.name);
        assert.equal(worker.status().lastError,null,phase.name);
        assert.equal(workerSendCount,phase.calls,phase.name);
        const {rows}=await admin.query(
          "select status,attempts,retry_at>clock_timestamp() as waiting from episode_alert_deliveries where workspace_id=$1 and task_id=$2",
          [workspace,phase.taskId]);
        assert.deepEqual(rows,[{status:phase.status,attempts:phase.attempts,waiting:phase.status==='retryable'?true:null}],phase.name);
      } finally {
        try { await worker.stop(); await running; }
        finally { await workerPool.end(); }
      }
    }
    assert.equal(timeoutRequests,1);
    assert.equal(rejectedRequests,1);
    await admin.query("insert into episode_reconciliation_alerts(workspace_id,task_id,code) values('other','concurrent-delivery','EXECUTION_UNKNOWN')");
    const parallelPools=Array.from({length:2},()=>new Pool({connectionString:url.href,max:1}));
    const releaseSend=Promise.withResolvers<void>();
    let parallelSends=0;
    const parallelWorkers=parallelPools.map(pool=>createEpisodeFeishuAlertWorker({
      pool,workspaceIds:['other'],enabled:true,
      send:async ()=>{
        parallelSends++;
        await releaseSend.promise;
        return 'delivered';
      },
    }));
    const runningWorkers=parallelWorkers.map(worker=>worker.start());
    try {
      for (let attempt=0; attempt<100; attempt++) {
        if (parallelSends>1 || (parallelSends===1 && parallelWorkers.some(worker=>worker.status().backoffMs>0))) break;
        await delay(20);
      }
      assert.equal(parallelSends,1);
      assert.ok(parallelWorkers.some(worker=>worker.status().lastScanAt && worker.status().lastError===null));
      releaseSend.resolve();
      for (let attempt=0; attempt<100 && parallelWorkers.some(worker=>!worker.status().backoffMs); attempt++) await delay(20);
      for (const worker of parallelWorkers) {
        assert.ok(worker.status().backoffMs);
        assert.equal(worker.status().lastError,null);
      }
      assert.equal(parallelSends,1);
      const {rows}=await admin.query("select status,attempts from episode_alert_deliveries where workspace_id='other' and task_id='concurrent-delivery'");
      assert.deepEqual(rows,[{status:'delivered',attempts:1}]);
    } finally {
      releaseSend.resolve();
      try {await Promise.all(parallelWorkers.map(worker=>worker.stop())); await Promise.all(runningWorkers);}
      finally {await Promise.all(parallelPools.map(pool=>pool.end()));}
    }
    await admin.query("delete from episode_alert_deliveries where workspace_id in ('other','interrupted'); delete from episode_reconciliation_alerts where workspace_id in ('other','interrupted')");

    assert.deepEqual(new Set(storedAlerts.map(row=>row.code)),new Set(['EXECUTION_UNKNOWN','INVALID_EVIDENCE','PLATFORM_SUCCESS_DISABLED']));
    await restarted.tick('studio');
    assert.deepEqual(await durableAlerts(),storedAlerts);
    const concurrent=await Promise.all([initialWorker.tick('studio'),initialWorker.tick('studio')]);
    assert.equal(new Set(concurrent.map(page=>page.items[0]?.taskId)).size,2);
    assert.ok((await checkpoint()).cursor);
    const background=createEpisodeReconciliationWorker({...workerOptions,pageSize:50,enabled:true,intervalMs:100});
    const running=background.worker.start();
    try {
      for (let attempt=0; attempt<50 && (await checkpoint()).cursor!==null; attempt++) await delay(20);
      assert.equal((await checkpoint()).cursor,null);
    } finally {
      await background.worker.stop();
      await running;
    }
    assert.deepEqual(await durableAlerts(),storedAlerts);
    assert.deepEqual(await ledger.entries(billingActor),entriesAfter);
    assert.deepEqual((await reconciliationPool.query('select workspace_id from episode_reconciliation_alerts')).rows,[]);
    await assert.rejects(reconciliationPool.query('select * from credit_ledger_versions'),{code:'42501'});
    await assert.rejects(reconciliationPool.query('delete from episode_reconciliation_alerts'),{code:'42501'});

    const events=await admin.query('select kind from episode_execution_events where task_id in ($1,$2) order by kind',[first.id,byok.id]);
    assert.deepEqual(events.rows.map(row=>row.kind),['dispatch_started','invalid_response','not_sent']);
    await assert.rejects(pool.query('delete from episode_execution_events'),{code:'42501'});

    const successfulByok=await submit('successful-byok','byok');
    const executing=await repository.transition('studio',successfulByok.id,0,'running',null);
    candidate={
      id:'successful-byok-candidate',parentVersionId:null,projectId:'p',chapterId:'c',
      sourceVersionId:'source-1',storyBibleVersionId:'bible-1',targetDurationSeconds:180,
      aspectRatio:'9:16',narrativeMode:'narration',generationJobId:successfulByok.id,
      episodes:[],majorAdaptationProposals:[],status:'candidate',createdBy:'owner',createdAt:'2026-11-20',
    };
    await journal.record('studio',successfulByok.id,{kind:'dispatch_started'});
    await journal.record('studio',successfulByok.id,{kind:'completed',candidateId:candidate.id});
    await repository.transition('studio',successfulByok.id,executing.revision,'succeeded',null,
      {candidateVersionId:candidate.id,extractionStatus:'succeeded'});
    const reconciled=await restarted.tick('studio');
    assert.deepEqual(reconciled.items.find(item=>item.taskId===successfulByok.id),
      {taskId:successfulByok.id,status:'exempt'});
    assert.deepEqual(await durableAlerts(),storedAlerts);
  } finally {
    await reconciliationPool?.end();
    await workerPool?.end();
    await pool?.end();
    await admin.end();
  }
});
