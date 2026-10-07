import { createHash } from "node:crypto";
import { canonicalEvidenceValue, prepareEvidenceMaterial } from "./evidence-material-repository.ts";
import { isEvidenceSourceReferences, type EvidenceSourceReferences, type EvidenceWriteRequest } from "./evidence-write-preflight.ts";

const protocolVersion="evidence-publication-v1";
type Operation="publish"|"supplement";
type Identity={workspaceId:string;requestId:string;serviceId:string;operation:Operation;references:EvidenceSourceReferences;predecessorId:string|null};
export type PublicationAuditInput={references:EvidenceSourceReferences;sourceFingerprint:string;sourceSealId:string;verifiedAt:string};
export type PublicationPrepared={material:unknown;audit:PublicationAuditInput};
export type PublicationReceipt={protocolVersion:string;workspaceId:string;requestId:string;evidenceId:string;requestFingerprint:string;materialFingerprint:string;
  operation:Operation;predecessorId:string|null;auditId:string;publishedAt:string};
export type PublicationRecord={request:Identity & {fingerprint:string};material:unknown;audit:PublicationAuditInput & {serviceId:string;ruleVersion:string;auditId:string};receipt:PublicationReceipt};
export interface EvidencePublicationRepository {
  commit(input:Identity & PublicationPrepared & {publishedAt:string}):Promise<PublicationReceipt>;
  lookup(workspaceId:string,requestId:string):Promise<PublicationRecord|null>;
  get(workspaceId:string,evidenceId:string):Promise<PublicationRecord|null>;
}
export interface EvidencePublicationAccess {authorize(actor:{workspaceId:string;serviceId:string},operation:Operation):Promise<boolean>}
export class EvidencePublicationError extends Error {
  readonly code:"INVALID_PUBLICATION"|"FORBIDDEN"|"CONFLICT"|"PREDECESSOR_NOT_FOUND"|"UNAVAILABLE";
  constructor(code:EvidencePublicationError["code"]){super(code);this.code=code;}
}
const id=(value:unknown):value is string=>typeof value==="string" && value.length>0 && value.length<=256 && value.trim()===value && !/[\r\n]/.test(value) && !value.includes("://");
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
function exact(value:unknown,keys:string[]):value is Record<string,unknown>{return !!value && typeof value==="object" && !Array.isArray(value)
  && Reflect.ownKeys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));}
function validIdentity(value:unknown):value is Identity{
  if(!exact(value,["workspaceId","requestId","serviceId","operation","references","predecessorId"]))return false;
  return id(value.workspaceId)&&id(value.requestId)&&id(value.serviceId)&&isEvidenceSourceReferences(value.references)
    && (value.operation==="publish" && value.predecessorId===null || value.operation==="supplement" && id(value.predecessorId));
}
export function evidencePublicationId(workspaceId:string,requestId:string):string{
  if(!id(workspaceId)||!id(requestId))throw new EvidencePublicationError("INVALID_PUBLICATION");
  return `evp_${hash(JSON.stringify([protocolVersion,workspaceId,requestId]))}`;
}
export function evidencePublicationFingerprint(identity:Identity):string{
  if(!validIdentity(identity))throw new EvidencePublicationError("INVALID_PUBLICATION");
  return hash(canonicalEvidenceValue({protocolVersion,...identity}));
}
const timestamp=(value:unknown):value is string=>typeof value==="string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===value;

/** Trusted low-level rule fixture only; no durability, production source fence or member authorization. */
export class InMemoryEvidencePublicationRepository implements EvidencePublicationRepository {
  readonly #records=new Map<string,Map<string,PublicationRecord>>();
  async commit(input:Identity & PublicationPrepared & {publishedAt:string}):Promise<PublicationReceipt>{
    let identity:Identity,prepared:PublicationPrepared,publishedAt:string;
    try{
      const copy=structuredClone(input);
      if(!exact(copy,["workspaceId","requestId","serviceId","operation","references","predecessorId","material","audit","publishedAt"]))throw new Error();
      const {material,audit,publishedAt:time,...request}=copy;
      if(!validIdentity(request)||!timestamp(time)||!exact(audit,["references","sourceFingerprint","sourceSealId","verifiedAt"])
        ||!isEvidenceSourceReferences(audit.references)||canonicalEvidenceValue(audit.references)!==canonicalEvidenceValue(request.references)
        ||typeof audit.sourceFingerprint!=="string"||!/^[a-f0-9]{64}$/.test(audit.sourceFingerprint)||!id(audit.sourceSealId)||!timestamp(audit.verifiedAt))throw new Error();
      identity=request;prepared={material,audit};publishedAt=time;
    }catch{throw new EvidencePublicationError("INVALID_PUBLICATION");}
    const evidenceId=evidencePublicationId(identity.workspaceId,identity.requestId),requestFingerprint=evidencePublicationFingerprint(identity);
    let material:Record<string,unknown>,materialFingerprint:string;
    try{
      if(!prepared.material||typeof prepared.material!=="object"||Array.isArray(prepared.material))throw new Error();
      const checked=await prepareEvidenceMaterial(identity.workspaceId,{...prepared.material,id:evidenceId},identity.predecessorId);
      material=checked.material as Record<string,unknown>;materialFingerprint=checked.fingerprint;
      const binding=material.binding as Record<string,unknown>,execution=material.execution as Record<string,unknown>;
      const results=material.results as Record<string,unknown>[],pricing=material.pricing as Record<string,unknown>|null;
      if(binding.taskId!==identity.references.task.id||execution.id!==identity.references.execution.id
        ||(results.length===0?identity.references.result!==null||identity.references.validation!==null
          :identity.references.result?.id!==results[0]!.id||identity.references.validation===null)
        ||(pricing===null?identity.references.pricing!==null:identity.references.pricing?.id!==pricing.id))throw new Error();
    }catch{throw new EvidencePublicationError("INVALID_PUBLICATION");}
    const records=this.#records.get(identity.workspaceId)??new Map<string,PublicationRecord>();
    const existing=records.get(identity.requestId);
    if(existing){
      if(existing.request.fingerprint!==requestFingerprint||existing.receipt.materialFingerprint!==materialFingerprint
        ||existing.audit.sourceFingerprint!==prepared.audit.sourceFingerprint||existing.audit.sourceSealId!==prepared.audit.sourceSealId)throw new EvidencePublicationError("CONFLICT");
      return structuredClone(existing.receipt);
    }
    if(identity.predecessorId!==null){
      if(identity.predecessorId===evidenceId)throw new EvidencePublicationError("CONFLICT");
      const previous=[...records.values()].find(record=>record.receipt.evidenceId===identity.predecessorId);
      if(!previous)throw new EvidencePublicationError("PREDECESSOR_NOT_FOUND");
      const old=previous.material as Record<string,unknown>;
      if(canonicalEvidenceValue(old.binding)!==canonicalEvidenceValue(material.binding)||canonicalEvidenceValue(old.snapshot)!==canonicalEvidenceValue(material.snapshot)
        ||(old.execution as Record<string,unknown>).id!==(material.execution as Record<string,unknown>).id)throw new EvidencePublicationError("CONFLICT");
    }
    const auditId=`audit_${hash(JSON.stringify([protocolVersion,identity.workspaceId,identity.requestId]))}`;
    const receipt:PublicationReceipt={protocolVersion,workspaceId:identity.workspaceId,requestId:identity.requestId,evidenceId,requestFingerprint,materialFingerprint,
      operation:identity.operation,predecessorId:identity.predecessorId,auditId,publishedAt};
    const record:PublicationRecord={request:{...identity,fingerprint:requestFingerprint},material,audit:{...prepared.audit,serviceId:identity.serviceId,ruleVersion:material.ruleVersion as string,auditId},receipt};
    // One synchronous replacement stores all four objects; no observable partial publication.
    records.set(identity.requestId,record);this.#records.set(identity.workspaceId,records);
    return structuredClone(receipt);
  }
  async lookup(workspaceId:string,requestId:string):Promise<PublicationRecord|null>{return structuredClone(this.#records.get(workspaceId)?.get(requestId)??null);}
  async get(workspaceId:string,evidenceId:string):Promise<PublicationRecord|null>{return structuredClone([...this.#records.get(workspaceId)?.values()??[]].find(record=>record.receipt.evidenceId===evidenceId)??null);}
}

/** Testing service only: prepare is a trusted sealed-source fixture, never an HTTP payload or production point-in-time draft. */
export class EvidencePublicationService {
  readonly #serviceId:string;readonly #authorize:EvidencePublicationAccess["authorize"];readonly #lookup:EvidencePublicationRepository["lookup"];
  readonly #commit:EvidencePublicationRepository["commit"];readonly #prepare:(workspaceId:string,request:EvidenceWriteRequest & {predecessorId?:string},operation:Operation)=>Promise<PublicationPrepared>;
  readonly #clock:()=>Date;
  constructor(options:{serviceId:string;access:EvidencePublicationAccess;repository:EvidencePublicationRepository;
    prepare:(workspaceId:string,request:EvidenceWriteRequest & {predecessorId?:string},operation:Operation)=>Promise<PublicationPrepared>;clock:()=>Date}){
    try{
      if(!id(options.serviceId)||typeof options.prepare!=="function"||typeof options.clock!=="function")throw new Error();
      this.#serviceId=options.serviceId;this.#authorize=options.access.authorize.bind(options.access);
      this.#lookup=options.repository.lookup.bind(options.repository);this.#commit=options.repository.commit.bind(options.repository);
      this.#prepare=options.prepare;this.#clock=options.clock;
    }catch{throw new EvidencePublicationError("INVALID_PUBLICATION");}
  }
  async #authorized(workspaceId:string,operation:Operation){
    try{if(!id(workspaceId)||(operation!=="publish"&&operation!=="supplement")||await this.#authorize({workspaceId,serviceId:this.#serviceId},operation)!==true)throw new Error();}
    catch{throw new EvidencePublicationError("FORBIDDEN");}
  }
  async lookup(workspaceId:string,requestId:string,operation:Operation):Promise<PublicationReceipt|null>{
    await this.#authorized(workspaceId,operation);
    if(!id(requestId))throw new EvidencePublicationError("INVALID_PUBLICATION");
    let record:PublicationRecord|null;try{record=await this.#lookup(workspaceId,requestId);}catch{throw new EvidencePublicationError("UNAVAILABLE");}
    if(record&&(record.request.serviceId!==this.#serviceId||record.request.operation!==operation))throw new EvidencePublicationError("FORBIDDEN");
    return record?structuredClone(record.receipt):null;
  }
  publish(workspaceId:string,request:EvidenceWriteRequest){return this.#publish(workspaceId,request,"publish");}
  supplement(workspaceId:string,request:EvidenceWriteRequest & {predecessorId:string}){return this.#publish(workspaceId,request,"supplement");}
  async #publish(workspaceId:string,input:EvidenceWriteRequest & {predecessorId?:string},operation:Operation){
    let request:typeof input;try{request=structuredClone(input);}catch{throw new EvidencePublicationError("INVALID_PUBLICATION");}
    await this.#authorized(workspaceId,operation);
    if(!exact(request,operation==="publish"?["requestId","references"]:["requestId","references","predecessorId"]))throw new EvidencePublicationError("INVALID_PUBLICATION");
    const identity:Identity={workspaceId,serviceId:this.#serviceId,operation,requestId:request.requestId,references:request.references,predecessorId:request.predecessorId??null};
    const fingerprint=evidencePublicationFingerprint(identity);
    let existing:PublicationRecord|null;try{existing=await this.#lookup(workspaceId,request.requestId);}catch{throw new EvidencePublicationError("UNAVAILABLE");}
    if(existing){if(existing.request.fingerprint!==fingerprint)throw new EvidencePublicationError("CONFLICT");return structuredClone(existing.receipt);}
    try{
      const prepared=structuredClone(await this.#prepare(workspaceId,structuredClone(request),operation));
      if(!exact(prepared,["material","audit"]))throw new EvidencePublicationError("INVALID_PUBLICATION");
      return await this.#commit({...identity,...prepared,publishedAt:this.#clock().toISOString()});
    }catch(error){if(error instanceof EvidencePublicationError)throw error;throw new EvidencePublicationError("UNAVAILABLE");}
  }
}
