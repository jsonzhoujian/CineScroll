// Opt-in server assembly. The existing BYOK HTTP route does not install it.
import type { Pool } from 'pg';
import { CreditLedgerError, CreditLedgerService } from '../../billing/src/index.ts';
import { createInternalBillingAccess } from '../../billing/src/internal-access.ts';
import { ledgerOnConnection } from '../../billing/src/postgres-ledger.ts';
import { ModelTaskError, type ModelTask } from '../../script/src/model-tasks.ts';
import { insertModelTaskOnConnection, PostgresModelTaskRepository } from '../../script/src/postgres-model-tasks.ts';

type PlatformQuote = Readonly<{
  workspaceId: string; configurationVersionId: string; providerId: string; modelId: string;
  quoteId: string; priceVersion: string; reserved: number;
}>;

export function createEpisodeSubmissionRepository(pool: Pool, options: Readonly<{
  serviceId: string; workspaceIds: readonly string[]; platformQuotes: readonly PlatformQuote[];
}>): PostgresModelTaskRepository {
  const {serviceId,workspaceIds,platformQuotes}=structuredClone(options);
  const access=createInternalBillingAccess({serviceId,grants:workspaceIds.map(workspaceId=>({
    workspaceId,operations:['reserve'],
  }))});
  const quotes=new Map<string,PlatformQuote>();
  for (const quote of platformQuotes) {
    const key=JSON.stringify([quote.workspaceId,quote.configurationVersionId,quote.providerId,quote.modelId]);
    if (!workspaceIds.includes(quote.workspaceId) || quotes.has(key) || !Number.isSafeInteger(quote.reserved)
      || quote.reserved<=0 || ![quote.configurationVersionId,quote.providerId,quote.modelId,quote.quoteId,quote.priceVersion]
        .every(value=>typeof value==='string' && value.length>0 && value.length<=256
          && value.trim()===value && !/[\r\n]/.test(value) && value!=='*')) {
      throw new Error('EPISODE_QUOTE_CONFIG_INVALID');
    }
    quotes.set(key,quote);
  }
  return Object.assign(new PostgresModelTaskRepository(pool), {
    async insert(task: ModelTask): Promise<ModelTask> {
      if (task.input.resultType!=='episodePlan' || task.parentTaskId!==null) throw new ModelTaskError('INVALID_CONTEXT');
      const billingActor={workspaceId:task.workspaceId,serviceId};
      if (!await access.authorize(billingActor,'reserve')) throw new CreditLedgerError('FORBIDDEN');
      const quote=quotes.get(JSON.stringify([task.workspaceId,task.model.configurationVersionId,task.model.providerId,task.model.modelId]));
      const client=await pool.connect().catch(()=>{throw new ModelTaskError('STORAGE_UNAVAILABLE');});
      let committing=false;
      let discard=false;
      try {
        await client.query("begin; set local statement_timeout='5s'; set local lock_timeout='2s'");
        await client.query("select set_config('app.model_workspace_id',$1,true),set_config('app.billing_workspace_id',$1,true)",[task.workspaceId]);
        let inserted: ModelTask;
        try {
          inserted=await insertModelTaskOnConnection(client,{...task,dispatchOwner:"outbox"});
        } catch (error) {
          if (error && typeof error==='object' && 'code' in error && error.code==='23505') throw new ModelTaskError('STATE_CONFLICT');
          throw error;
        }
        const ledger=new CreditLedgerService({repository:ledgerOnConnection(client),clock:()=>new Date(),
          access});
        await ledger.reserve(billingActor,{
          eventId:task.id,taskId:task.id,projectId:task.projectId,chapterId:task.chapterId,
          sourceVersionId:task.input.sourceVersionId,quoteId:quote?.quoteId ?? 'byok',priceVersion:quote?.priceVersion ?? 'byok-v1',
          responsibility:quote ? 'platform' : 'byok',units:[{id:'episode-plan',reserved:quote?.reserved ?? 0}],
        });
        await client.query('insert into public.episode_submission_outbox(workspace_id,task_id) values($1,$2)',[task.workspaceId,task.id]);
        committing=true;
        if ((await client.query('commit')).command!=='COMMIT') throw new ModelTaskError('STORAGE_UNAVAILABLE');
        return inserted;
      } catch(error) {
        discard=committing;
        if (!committing) {
          try { await client.query('rollback'); } catch { discard=true; }
        }
        if (error instanceof CreditLedgerError || error instanceof ModelTaskError) throw error;
        throw new ModelTaskError('STORAGE_UNAVAILABLE');
      } finally { client.release(discard); }
    },
  });
}
