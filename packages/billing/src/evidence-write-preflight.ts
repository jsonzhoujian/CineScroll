import { canonicalEvidenceValue, prepareEvidenceMaterial } from "./evidence-material-repository.ts";

type Reference = Readonly<{ id: string; version: string }>;
export type EvidenceSourceReferences = Readonly<{ task: Reference; snapshot: Reference; execution: Reference;
  result: Reference | null; validation: Reference | null; pricing: Reference | null }>;
export type EvidenceWriteRequest = Readonly<{ requestId: string; references: EvidenceSourceReferences }>;
export type EvidenceWritePolicy = Readonly<{ serviceId: string; grants: ReadonlyArray<Readonly<{
  workspaceId: string; operations: ReadonlyArray<"publish" | "supplement">;
}>> }>;
/** Must attest complete immutable sources, not client/model claims. No production implementation supplied. */
export interface EvidenceWriteSource {
  load(workspaceId: string, references: EvidenceSourceReferences): Promise<unknown>;
  isCurrent(workspaceId: string, snapshotToken: string): Promise<boolean>;
  readPredecessor(workspaceId: string, evidenceId: string): Promise<unknown>;
}
export class EvidenceWritePreflightError extends Error {
  readonly code: "FORBIDDEN" | "INVALID_REQUEST" | "NOT_FOUND" | "UNAVAILABLE" | "CONFLICT";
  constructor(code: EvidenceWritePreflightError["code"]) { super(code); this.code = code; }
}
const validId = (value: unknown): value is string => typeof value === "string" && value.length>0 && value.length<=256
  && value.trim()===value && !/[\r\n]/.test(value) && !value.includes("://") && value!=="*";
function keys(value: unknown, expected: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Reflect.ownKeys(value).length===expected.length
    && expected.every(key => Object.hasOwn(value,key));
}
export function isEvidenceSourceReferences(value: unknown): value is EvidenceSourceReferences {
  if (!keys(value,["task","snapshot","execution","result","validation","pricing"])) return false;
  return ["task","snapshot","execution","result","validation","pricing"].every(key => {
    const ref = value[key];
    return ["result","validation","pricing"].includes(key) && ref===null
      || keys(ref,["id","version"]) && validId(ref.id) && validId(ref.version);
  });
}

/** Returns verified drafts only: no append, request deduplication or publication receipt. */
export function createEvidenceWritePreflight(options: { policy: EvidenceWritePolicy; source: EvidenceWriteSource }) {
  let policy: EvidenceWritePolicy;
  let load: EvidenceWriteSource["load"], current: EvidenceWriteSource["isCurrent"], predecessor: EvidenceWriteSource["readPredecessor"];
  try {
    policy = structuredClone(options.policy);
    if (!keys(policy,["serviceId","grants"]) || !validId(policy.serviceId) || !Array.isArray(policy.grants)
      || new Set(policy.grants.map(grant => grant?.workspaceId)).size!==policy.grants.length
      || !policy.grants.every(grant => keys(grant,["workspaceId","operations"]) && validId(grant.workspaceId)
        && Array.isArray(grant.operations) && grant.operations.length>0 && new Set(grant.operations).size===grant.operations.length
        && grant.operations.every(operation => operation==="publish" || operation==="supplement"))) throw new Error();
    load=options.source.load.bind(options.source); current=options.source.isCurrent.bind(options.source);
    predecessor=options.source.readPredecessor.bind(options.source);
  } catch { throw new Error("EVIDENCE_WRITE_CONFIG_INVALID"); }
  async function verify(workspaceId: string, input: EvidenceWriteRequest | (EvidenceWriteRequest & { predecessorId: string }), operation: "publish" | "supplement") {
    if (!validId(workspaceId) || !policy.grants.some(grant => grant.workspaceId===workspaceId && grant.operations.includes(operation))) throw new EvidenceWritePreflightError("FORBIDDEN");
    let request: EvidenceWriteRequest & { predecessorId?: string };
    try {
      request=structuredClone(input);
      if (!keys(request,operation==="publish" ? ["requestId","references"] : ["requestId","references","predecessorId"])
        || !validId(request.requestId) || !isEvidenceSourceReferences(request.references)
        || operation==="supplement" && !validId(request.predecessorId)) throw new Error();
    } catch { throw new EvidenceWritePreflightError("INVALID_REQUEST"); }
    let raw: unknown;
    try { raw=structuredClone(await load(workspaceId,structuredClone(request.references))); }
    catch { throw new EvidenceWritePreflightError("UNAVAILABLE"); }
    if (raw===null) throw new EvidenceWritePreflightError("NOT_FOUND");
    let material: Record<string, unknown>, token: string;
    try {
      if (!keys(raw,["material","references","snapshotToken","complete"]) || raw.complete!==true || !validId(raw.snapshotToken)
        || !isEvidenceSourceReferences(raw.references) || canonicalEvidenceValue(raw.references)!==canonicalEvidenceValue(request.references)) throw new Error();
      material=(await prepareEvidenceMaterial(workspaceId,raw.material,null)).material as Record<string,unknown>;
      token=raw.snapshotToken;
      const binding=material.binding as Record<string,unknown>, execution=material.execution as Record<string,unknown>;
      const results=material.results as Record<string,unknown>[], pricing=material.pricing as Record<string,unknown>|null;
      if (binding.taskId!==request.references.task.id || execution.id!==request.references.execution.id
        || (results.length===0 ? request.references.result!==null || request.references.validation!==null
          : request.references.result?.id!==results[0]!.id || request.references.validation===null)
        || (pricing===null ? request.references.pricing!==null : request.references.pricing?.id!==pricing.id)) throw new Error();
    } catch { throw new EvidenceWritePreflightError("CONFLICT"); }
    if (operation==="supplement") {
      let previous: unknown;
      try { previous=structuredClone(await predecessor(workspaceId,request.predecessorId!)); }
      catch { throw new EvidenceWritePreflightError("UNAVAILABLE"); }
      if (previous===null) throw new EvidenceWritePreflightError("NOT_FOUND");
      try {
        const old=(await prepareEvidenceMaterial(workspaceId,previous,null)).material as Record<string,unknown>;
        if (old.id!==request.predecessorId || old.id===material.id || canonicalEvidenceValue(old.binding)!==canonicalEvidenceValue(material.binding)
          || canonicalEvidenceValue(old.snapshot)!==canonicalEvidenceValue(material.snapshot)
          || (old.execution as Record<string,unknown>).id!==(material.execution as Record<string,unknown>).id) throw new Error();
      } catch { throw new EvidenceWritePreflightError("CONFLICT"); }
    }
    let unchanged: boolean;
    try { unchanged=await current(workspaceId,token); }
    catch { throw new EvidenceWritePreflightError("UNAVAILABLE"); }
    if (unchanged!==true) throw new EvidenceWritePreflightError("CONFLICT");
    return { requestId:request.requestId,material:structuredClone(material),predecessorId:request.predecessorId??null };
  }
  return Object.freeze({ verifyPublish:(workspaceId:string,request:EvidenceWriteRequest)=>verify(workspaceId,request,"publish"),
    verifySupplement:(workspaceId:string,request:EvidenceWriteRequest & { predecessorId:string })=>verify(workspaceId,request,"supplement") });
}
