import { createHash } from "node:crypto";
import type { ModelTaskRepository } from "@novel-adaptation/script/model-tasks";
import { CreditLedgerError, CreditLedgerService, type CreditLedgerRepository } from "../../billing/src/index.ts";
import { canonicalEvidenceValue } from "../../billing/src/evidence-material-repository.ts";
import { createInternalBillingAccess } from "../../billing/src/internal-access.ts";
import { createVerifiedSettlementEvidenceReader, type EvidenceMaterialSource } from "../../billing/src/verified-evidence.ts";

const unitId = "episode-plan";

/** Internal application of a published immutable record. The publisher owns proof of execution and pricing. */
export function createEpisodeSettlement(options: {
  repository: Pick<ModelTaskRepository,"find">;
  ledgerRepository: CreditLedgerRepository;
  source: EvidenceMaterialSource;
  serviceId: string;
  workspaceIds: readonly string[];
}) {
  const {serviceId,ledgerRepository}=options;
  const find=options.repository.find.bind(options.repository);
  const read=options.source.read.bind(options.source);
  const access=createInternalBillingAccess({serviceId,grants:options.workspaceIds.map(workspaceId=>({
    workspaceId,operations:["read","settle"],
  }))});
  const ledger=new CreditLedgerService({repository:ledgerRepository,access,clock:()=>new Date()});

  return async (workspaceId: string,taskId: string,evidenceId: string) => {
    const actor={workspaceId,serviceId};
    const {snapshot}=await ledger.task(actor,taskId);
    const task=await find(workspaceId,taskId);
    const unit=snapshot.units.find(unit=>unit.id===unitId);
    if (!task || task.workspaceId!==workspaceId || task.id!==taskId || task.dispatchOwner!=="outbox"
      || task.input.stage!=="script" || task.input.resultType!=="episodePlan" || task.state==="queued"
      || snapshot.projectId!==task.projectId || snapshot.chapterId!==task.chapterId
      || snapshot.sourceVersionId!==task.input.sourceVersionId || snapshot.units.length!==1 || !unit) {
      throw new CreditLedgerError("INVALID_EVIDENCE");
    }
    const binding={workspaceId,taskId,unitId,projectId:task.projectId,chapterId:task.chapterId,
      sourceVersionId:task.input.sourceVersionId,upstreamVersionIds:task.input.upstreamConfirmedVersionIds};
    const fixedSnapshot={binding,responsibility:snapshot.responsibility,quoteId:snapshot.quoteId,
      priceVersion:snapshot.priceVersion,reserved:unit.reserved};
    const verified=createVerifiedSettlementEvidenceReader({access,source:{
      async read(workspace,id) {
        const material=structuredClone(await read(workspace,id));
        if (!material || typeof material!=="object"
          || !("binding" in material) || !("snapshot" in material)
          || canonicalEvidenceValue(material.binding)!==canonicalEvidenceValue(binding)
          || canonicalEvidenceValue(material.snapshot)!==canonicalEvidenceValue(fixedSnapshot)) {
          throw new CreditLedgerError("INVALID_EVIDENCE");
        }
        return material;
      },
    }});
    const applyingLedger=new CreditLedgerService({repository:ledgerRepository,access,clock:()=>new Date(),evidenceReader:{
      async read(caller,id) {
        const evidence=await verified.read(caller,id);
        if (evidence.outcome==="succeeded" && (task.state!=="succeeded" || task.result?.extractionStatus!=="succeeded"
          || task.result.candidateVersionId!==evidence.resultVersionId)) throw new CreditLedgerError("INVALID_EVIDENCE");
        if (evidence.outcome==="failed" && task.state!=="failed"
          && !(task.state==="paused" && task.reason!=="EXECUTION_UNCERTAIN")) throw new CreditLedgerError("INVALID_EVIDENCE");
        return evidence;
      },
    }});
    const eventId="episode_settle_"+createHash("sha256").update(JSON.stringify([workspaceId,taskId,unitId,evidenceId])).digest("hex");
    return applyingLedger.settle(actor,{eventId,taskId,unitId,evidenceId});
  };
}
