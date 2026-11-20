import { validateTaskPage, type TaskPageRequest } from "@novel-adaptation/script/model-tasks";
import { CreditLedgerError, CreditLedgerService } from "../../billing/src/index.ts";
import type { EvidenceMaterialRepository } from "../../billing/src/evidence-material-repository.ts";
import { createInternalBillingAccess } from "../../billing/src/internal-access.ts";
import { createEpisodeEvidencePublisher } from "./episode-evidence-publisher.ts";
import type { PostgresEpisodeExecutionJournal } from "./episode-execution-journal.ts";
import { createEpisodeSettlement } from "./episode-settlement.ts";

type AlertCode = "PLATFORM_SUCCESS_DISABLED" | "EXECUTION_UNKNOWN" | "INVALID_EVIDENCE" | "RECONCILIATION_UNAVAILABLE";
type Alert = {workspaceId:string;taskId:string;code:AlertCode};
type Item = {taskId:string;status:"exempt"|"applied"|"reconciling"|"deferred";code?:AlertCode};
type PublicationOptions = Parameters<typeof createEpisodeEvidencePublisher>[0];

/** One bounded trial reconciliation page. The caller owns checkpoints and alert delivery. */
export function createEpisodeReconciliation(options:Omit<PublicationOptions,"assessSuccess"|"evidence"|"journal"> & {
  evidence:EvidenceMaterialRepository;
  journal:Pick<PostgresEpisodeExecutionJournal,"read"|"scanSettlementTasks">;
  alert(notice:Alert):Promise<void>;
}) {
  const {serviceId,ledgerRepository,evidence}=options;
  const workspaces=new Set(options.workspaceIds);
  const find=options.repository.find.bind(options.repository);
  const scan=options.journal.scanSettlementTasks.bind(options.journal);
  const alert=options.alert.bind(options);
  const access=createInternalBillingAccess({serviceId,grants:options.workspaceIds.map(workspaceId=>({workspaceId,operations:["read"]}))});
  const ledger=new CreditLedgerService({repository:ledgerRepository,access,clock:()=>new Date()});
  const publish=createEpisodeEvidencePublisher({
    ...options,
    assessSuccess:async (_candidate,snapshot)=>snapshot.responsibility==="byok"
      ? {quoteId:snapshot.quoteId,priceVersion:snapshot.priceVersion,amount:0} : null,
  });
  const settle=createEpisodeSettlement({...options,source:evidence});

  async function reconcile(workspaceId:string,taskId:string):Promise<Item> {
    try {
      const actor={workspaceId,serviceId};
      const task=await find(workspaceId,taskId);
      if (!task || task.workspaceId!==workspaceId || task.id!==taskId) throw new CreditLedgerError("INVALID_EVIDENCE");
      if (task.state==="succeeded" && (await ledger.task(actor,taskId)).snapshot.responsibility==="platform") {
        return {taskId,status:"deferred",code:"PLATFORM_SUCCESS_DISABLED"};
      }
      const evidenceId=await publish(workspaceId,taskId);
      const receipt=await settle(workspaceId,taskId,evidenceId);
      if (receipt.reason==="EXECUTION_UNKNOWN") return {taskId,status:receipt.status,code:"EXECUTION_UNKNOWN"};
      if (receipt.status==="exempt" && task.state!=="succeeded") {
        const record=await evidence.get(workspaceId,evidenceId);
        const material=record?.material as {execution?:{state?:string}} | undefined;
        if (material?.execution?.state==="unknown") return {taskId,status:"exempt",code:"EXECUTION_UNKNOWN"};
      }
      return {taskId,status:receipt.status};
    } catch (error) {
      const code=error instanceof CreditLedgerError
        && ["INVALID_EVIDENCE","STATE_CONFLICT","EVENT_CONFLICT","TASK_NOT_FOUND"].includes(error.code)
        ? "INVALID_EVIDENCE" : "RECONCILIATION_UNAVAILABLE";
      return {taskId,status:"deferred",code};
    }
  }

  return async (workspaceId:string,input:TaskPageRequest) => {
    if (!workspaces.has(workspaceId)) throw new CreditLedgerError("FORBIDDEN");
    const page=structuredClone(input);
    validateTaskPage(page);
    const {taskIds,nextCursor}=await scan(workspaceId,page);
    const items:Item[]=[];
    for (const taskId of taskIds) {
      const result=await reconcile(workspaceId,taskId);
      if (result.code) await alert({workspaceId,taskId,code:result.code});
      items.push(result);
    }
    return {items,nextCursor};
  };
}
