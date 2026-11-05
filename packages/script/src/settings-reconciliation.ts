import { createHash } from "node:crypto";
import type { Actor,ProjectAccessReader } from "./index.ts";
import type { ConfirmedScriptHandoff } from "./script-handoff.ts";
import { SettingsReviewError,type SettingsReviewRepository,type SettingsVersion } from "./settings-review.ts";
import { validateSettingAsset } from "./settings-content.ts";
export type SettingsReconciliationCommand = { requestId: string;expectedActiveVersionId: string;expectedUpstreamConfirmedVersionIds: string[];reason: string } & ({ kind: "begin" } | { kind: "retain";assetId: string });
export class SettingsReconciliationService {
  private readonly options: { repository: SettingsReviewRepository;handoff: Pick<ConfirmedScriptHandoff,"read">;access: ProjectAccessReader;idGenerator(): string;clock(): Date };
  constructor(options: SettingsReconciliationService["options"]) { this.options = options; }
  private async access(a: Actor,p: string) {
    const found = await this.options.access.findProjectAccess(a,p);if (!found) throw new SettingsReviewError("NOT_FOUND");return found.role === "owner" || found.role === "reviewer";
  }
  async preview(a: Actor,p: string,c: string) {
    if (![p,c].every(id)) throw new SettingsReviewError("INVALID_COMMAND");
    const reviewer = await this.access(a,p),base = await this.options.repository.findActive(a,p,c);
    if (!base) throw new SettingsReviewError("NOT_FOUND");
    const formal = await this.options.handoff.read(a,p,c),ids = [formal.version.id,...formal.upstreamConfirmedVersionIds];
    const sameSource = base.sourceVersionId === formal.version.sourceVersionId,requiresReconciliation = !same(base.upstreamConfirmedVersionIds,ids);
    return { baseVersionId: base.id,sourceVersionId: formal.version.sourceVersionId,upstreamConfirmedVersionIds: ids,sameSource,requiresReconciliation,canBegin: reviewer && sameSource && requiresReconciliation };
  }
  async execute(a: Actor,p: string,c: string,input: SettingsReconciliationCommand): Promise<SettingsVersion> {
    const command = parse(input);
    if (![p,c].every(id)) throw new SettingsReviewError("INVALID_COMMAND");
    if (!await this.access(a,p)) throw new SettingsReviewError("FORBIDDEN");
    const fingerprint = createHash("sha256").update(JSON.stringify(command)).digest("hex"),repo = this.options.repository;
    const replay = await repo.findOperation(a,p,c,command.requestId);
    if (replay) { if (replay.operation?.fingerprint !== fingerprint) throw new SettingsReviewError("VERSION_CONFLICT");return replay; }
    const formal = await this.options.handoff.read(a,p,c),ids = [formal.version.id,...formal.upstreamConfirmedVersionIds];
    if (!same(command.expectedUpstreamConfirmedVersionIds,ids)) throw new SettingsReviewError("UPSTREAM_CHANGED");
    const base = await repo.findActive(a,p,c);
    if (!base) throw new SettingsReviewError("NOT_FOUND");
    if (base.id !== command.expectedActiveVersionId) throw new SettingsReviewError("VERSION_CONFLICT");
    if (base.sourceVersionId !== formal.version.sourceVersionId) throw new SettingsReviewError("UPSTREAM_CHANGED");
    const next = structuredClone(base);
    if (command.kind === "begin") {
      if (same(base.upstreamConfirmedVersionIds,ids)) throw new SettingsReviewError("INVALID_STATE");
      next.reconciliation = { originVersionId: base.id,pendingAssets: structuredClone([...base.assets,...(base.reconciliation?.pendingAssets ?? [])]),pendingFailureScopeKeys: base.failures.map(f => f.scopeKey) };
      next.assets = [];next.suggestions = [];next.status = "candidate";next.scriptVersionId = formal.version.id;next.upstreamConfirmedVersionIds = ids;
      delete next.confirmedAt;delete next.confirmedBy;delete next.regeneration;
      if (base.status === "confirmed") next.revisionOfVersionId = base.id;
    } else {
      if (!same(base.upstreamConfirmedVersionIds,ids)) throw new SettingsReviewError("UPSTREAM_CHANGED");
      const asset = base.reconciliation?.pendingAssets.find(v => v.id === command.assetId);
      if (base.status !== "candidate" || !asset) throw new SettingsReviewError("INVALID_STATE");
      if (!validateSettingAsset(asset,{ sourceVersionId: base.sourceVersionId,fragmentIds: formal.sourceFragments.map(f => f.id),approvedAdditionIds: [] })) throw new SettingsReviewError("INVALID_STATE");
      next.assets.push(structuredClone(asset));next.reconciliation!.pendingAssets = next.reconciliation!.pendingAssets.filter(v => v.id !== command.assetId);
    }
    next.id = this.options.idGenerator();next.createdBy = a.userId;next.createdAt = this.options.clock().toISOString();next.parentVersionId = base.id;
    next.operation = { requestId: command.requestId,fingerprint,kind: command.kind === "begin" ? "reconcile" : "retain",targetId: command.kind === "begin" ? base.id : command.assetId,reason: command.reason };
    return repo.save(a,next,base.id);
  }
}
function id(v: unknown): v is string { return typeof v === "string" && !!v.trim() && v.length<=256 && !/[\r\n]/.test(v); }
function same(a: readonly string[],b: readonly string[]) { return a.length===b.length && a.every((v,i) => v===b[i]); }
function parse(v: SettingsReconciliationCommand): SettingsReconciliationCommand {
  if (!v || typeof v!=="object" || Array.isArray(v) || ![v.requestId,v.expectedActiveVersionId].every(id) || typeof v.reason!=="string" || !v.reason.trim() || v.reason.length>2000
    || !Array.isArray(v.expectedUpstreamConfirmedVersionIds) || v.expectedUpstreamConfirmedVersionIds.length!==3 || !v.expectedUpstreamConfirmedVersionIds.every(id)
    || !["begin","retain"].includes(v.kind) || v.kind === "retain" && !id(v.assetId)
    || Object.keys(v).some(k => !["requestId","expectedActiveVersionId","expectedUpstreamConfirmedVersionIds","reason","kind",...(v.kind === "retain" ? ["assetId"] : [])].includes(k))) throw new SettingsReviewError("INVALID_COMMAND");
  return { requestId: v.requestId,expectedActiveVersionId: v.expectedActiveVersionId,expectedUpstreamConfirmedVersionIds: [...v.expectedUpstreamConfirmedVersionIds],reason: v.reason.trim(),kind: v.kind,...(v.kind === "retain" ? { assetId: v.assetId } : {}) } as SettingsReconciliationCommand;
}
