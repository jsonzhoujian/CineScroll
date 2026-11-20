// Isolated composition of the real task and ledger repositories with a synthetic quote.
import type { Pool } from 'pg';
import { CreditLedgerError, CreditLedgerService } from '../../src/index.ts';
import { ledgerOnConnection } from '../../src/postgres-ledger.ts';
import { ModelTaskError, type ModelTask } from '../../../script/src/model-tasks.ts';
import { insertModelTaskOnConnection, PostgresModelTaskRepository } from '../../../script/src/postgres-model-tasks.ts';

export function isolatedEpisodeSubmissionRepository(pool: Pool): PostgresModelTaskRepository {
  return Object.assign(new PostgresModelTaskRepository(pool), {
    async insert(task: ModelTask): Promise<ModelTask> {
      if (task.input.resultType!=='episodePlan' || task.parentTaskId!==null) throw new ModelTaskError('INVALID_CONTEXT');
      const client=await pool.connect().catch(()=>{throw new ModelTaskError('STORAGE_UNAVAILABLE');});
      let committing=false;
      let discard=false;
      try {
        await client.query("begin; set local statement_timeout='5s'; set local lock_timeout='2s'");
        await client.query("select set_config('app.model_workspace_id',$1,true),set_config('app.billing_workspace_id',$1,true)",[task.workspaceId]);
        let inserted: ModelTask;
        try {
          inserted=await insertModelTaskOnConnection(client,task);
        } catch (error) {
          if (error && typeof error==='object' && 'code' in error && error.code==='23505') throw new ModelTaskError('STATE_CONFLICT');
          throw error;
        }
        const ledger=new CreditLedgerService({repository:ledgerOnConnection(client),clock:()=>new Date(),
          access:{authorize:async(actor,operation)=>actor.workspaceId===task.workspaceId && operation==='reserve'}});
        await ledger.reserve({workspaceId:task.workspaceId,serviceId:'episode-test'},{
          eventId:task.id,taskId:task.id,projectId:task.projectId,chapterId:task.chapterId,
          sourceVersionId:task.input.sourceVersionId,quoteId:'fixture-quote',priceVersion:'fixture-v1',
          responsibility:'platform',units:[{id:'episode-plan',reserved:7}],
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
