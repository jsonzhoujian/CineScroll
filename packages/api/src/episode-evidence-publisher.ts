import { createHash } from "node:crypto";
import type { EpisodePlanVersion, ScriptService } from "@novel-adaptation/script";
import type { ModelTaskRepository } from "@novel-adaptation/script/model-tasks";
import { CreditLedgerError, CreditLedgerService, type CreditLedgerRepository, type ReserveCommand } from "../../billing/src/index.ts";
import { canonicalEvidenceValue, type EvidenceMaterialRepository } from "../../billing/src/evidence-material-repository.ts";
import { createInternalBillingAccess } from "../../billing/src/internal-access.ts";
import type { PostgresEpisodeExecutionJournal } from "./episode-execution-journal.ts";

const key=(...values:string[])=>createHash("sha256").update(JSON.stringify(values)).digest("hex");
const invalid=()=>new CreditLedgerError("INVALID_EVIDENCE");
type Price = {quoteId:string;priceVersion:string;amount:number};

/** Internal publisher for one immutable task execution. Pricing and quality approval come from trusted server policy. */
export function createEpisodeEvidencePublisher(options:{
  repository:Pick<ModelTaskRepository,"find">;
  journal:Pick<PostgresEpisodeExecutionJournal,"read">;
  plans:Pick<ScriptService,"getEpisodePlanGeneration">;
  ledgerRepository:CreditLedgerRepository;
  evidence:Pick<EvidenceMaterialRepository,"append" | "get">;
  serviceId:string;
  workspaceIds:readonly string[];
  ruleVersion:string;
  assessSuccess?:(candidate:EpisodePlanVersion,snapshot:ReserveCommand)=>Promise<Price | null>;
}) {
  const {repository,journal,plans,ledgerRepository,evidence,serviceId,ruleVersion,assessSuccess}=options;
  const access=createInternalBillingAccess({serviceId,grants:options.workspaceIds.map(workspaceId=>({workspaceId,operations:["read"]}))});
  const ledger=new CreditLedgerService({repository:ledgerRepository,access,clock:()=>new Date()});
  const unitId="episode-plan";

  return async (workspaceId:string,taskId:string):Promise<string>=>{
    const {snapshot}=await ledger.task({workspaceId,serviceId},taskId);
    const task=await repository.find(workspaceId,taskId);
    const unit=snapshot.units[0];
    if (!task || task.id!==taskId || task.workspaceId!==workspaceId || task.dispatchOwner!=="outbox"
      || task.input.stage!=="script" || task.input.resultType!=="episodePlan" || task.state==="queued"
      || snapshot.projectId!==task.projectId || snapshot.chapterId!==task.chapterId
      || snapshot.sourceVersionId!==task.input.sourceVersionId || snapshot.units.length!==1 || unit?.id!==unitId) throw invalid();

    const binding={workspaceId,taskId,unitId,projectId:task.projectId,chapterId:task.chapterId,
      sourceVersionId:task.input.sourceVersionId,upstreamVersionIds:task.input.upstreamConfirmedVersionIds};
    const events=await journal.read(workspaceId,taskId);
    const kinds=new Set(events.map(event=>event.kind));
    const completed=events.find(event=>event.kind==="completed");
    const sent=kinds.has("dispatch_started");
    const notSent=kinds.has("not_sent");
    const invalidResponse=kinds.has("invalid_response");
    const uncertain=kinds.has("unknown");
    if ((notSent && sent) || (invalidResponse && !sent) || (completed && (notSent || invalidResponse))) throw invalid();

    const executionId="episode_exec_"+key(workspaceId,taskId,unitId);
    let state:"completed"|"invalid_response"|"not_sent"|"unknown";
    let results:unknown[]=[];
    let pricing:unknown=null;
    if (completed && task.state==="succeeded") {
      const candidate=await plans.getEpisodePlanGeneration({workspaceId,userId:task.createdBy},task.projectId,task.chapterId,taskId);
      if (!sent || !candidate || candidate.id!==completed.candidateId || task.result?.extractionStatus!=="succeeded"
        || task.result.candidateVersionId!==candidate.id || candidate.generationJobId!==taskId || candidate.status!=="candidate"
        || candidate.projectId!==task.projectId || candidate.chapterId!==task.chapterId
        || candidate.sourceVersionId!==binding.sourceVersionId || binding.upstreamVersionIds.length!==1
        || candidate.storyBibleVersionId!==binding.upstreamVersionIds[0]
        || candidate.targetDurationSeconds!==task.input.generationParameters.targetDurationSeconds
        || candidate.aspectRatio!==task.input.generationParameters.aspectRatio
        || candidate.narrativeMode!==task.input.generationParameters.narrativeMode) throw invalid();
      const price=await assessSuccess?.(structuredClone(candidate),structuredClone(snapshot));
      if (!price || price.quoteId!==snapshot.quoteId || price.priceVersion!==snapshot.priceVersion
        || !Number.isSafeInteger(price.amount) || price.amount<0 || (snapshot.responsibility==="byok" && price.amount!==0)) throw invalid();
      state="completed";
      results=[{binding,id:candidate.id,executionId,original:true,persisted:true,validation:"passed",ruleVersion}];
      pricing={binding,id:"episode_price_"+key(executionId,candidate.id),resultVersionId:candidate.id,
        quoteId:price.quoteId,priceVersion:price.priceVersion,origin:"quote",amount:price.amount};
    } else if (!completed && !uncertain && (task.state==="failed" || task.state==="paused" && task.reason!=="EXECUTION_UNCERTAIN")
      && (notSent || invalidResponse)) {
      state=notSent ? "not_sent" : "invalid_response";
    } else if (uncertain && task.state!=="succeeded") {
      state="unknown";
    } else throw invalid();

    const outcome=state==="completed" ? "succeeded" : state==="unknown" ? "unknown" : "failed";
    const id="episode_evidence_"+key(workspaceId,taskId,unitId,outcome);
    const material={id,formatVersion:1,ruleVersion,binding,
      snapshot:{binding,responsibility:snapshot.responsibility,quoteId:snapshot.quoteId,priceVersion:snapshot.priceVersion,reserved:unit.reserved},
      execution:{binding,id:executionId,state,closed:state!=="unknown"},results,pricing};
    const stored=await evidence.get(workspaceId,id);
    if (stored) {
      if (canonicalEvidenceValue(stored.material)!==canonicalEvidenceValue(material)) throw invalid();
      return id;
    }
    const unknownId="episode_evidence_"+key(workspaceId,taskId,unitId,"unknown");
    const predecessor=outcome!=="unknown" && await evidence.get(workspaceId,unknownId) ? unknownId : null;
    await evidence.append(workspaceId,material,predecessor);
    return id;
  };
}
