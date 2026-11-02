import { createHash } from "node:crypto";
import type { Actor, ProjectAccessReader } from "./index.ts";
import { ScriptContentError, ScriptContentService, type ScriptContentRepository, type ScriptContentVersion, type ScriptGenerationContext, type ScriptGenerationContextReader } from "./script-content.ts";
import { ScriptQualityEvaluator, type ScriptQualityModelPort, type ScriptQualityReport } from "./script-quality.ts";

export const SCRIPT_QUALITY_RULE_VERSION = "script-quality/1";
export type QualityBinding = { candidateVersionId: string;sourceVersionId: string;planVersionId: string;knowledgeVersionId: string;contextHash: string;ruleVersion: string };
export type PersistedScriptQualityReport = ScriptQualityReport & QualityBinding & { id: string;projectId: string;chapterId: string;createdBy: string;createdAt: string };
export type PublicationCommand = { requestId: string;expectedActiveVersionId: string;reason: string } & ({ kind: "confirm";reportId: string } | { kind: "lock";elementIds: string[] });
export type PublicationOperation = { requestId: string;fingerprint: string;kind: "confirm" | "lock";reason: string };
export function qualityBinding(version: ScriptContentVersion,context: ScriptGenerationContext): QualityBinding {
  return { candidateVersionId: version.id,sourceVersionId: version.sourceVersionId,planVersionId: version.planVersionId,
    knowledgeVersionId: context.confirmedStoryKnowledge?.versionId ?? "",ruleVersion: SCRIPT_QUALITY_RULE_VERSION,
    contextHash: createHash("sha256").update(JSON.stringify(context)).digest("hex") };
}
export function sameQualityBinding(a: QualityBinding,b: QualityBinding) { return (Object.keys(b) as Array<keyof QualityBinding>).every(k => a[k] === b[k]); }
/** Durable assessment and publication boundary. Confirmation never invokes or trusts client model verdicts. */
export class ScriptPublicationService {
  private readonly options: { repository: ScriptContentRepository;contextReader: ScriptGenerationContextReader;accessReader: ProjectAccessReader;content: ScriptContentService };
  constructor(options: ScriptPublicationService["options"]) { this.options = options; }
  private async read(actor: Actor,p: string,c: string,review: boolean) {
    const access = await this.options.accessReader.findProjectAccess(actor,p);
    if (!access || review && access.role === "editor") throw new ScriptContentError("FORBIDDEN","无权操作正式剧本");
    const context = await this.options.contextReader.findGenerationContext(actor,p,c);
    const version = await this.options.repository.findActive(actor,p,c);
    if (!context || !version || context.sourceVersionId !== version.sourceVersionId || context.planVersionId !== version.planVersionId) throw new ScriptContentError("CONTEXT_NOT_FOUND","上游已变化");
    return { version,context };
  }
  async target(actor: Actor,p: string,c: string) { const { version,context } = await this.read(actor,p,c,true); if (version.status !== "candidate") throw new ScriptContentError("INVALID_STATE","仅评估候选剧本"); return qualityBinding(version,context); }
  async report(actor: Actor,p: string,c: string,id: string) {
    const access = await this.options.accessReader.findProjectAccess(actor,p);
    if (!access) throw new ScriptContentError("FORBIDDEN","无权读取报告");
    if (!this.options.repository.findQualityReport) throw new ScriptContentError("STORAGE_UNAVAILABLE","报告存储未就绪");
    return this.options.repository.findQualityReport(actor,p,c,id);
  }
  async assess(actor: Actor,p: string,c: string,input: { jobId: string;binding: QualityBinding;model: ScriptQualityModelPort }) {
    const existing = await this.report(actor,p,c,input.jobId);
    if (existing) { if (!sameQualityBinding(existing,input.binding)) throw new ScriptContentError("VERSION_CONFLICT","报告任务不匹配"); return existing; }
    const { version,context } = await this.read(actor,p,c,true);
    if (version.status !== "candidate" || !sameQualityBinding(input.binding,qualityBinding(version,context))) throw new ScriptContentError("VERSION_CONFLICT","评估候选已变化");
    const report = await new ScriptQualityEvaluator({ context,model: input.model }).evaluate(version);
    const after = await this.read(actor,p,c,true);
    if (after.version.id !== version.id || !sameQualityBinding(input.binding,qualityBinding(after.version,after.context))) throw new ScriptContentError("VERSION_CONFLICT","评估期间候选已变化");
    if (!this.options.repository.saveQualityReport) throw new ScriptContentError("STORAGE_UNAVAILABLE","报告存储未就绪");
    return this.options.repository.saveQualityReport(actor,{ ...report,...input.binding,id: input.jobId,projectId: p,chapterId: c,createdBy: actor.userId,createdAt: new Date().toISOString() });
  }
  async execute(actor: Actor,p: string,c: string,command: PublicationCommand) {
    if (!command || typeof command !== "object" || !["confirm","lock"].includes(command.kind)
      || typeof command.reason !== "string" || !command.reason.trim() || command.reason.length > 2000
      || !identifier(command.requestId) || !identifier(command.expectedActiveVersionId)
      || Object.keys(command).some(k => !["kind","requestId","expectedActiveVersionId","reason",...(command.kind === "confirm" ? ["reportId"] : ["elementIds"])].includes(k))
      || (command.kind === "confirm" ? !identifier(command.reportId) : !Array.isArray(command.elementIds) || !command.elementIds.length || command.elementIds.length > 1000 || !command.elementIds.every(identifier) || new Set(command.elementIds).size !== command.elementIds.length)) throw new ScriptContentError("INVALID_EDIT","正式操作参数无效");
    const { version,context } = await this.read(actor,p,c,true), repository = this.options.repository;
    const normalized = command.kind === "confirm" ? [command.kind,command.expectedActiveVersionId,command.reason.trim(),command.reportId] : [command.kind,command.expectedActiveVersionId,command.reason.trim(),[...command.elementIds].sort()];
    const operation: PublicationOperation = { reason: command.reason.trim(),kind: command.kind,requestId: command.requestId,fingerprint: createHash("sha256").update(JSON.stringify(normalized)).digest("hex") };
    if (!repository.findPublicationOperation) throw new ScriptContentError("STORAGE_UNAVAILABLE","审计存储未就绪");
    const replay = await repository.findPublicationOperation(actor,p,c,command.requestId);
    if (replay) { if (replay.publicationOperation?.fingerprint !== operation.fingerprint) throw new ScriptContentError("VERSION_CONFLICT","请求已用于其他操作"); return replay; }
    if (version.id !== command.expectedActiveVersionId) throw new ScriptContentError("VERSION_CONFLICT","剧本已变化");
    const report = command.kind === "confirm" ? await this.report(actor,p,c,command.reportId) : null;
    if (command.kind === "confirm" && (!report?.passed || !sameQualityBinding(report,qualityBinding(version,context)))) throw new ScriptContentError("INVALID_CONFIRMATION","质量报告缺失、未通过或已过期");
    // Reuse domain transition rules with a scoped persistence gate and command audit.
    const service = this.options.content.withPublication({
      validate: async v => !!report?.passed && v.id === report.candidateVersionId,
      repository: { findActive: repository.findActive.bind(repository),save: (a,v,expected) => {
        const { reviewOperation: _review,publicationOperation: _prior,...clean } = v;
        return repository.save(a,{ ...clean,publicationOperation: operation,...(report ? { qualityReportId: report.id,qualityBinding: qualityBinding(version,context) } : {}) },expected);
      } },
    });
    try {
      const result = command.kind === "confirm" ? await service.confirmContent(actor,p,c,version.id) : await service.lockContent(actor,p,c,version.id,command.elementIds);
      if (result.createdBy !== actor.userId || result.publicationOperation?.requestId !== operation.requestId || result.publicationOperation.fingerprint !== operation.fingerprint) throw new ScriptContentError("VERSION_CONFLICT","其他操作已更新正式剧本，请重新读取");
      return result;
    }
    catch (error) {
      if (error instanceof ScriptContentError && ["VERSION_CONFLICT","STORAGE_UNAVAILABLE"].includes(error.code)) {
        const saved = await repository.findPublicationOperation(actor,p,c,command.requestId);
        if (saved?.publicationOperation?.fingerprint === operation.fingerprint) return saved;
      }
      throw error;
    }
  }
}
function identifier(value: unknown): value is string { return typeof value === "string" && !!value.trim() && value.length <= 256 && !/[\r\n]/.test(value); }
