import { createHash } from "node:crypto";
import type { Actor,ProjectAccessReader } from "./index.ts";
import type { ConfirmedScriptHandoff } from "./script-handoff.ts";
import { SettingsReviewError,type SettingsReviewRepository,type SettingsVersion } from "./settings-review.ts";
import { validateSettingAsset } from "./settings-content.ts";
export type SettingsReconciliationCommand = { requestId: string;expectedActiveVersionId: string;expectedUpstreamConfirmedVersionIds: string[];reason: string } & ({ kind: "begin" } | { kind: "retain" | "unlock";assetId: string } | { kind: "repair";assetId: string;value: unknown } | { kind: "resolveFailure";failureScopeKey: string });
export class SettingsReconciliationService {
  private readonly options: { repository: SettingsReviewRepository;handoff: Pick<ConfirmedScriptHandoff,"read">;access: ProjectAccessReader;readEvidence?(a: Actor,p: string,c: string): Promise<readonly { id: string;fragments: readonly { id: string;text: string;contentHash: string }[] }[]>;idGenerator(): string;clock(): Date };
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
    return { baseVersionId: base.id,sourceVersionId: formal.version.sourceVersionId,upstreamConfirmedVersionIds: ids,sameSource,requiresReconciliation,canBegin: reviewer && (sameSource || !!this.options.readEvidence) && requiresReconciliation };
  }
  async execute(a: Actor,p: string,c: string,input: SettingsReconciliationCommand): Promise<SettingsVersion> {
    const command = parse(input);
    if (![p,c].every(id)) throw new SettingsReviewError("INVALID_COMMAND");
    if (!await this.access(a,p)) throw new SettingsReviewError("FORBIDDEN");
    let fingerprint: string;
    try { fingerprint = createHash("sha256").update(JSON.stringify(command, (_key,value) => command.kind === "repair" && value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)) : value)).digest("hex"); }
    catch { throw new SettingsReviewError("INVALID_COMMAND"); }
    const repo = this.options.repository;
    const replay = await repo.findOperation(a,p,c,command.requestId);
    if (replay) { if (replay.operation?.fingerprint !== fingerprint) throw new SettingsReviewError("VERSION_CONFLICT");return replay; }
    const formal = await this.options.handoff.read(a,p,c),ids = [formal.version.id,...formal.upstreamConfirmedVersionIds];
    if (!same(command.expectedUpstreamConfirmedVersionIds,ids)) throw new SettingsReviewError("UPSTREAM_CHANGED");
    const base = await repo.findActive(a,p,c);
    if (!base) throw new SettingsReviewError("NOT_FOUND");
    if (base.id !== command.expectedActiveVersionId) throw new SettingsReviewError("VERSION_CONFLICT");
    if (!this.options.readEvidence && base.sourceVersionId !== formal.version.sourceVersionId) throw new SettingsReviewError("UPSTREAM_CHANGED");
    const next = structuredClone(base);
    if (command.kind === "begin") {
      if (same(base.upstreamConfirmedVersionIds,ids)) throw new SettingsReviewError("INVALID_STATE");
      for (const decision of base.reconciliation?.failureDecisions ?? []) {
        if (!next.failures.some(failure => failure.scopeKey === decision.failure.scopeKey)) next.failures.push(structuredClone(decision.failure));
      }
      if (next.failures.length > base.failures.length) next.generationStatus = "failed";
      next.reconciliation = { originVersionId: base.id,pendingAssets: structuredClone([...base.assets,...(base.reconciliation?.pendingAssets ?? [])]),pendingFailureScopeKeys: next.failures.map(f => f.scopeKey) };
      next.sourceVersionId = formal.version.sourceVersionId;
      next.assets = [];next.suggestions = [];next.status = "candidate";next.scriptVersionId = formal.version.id;next.upstreamConfirmedVersionIds = ids;
      delete next.confirmedAt;delete next.confirmedBy;delete next.regeneration;
      if (base.status === "confirmed") next.revisionOfVersionId = base.id;
    } else if (command.kind === "resolveFailure") {
      if (!same(base.upstreamConfirmedVersionIds,ids) || base.sourceVersionId !== formal.version.sourceVersionId) throw new SettingsReviewError("UPSTREAM_CHANGED");
      const failure = base.failures.find(f => f.scopeKey === command.failureScopeKey);
      const pending = next.reconciliation;
      if (base.status !== "candidate" || failure?.retryable !== false || !pending?.pendingFailureScopeKeys.includes(command.failureScopeKey)) throw new SettingsReviewError("INVALID_STATE");
      next.failures = next.failures.filter(f => f.scopeKey !== command.failureScopeKey);
      next.generationStatus = next.failures.length ? next.assets.length ? "partially_succeeded" : "failed" : "succeeded";
      pending.pendingFailureScopeKeys = pending.pendingFailureScopeKeys.filter(key => key !== command.failureScopeKey);
      pending.failureDecisions = [...(pending.failureDecisions ?? []),{ failure,requestId:command.requestId,reason:command.reason,actorId:a.userId }];
    } else {
      if (!same(base.upstreamConfirmedVersionIds,ids)) throw new SettingsReviewError("UPSTREAM_CHANGED");
      const asset = base.reconciliation?.pendingAssets.find(v => v.id === command.assetId);
      if (base.status !== "candidate" || !asset) throw new SettingsReviewError("INVALID_STATE");
      if (command.kind === "unlock") {
        if (!Object.hasOwn(base.locks,asset.id)) throw new SettingsReviewError("INVALID_STATE");
        delete next.locks[asset.id];
      } else {
        let value: unknown = asset;
        if (command.kind === "repair") {
          if (Object.hasOwn(base.locks,asset.id)) throw new SettingsReviewError("LOCKED");
          value = command.value;
        } else if (asset.provenance.some(ref => ref.type === "source_fragment" && ref.sourceVersionId !== base.sourceVersionId)) {
          if (Object.hasOwn(base.locks,asset.id)) throw new SettingsReviewError("LOCKED");
          value = await this.migrateEvidence(a,p,c,asset,base.sourceVersionId);
        }
        const validated = validateSettingAsset(value,{ sourceVersionId: base.sourceVersionId,fragmentIds: formal.sourceFragments.map(f => f.id),approvedAdditionIds: [] });
        if (!validated || validated.id !== asset.id || validated.assetType !== asset.assetType) throw new SettingsReviewError("INVALID_STATE");
        next.assets.push(validated);
        next.reconciliation!.pendingAssets = next.reconciliation!.pendingAssets.filter(v => v.id !== command.assetId);
      }
    }
    next.id = this.options.idGenerator();next.createdBy = a.userId;next.createdAt = this.options.clock().toISOString();next.parentVersionId = base.id;
    next.operation = { requestId: command.requestId,fingerprint,kind: command.kind === "begin" ? "reconcile" : command.kind === "unlock" ? "reconcileUnlock" : command.kind === "repair" ? "reconcileRepair" : command.kind === "resolveFailure" ? "reconcileResolveFailure" : "retain",targetId: command.kind === "begin" ? base.id : command.kind === "resolveFailure" ? command.failureScopeKey : command.assetId,reason: command.reason };
    return repo.save(a,next,base.id);
  }
  private async migrateEvidence(a: Actor,p: string,c: string,asset: SettingsVersion["assets"][number],sourceId: string) {
    const read = this.options.readEvidence;
    if (!read) throw new SettingsReviewError("UPSTREAM_CHANGED");
    const versions = new Map((await read(a,p,c)).map(version => [version.id,new Map(version.fragments.map(fragment => [fragment.id,fragment]))]));
    const current = versions.get(sourceId);
    const provenance = asset.provenance.map(ref => {
      if (ref.type !== "source_fragment") throw new SettingsReviewError("INVALID_STATE");
      const old = versions.get(ref.sourceVersionId)?.get(ref.fragmentId);
      const target = current?.get(ref.fragmentId);
      if (!old || !target || old.contentHash !== target.contentHash || old.text !== target.text) throw new SettingsReviewError("INVALID_STATE");
      return { ...ref,sourceVersionId: sourceId };
    });
    return { ...asset,provenance };
  }
}
function id(v: unknown): v is string { return typeof v === "string" && !!v.trim() && v.length<=256 && !/[\r\n]/.test(v); }
function same(a: readonly string[],b: readonly string[]) { return a.length===b.length && a.every((v,i) => v===b[i]); }
function parse(v: SettingsReconciliationCommand): SettingsReconciliationCommand {
  if (!v || typeof v!=="object" || Array.isArray(v) || ![v.requestId,v.expectedActiveVersionId].every(id) || typeof v.reason!=="string" || !v.reason.trim() || v.reason.length>2000
    || !Array.isArray(v.expectedUpstreamConfirmedVersionIds) || v.expectedUpstreamConfirmedVersionIds.length!==3 || !v.expectedUpstreamConfirmedVersionIds.every(id)
    || !["begin","retain","unlock","repair","resolveFailure"].includes(v.kind) || (v.kind === "resolveFailure" ? !id(v.failureScopeKey) : v.kind !== "begin" && !id(v.assetId))
    || Object.keys(v).some(k => !["requestId","expectedActiveVersionId","expectedUpstreamConfirmedVersionIds","reason","kind",...(v.kind === "resolveFailure" ? ["failureScopeKey"] : v.kind !== "begin" ? ["assetId"] : []),...(v.kind === "repair" ? ["value"] : [])].includes(k))) throw new SettingsReviewError("INVALID_COMMAND");
  return { requestId: v.requestId,expectedActiveVersionId: v.expectedActiveVersionId,expectedUpstreamConfirmedVersionIds: [...v.expectedUpstreamConfirmedVersionIds],reason: v.reason.trim(),kind: v.kind,...(v.kind === "resolveFailure" ? { failureScopeKey:v.failureScopeKey } : v.kind !== "begin" ? { assetId:v.assetId } : {}),...(v.kind === "repair" ? { value: v.value } : {}) } as SettingsReconciliationCommand;
}
