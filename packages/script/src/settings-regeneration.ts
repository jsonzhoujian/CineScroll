import { createHash } from "node:crypto";
import type { Actor,ProjectAccessReader } from "./index.ts";
import type { ConfirmedScriptHandoff } from "./script-handoff.ts";
import type { SettingsGenerationRequest } from "./settings-runner.ts";
import { SettingsContentError,validateSettingsResponse,type SettingAsset } from "./settings-content.ts";
import { SettingsReviewError,type SettingsVersion,type SettingsReviewRepository } from "./settings-review.ts";
export type SettingsRegenerationSelection = { expectedActiveVersionId: string;assetIds: string[];failureScopeKeys: string[];reason: string };
export type SettingsRegenerationTarget = { scopeKey: string;asset?: SettingAsset;failureScopeKey?: string };
export type SettingsRegenerationRequest = SettingsGenerationRequest & { regeneration: { baseVersionId: string;reason: string;targets: SettingsRegenerationTarget[] } };
export interface SettingsRegenerationRepository {
  findActive(a: Actor,p: string,c: string): Promise<SettingsVersion | null>;
  findGeneration(a: Actor,p: string,c: string,jobId: string): Promise<SettingsVersion | null>;
  /** Atomically recheck roles, authority, targets/locks and CAS; persist result, task binding and dependencies. */
  saveGeneration(a: Actor,v: SettingsVersion,expected: string): Promise<SettingsVersion>;
}
export class SettingsRegenerationError extends Error {
  readonly code: "INVALID_REQUEST" | "INVALID_RESPONSE" | "EXECUTION_UNCERTAIN";
  constructor(code: SettingsRegenerationError["code"]) { super(code);this.name = "SettingsRegenerationError";this.code = code; }
}
export class SettingsRegenerationRunner {
  private readonly options: { repository: SettingsRegenerationRepository;handoff: Pick<ConfirmedScriptHandoff,"read">;access: ProjectAccessReader;model: { generate(r: SettingsRegenerationRequest): Promise<unknown> };idGenerator(): string;clock(): Date };
  constructor(options: SettingsRegenerationRunner["options"]) { this.options = options; }
  async run(a: Actor,p: string,c: string,jobId: string,input: SettingsRegenerationSelection) {
    const selection = normalize(input);
    if (![p,c,jobId].every(identifier)) throw new SettingsRegenerationError("INVALID_REQUEST");
    await reviewer(this.options.access,a,p);
    const fingerprint = digest(JSON.stringify(selection));
    const replay = await this.options.repository.findGeneration(a,p,c,jobId);
    if (replay) { if (replay.regeneration?.fingerprint !== fingerprint) throw new SettingsReviewError("VERSION_CONFLICT");return replay; }
    const { base,formal,targets } = await this.prepare(a,p,c,selection);
    const identity = { jobId,projectId: p,chapterId: c,sourceVersionId: base.sourceVersionId,upstreamConfirmedVersionIds: [...base.upstreamConfirmedVersionIds] };
    const request: SettingsRegenerationRequest = structuredClone({ ...identity,contractVersion: "0.1.0",stage: "settings",input: formal,regeneration: { baseVersionId: base.id,reason: selection.reason,targets } });
    let response: unknown;
    try { response = await this.options.model.generate(request); }
    catch (error) { if (error instanceof SettingsContentError) throw error;throw new SettingsRegenerationError("EXECUTION_UNCERTAIN"); }
    await this.prepare(a,p,c,selection);
    if (!response || typeof response !== "object" || !("items" in response) || !Array.isArray(response.items) || response.items.length !== targets.length
      || response.items.some(item => !item || typeof item !== "object" || !targets.some(t => t.scopeKey === item.scopeKey))) throw new SettingsRegenerationError("INVALID_RESPONSE");
    const result = validateSettingsResponse(response,identity,{ sourceVersionId: base.sourceVersionId,fragmentIds: formal.sourceFragments.map(f => f.id),approvedAdditionIds: [] });
    const assets = structuredClone(base.assets),failures = structuredClone(base.failures);
    let successes = 0;
    for (const target of targets) {
      const item = response.items.find(item => item.scopeKey === target.scopeKey);
      const invalid = result.failures.find(f => f.scopeKey === target.scopeKey);
      const asset = !invalid && item?.value ? result.assets.find(v => v.id === item.value.id) : null;
      const wrong = !asset || (target.asset ? asset.id !== target.asset.id || asset.assetType !== target.asset.assetType : assets.some(v => v.id === asset.id));
      const affected = (f: SettingsVersion["failures"][number]) => f.scopeKey === target.failureScopeKey || !!target.asset && f.assetId === target.asset.id;
      if (wrong) {
        const scopeKey = target.failureScopeKey ?? target.scopeKey;
        const failure = { scopeKey,...(target.asset ? { assetId: target.asset.id } : {}),code: invalid?.code ?? "INVALID_REGENERATION_TARGET",retryable: invalid?.retryable ?? true };
        const index = failures.findIndex(f => f.scopeKey === scopeKey);
        if (index < 0) failures.push(failure);else failures[index] = failure;
      } else {
        if (target.asset) assets[assets.findIndex(v => v.id === target.asset!.id)] = asset;
        else assets.push(asset);
        for (let i=failures.length-1;i>=0;i--) if (affected(failures[i]!)) failures.splice(i,1);
        successes++;
      }
    }
    const next = structuredClone(base);
    next.id = this.options.idGenerator();next.parentVersionId = base.id;next.createdBy = a.userId;next.createdAt = this.options.clock().toISOString();next.status = "candidate";
    delete next.confirmedBy;delete next.confirmedAt;
    if (base.status === "confirmed") next.revisionOfVersionId = base.id;
    next.assets = assets;next.failures = failures;next.generationStatus = failures.length ? assets.length ? "partially_succeeded" : "failed" : "succeeded";
    next.regeneration = { jobId,fingerprint,assetIds: selection.assetIds,failureScopeKeys: selection.failureScopeKeys,reason: selection.reason,outcome: successes === targets.length ? "succeeded" : successes ? "partially_succeeded" : "failed" };
    next.operation = { requestId: operationId(jobId),fingerprint,kind: "regenerate",targetId: base.id,reason: selection.reason };
    try { return await this.options.repository.saveGeneration(a,next,base.id); }
    catch (error) { if (error instanceof SettingsReviewError && error.code !== "STORAGE_UNAVAILABLE") throw error;throw new SettingsRegenerationError("EXECUTION_UNCERTAIN"); }
  }
  private async prepare(a: Actor,p: string,c: string,selection: SettingsRegenerationSelection) {
    await reviewer(this.options.access,a,p);
    const base = await this.options.repository.findActive(a,p,c);
    if (!base) throw new SettingsReviewError("NOT_FOUND");
    if (base.id !== selection.expectedActiveVersionId) throw new SettingsReviewError("VERSION_CONFLICT");
    const formal = await this.options.handoff.read(a,p,c);authority(base,formal);
    return { base,formal,targets: selectTargets(base,selection) };
  }
}
/** Reference adapter only; production must implement the same checks inside its save transaction. */
export class InMemorySettingsRegenerationRepository implements SettingsRegenerationRepository {
  private readonly reviews: SettingsReviewRepository;
  private readonly handoff: Pick<ConfirmedScriptHandoff,"read">;
  private readonly access: ProjectAccessReader;
  constructor(reviews: SettingsReviewRepository,handoff: Pick<ConfirmedScriptHandoff,"read">,access: ProjectAccessReader) { this.reviews = reviews;this.handoff = handoff;this.access = access; }
  findActive(a: Actor,p: string,c: string) { return this.reviews.findActive(a,p,c); }
  async findGeneration(a: Actor,p: string,c: string,id: string) {
    const v = await this.reviews.findOperation(a,p,c,operationId(id));
    if (v && (v.operation?.kind !== "regenerate" || v.regeneration?.jobId !== id)) throw new SettingsReviewError("VERSION_CONFLICT");
    return v;
  }
  async saveGeneration(a: Actor,input: SettingsVersion,expected: string) {
    const v = structuredClone(input);
    if (!v.regeneration || v.operation?.kind !== "regenerate") throw new SettingsRegenerationError("INVALID_REQUEST");
    await reviewer(this.access,a,v.projectId);
    const formal = await this.handoff.read(a,v.projectId,v.chapterId);authority(v,formal);
    const replay = await this.findGeneration(a,v.projectId,v.chapterId,v.regeneration.jobId);
    if (replay) { if (replay.regeneration?.fingerprint !== v.regeneration.fingerprint) throw new SettingsReviewError("VERSION_CONFLICT");return replay; }
    const base = await this.reviews.findActive(a,v.projectId,v.chapterId);
    if (!base || base.id !== expected) throw new SettingsReviewError("VERSION_CONFLICT");
    selectTargets(base,{ ...v.regeneration,expectedActiveVersionId: expected });
    return this.reviews.save(a,v,expected);
  }
}
function selectTargets(base: SettingsVersion,s: SettingsRegenerationSelection): SettingsRegenerationTarget[] {
  const targets: SettingsRegenerationTarget[] = [],ids = new Set<string>();
  const add = (asset: SettingAsset | undefined,failureScopeKey?: string) => {
    if (asset) {
      if (ids.has(asset.id)) throw new SettingsRegenerationError("INVALID_REQUEST");ids.add(asset.id);
      if (Object.hasOwn(base.locks,asset.id)) throw new SettingsReviewError("LOCKED");
      if (base.suggestions.some(p => p.assetId === asset.id && p.status === "pending")) throw new SettingsReviewError("INVALID_STATE");
    }
    const prefix = failureScopeKey === undefined ? "asset" : "failure",key = failureScopeKey ?? asset!.id;
    let scopeKey = `${prefix}_${digest(JSON.stringify(key))}`,nonce = 0;
    while (base.failures.some(f => f.scopeKey === scopeKey) || targets.some(t => t.scopeKey === scopeKey)) scopeKey = `${prefix}_${digest(JSON.stringify([key,++nonce]))}`;
    targets.push({ scopeKey,...(asset ? { asset: structuredClone(asset) } : {}),...(failureScopeKey === undefined ? {} : { failureScopeKey }) });
  };
  for (const id of s.assetIds) {
    const asset = base.assets.find(v => v.id === id);if (!asset) throw new SettingsReviewError("NOT_FOUND");add(asset,base.failures.find(f => f.assetId === id)?.scopeKey);
  }
  for (const key of s.failureScopeKeys) {
    const failure = base.failures.find(f => f.scopeKey === key);if (!failure || !failure.retryable) throw new SettingsReviewError("INVALID_STATE");
    const asset = failure.assetId ? base.assets.find(v => v.id === failure.assetId) : undefined;
    if (failure.assetId && !asset) throw new SettingsReviewError("INVALID_STATE");add(asset,key);
  }
  return targets;
}
async function reviewer(access: ProjectAccessReader,a: Actor,p: string) {
  const found = await access.findProjectAccess(a,p);if (!found) throw new SettingsReviewError("NOT_FOUND");
  if (found.role !== "owner" && found.role !== "reviewer") throw new SettingsReviewError("FORBIDDEN");
}
function authority(v: SettingsVersion,formal: Awaited<ReturnType<ConfirmedScriptHandoff["read"]>>) {
  const ids = [formal.version.id,...formal.upstreamConfirmedVersionIds];
  if (v.scriptVersionId !== formal.version.id || v.sourceVersionId !== formal.version.sourceVersionId || v.upstreamConfirmedVersionIds.length !== ids.length || ids.some((id,i) => id !== v.upstreamConfirmedVersionIds[i])) throw new SettingsReviewError("UPSTREAM_CHANGED");
}
function identifier(v: unknown): v is string { return typeof v === "string" && !!v.trim() && v.length <= 256 && !/[\r\n]/.test(v); }
function normalize(v: SettingsRegenerationSelection): SettingsRegenerationSelection {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !["expectedActiveVersionId","assetIds","failureScopeKeys","reason"].includes(k))
    || !identifier(v.expectedActiveVersionId) || typeof v.reason !== "string" || !v.reason.trim() || v.reason.length > 2000
    || !Array.isArray(v.assetIds) || !Array.isArray(v.failureScopeKeys) || v.assetIds.length+v.failureScopeKeys.length < 1 || v.assetIds.length+v.failureScopeKeys.length > 100
    || !v.assetIds.every(identifier) || !v.failureScopeKeys.every(identifier) || new Set(v.assetIds).size !== v.assetIds.length || new Set(v.failureScopeKeys).size !== v.failureScopeKeys.length) throw new SettingsRegenerationError("INVALID_REQUEST");
  return { expectedActiveVersionId: v.expectedActiveVersionId,assetIds: [...v.assetIds].sort(),failureScopeKeys: [...v.failureScopeKeys].sort(),reason: v.reason.trim() };
}
function digest(v: string) { return createHash("sha256").update(v).digest("hex"); }
function operationId(id: string) { return `regenerate_${digest(id)}`; }
