import { createHash } from "node:crypto";
import type { Actor,ProjectAccessReader } from "./index.ts";
import { ScriptContentError,type ScriptContentRepository,type ScriptGenerationContextReader,type ScriptContentVersion } from "./script-content.ts";
export type ScriptRevisionCommand = { requestId: string;expectedActiveVersionId: string;reason: string } & ({ kind: "suggest";elementId: string;text: string } | { kind: "unlock";elementId: string } | { kind: "decide";suggestionId: string;decision: "accepted" | "rejected" });
export type ScriptRevisionOperation = { requestId: string;fingerprint: string;kind: ScriptRevisionCommand["kind"];targetId: string;reason: string };
/** Formal revision commands always derive immutable successors and preserve the formal source. */
export class ScriptRevisionService {
  private readonly options: { repository: ScriptContentRepository;contextReader: ScriptGenerationContextReader;accessReader: ProjectAccessReader;idGenerator(): string;clock(): Date };
  constructor(options: ScriptRevisionService["options"]) { this.options = options; }
  async execute(actor: Actor,p: string,c: string,input: ScriptRevisionCommand) {
    if (!input || typeof input !== "object" || !["suggest","unlock","decide"].includes(input.kind) || !id(input.requestId) || !id(input.expectedActiveVersionId) || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 2000
      || Object.keys(input).some(k => !["kind","requestId","expectedActiveVersionId","reason",...(input.kind === "suggest" ? ["elementId","text"] : input.kind === "unlock" ? ["elementId"] : ["suggestionId","decision"])].includes(k))
      || (input.kind === "decide" ? !id(input.suggestionId) || !["accepted","rejected"].includes(input.decision) : !id(input.elementId))
      || input.kind === "suggest" && (typeof input.text !== "string" || !input.text.trim() || input.text.length > 20000)) throw new ScriptContentError("INVALID_EDIT","修订命令无效");
    const access = await this.options.accessReader.findProjectAccess(actor,p);
    if (!access || input.kind !== "suggest" && access.role === "editor") throw new ScriptContentError("FORBIDDEN","无权处理正式修订");
    const context = await this.options.contextReader.findGenerationContext(actor,p,c);
    if (!context) throw new ScriptContentError("CONTEXT_NOT_FOUND","上游已变化");
    const normalized = input.kind === "suggest" ? [input.kind,input.expectedActiveVersionId,input.reason.trim(),input.elementId,input.text.trim()] : input.kind === "unlock" ? [input.kind,input.expectedActiveVersionId,input.reason.trim(),input.elementId] : [input.kind,input.expectedActiveVersionId,input.reason.trim(),input.suggestionId,input.decision];
    const operation: ScriptRevisionOperation = { requestId: input.requestId,kind: input.kind,targetId: input.kind === "decide" ? input.suggestionId : input.elementId,reason: input.reason.trim(),fingerprint: createHash("sha256").update(JSON.stringify(normalized)).digest("hex") };
    const repository = this.options.repository;
    if (!repository.findRevisionOperation) throw new ScriptContentError("STORAGE_UNAVAILABLE","修订存储未就绪");
    const replay = await repository.findRevisionOperation(actor,p,c,input.requestId);
    if (replay) { if (replay.revisionOperation?.fingerprint !== operation.fingerprint) throw new ScriptContentError("VERSION_CONFLICT","请求内容不一致");return replay; }
    const current = await repository.findActive(actor,p,c);
    if (!current || current.sourceVersionId !== context.sourceVersionId || current.planVersionId !== context.planVersionId) throw new ScriptContentError("CONTEXT_NOT_FOUND","正式依据已变化");
    if (current.id !== input.expectedActiveVersionId) throw new ScriptContentError("VERSION_CONFLICT","剧本已变化");
    if (current.status !== "confirmed") throw new ScriptContentError("INVALID_STATE","请先完成当前修订候选");
    const { publicationOperation: _publication,reviewOperation: _review,revisionOperation: _revision,...base } = current;
    const at = this.options.clock().toISOString();
    let next: ScriptContentVersion = { ...base,id: this.options.idGenerator(),parentVersionId: current.id,createdBy: actor.userId,createdAt: at,revisionOperation: operation };
    if (input.kind === "suggest") {
      const element = current.elements.find(e => e.id === input.elementId);
      if (!element) throw new ScriptContentError("ELEMENT_NOT_FOUND","目标不存在");
      if (element.lockedAt) throw new ScriptContentError("INVALID_STATE","请先明确解锁");
      next = { ...next,suggestions: [...(current.suggestions ?? []),{ id: this.options.idGenerator(),elementId: element.id,baseVersionId: current.id,baseText: element.text,text: input.text.trim(),reason: input.reason.trim(),submittedBy: actor.userId,submittedAt: at,status: "pending" }] };
    } else if (input.kind === "unlock") {
      if (!current.elements.some(e => e.id === input.elementId)) throw new ScriptContentError("ELEMENT_NOT_FOUND","目标不存在");
      next = { ...next,elements: current.elements.map(e => { if (e.id !== input.elementId) return e;const { lockedAt: _at,lockedBy: _by,...unlocked } = e;return unlocked; }) };
    } else {
      const suggestion = current.suggestions?.find(s => s.id === input.suggestionId);
      if (!suggestion || suggestion.status !== "pending" || !suggestion.baseVersionId) throw new ScriptContentError("SUGGESTION_CONFLICT","建议不存在或已处理");
      const element = current.elements.find(e => e.id === suggestion.elementId);
      if (!element || element.text !== suggestion.baseText || element.lockedAt) throw new ScriptContentError("SUGGESTION_CONFLICT","目标已变化或锁定");
      next = { ...next,suggestions: current.suggestions!.map(s => s.id === suggestion.id ? { ...s,status: input.decision,decidedBy: actor.userId,decidedAt: at } : s) };
      if (input.decision === "accepted") {
        const { confirmedBy: _by,confirmedAt: _at,confirmationCandidateVersionId: _candidate,qualityReportId: _report,qualityBinding: _binding,...candidate } = next;
        next = { ...candidate,status: "candidate",revisionOfVersionId: current.id,elements: current.elements.map(e => e.id === suggestion.elementId ? { ...e,text: suggestion.text,lastEdit: { editedBy: actor.userId,editedAt: at,reason: input.reason.trim() } } : e) };
      }
    }
    try { return await repository.save(actor,next,current.id); }
    catch (error) { if (error instanceof ScriptContentError && ["VERSION_CONFLICT","STORAGE_UNAVAILABLE"].includes(error.code)) { const saved = await repository.findRevisionOperation(actor,p,c,input.requestId);if (saved?.revisionOperation?.fingerprint === operation.fingerprint) return saved; }throw error; }
  }
}
function id(v: unknown): v is string { return typeof v === "string" && !!v.trim() && v.length <= 256 && !/[\r\n]/.test(v); }
