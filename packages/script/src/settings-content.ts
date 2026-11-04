import type { ScriptProvenance } from "./script-content.ts";
export type SettingAsset = Readonly<{ id: string;assetType: "character" | "location" | "prop" | "visualStyle";name: string;visibleDefinition: Record<string,unknown>;state: string;stateChanges: string[];restrictions: string[];provenance: ScriptProvenance[] }>;
export type SettingEvidenceContext = { sourceVersionId: string;fragmentIds: readonly string[];approvedAdditionIds: readonly string[] };
/** Canonical asset shape plus server-authoritative evidence checks. Invalid items are quarantined by the caller. */
export function validateSettingAsset(value: unknown,context: SettingEvidenceContext): SettingAsset | null {
  if (!record(value) || !keys(value,["id","assetType","name","visibleDefinition","state","stateChanges","restrictions","provenance"])
    || !identifier(value.id) || !["character","location","prop","visualStyle"].includes(String(value.assetType)) || typeof value.assetType !== "string"
    || !text(value.name) || !record(value.visibleDefinition) || !Object.keys(value.visibleDefinition).length || !json(value.visibleDefinition)
    || typeof value.state !== "string" || !strings(value.stateChanges) || !strings(value.restrictions)
    || !Array.isArray(value.provenance) || !value.provenance.length || value.provenance.some(p => {
      if (!record(p)) return true;
      if (p.type === "source_fragment") return !keys(p,["type","sourceVersionId","fragmentId","transformation"]) || p.sourceVersionId !== context.sourceVersionId || typeof p.fragmentId !== "string" || !context.fragmentIds.includes(p.fragmentId) || typeof p.transformation !== "string" || !["retained","compressed","merged","visualized","actionized","narrated","sonified"].includes(p.transformation);
      return p.type !== "approved_addition" || !keys(p,["type","additionId"]) || typeof p.additionId !== "string" || !context.approvedAdditionIds.includes(p.additionId);
    })) return null;
  return structuredClone(value) as SettingAsset;
}
function record(v: unknown): v is Record<string,unknown> { return !!v && typeof v === "object" && !Array.isArray(v); }
function keys(v: Record<string,unknown>,allowed: string[]) { return Object.keys(v).length === allowed.length && Object.keys(v).every(k => allowed.includes(k)); }
function identifier(v: unknown): v is string { return typeof v === "string" && !!v.trim() && v.length <= 256 && !/[\r\n]/.test(v); }
function text(v: unknown): v is string { return typeof v === "string" && !!v.trim() && v.length <= 20000; }
function strings(v: unknown): v is string[] { return Array.isArray(v) && v.every(x => typeof x === "string"); }
function json(v: unknown,depth = 0): boolean { return depth <= 20 && (v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v) || Array.isArray(v) && v.every(x => json(x,depth+1)) || record(v) && Object.values(v).every(x => json(x,depth+1))); }

export class SettingsContentError extends Error {
  readonly code: "INVALID_RESPONSE";
  constructor() { super("INVALID_RESPONSE");this.name = "SettingsContentError";this.code = "INVALID_RESPONSE"; }
}
export type SettingsResponseIdentity = { jobId: string;projectId: string;chapterId: string;sourceVersionId: string;upstreamConfirmedVersionIds: readonly string[] };
export type SettingsGenerationResult = { assets: SettingAsset[];failures: Array<{ scopeKey: string;assetId?: string;code: string;retryable: boolean }>;generationStatus: "succeeded" | "partially_succeeded" | "failed" };
/** Envelope identity must match before any item may be consumed. Provider prose never enters failure records. */
export function validateSettingsResponse(response: unknown,expected: SettingsResponseIdentity,evidence: SettingEvidenceContext): SettingsGenerationResult {
  if (!record(response) || !keys(response,["contractVersion","jobId","stage","projectId","chapterId","sourceVersionId","upstreamConfirmedVersionIds","status","items"])
    || response.contractVersion !== "0.1.0" || response.stage !== "settings" || response.jobId !== expected.jobId || response.projectId !== expected.projectId || response.chapterId !== expected.chapterId
    || response.sourceVersionId !== expected.sourceVersionId || evidence.sourceVersionId !== expected.sourceVersionId
    || !Array.isArray(response.upstreamConfirmedVersionIds) || !response.upstreamConfirmedVersionIds.length || response.upstreamConfirmedVersionIds.length !== expected.upstreamConfirmedVersionIds.length
    || response.upstreamConfirmedVersionIds.some((id,i) => id !== expected.upstreamConfirmedVersionIds[i])
    || !Array.isArray(response.items) || !response.items.length || response.items.length > 1000) throw new SettingsContentError();
  const assets: SettingAsset[] = [],failures: SettingsGenerationResult["failures"] = [],scopes = new Set<string>(),ids = new Set<string>();
  let providerFailures = 0;
  for (const item of response.items) {
    if (!record(item) || !identifier(item.scopeKey) || scopes.has(item.scopeKey)) throw new SettingsContentError();
    scopes.add(item.scopeKey);
    if (item.status === "failed") {
      if (!keys(item,["scopeKey","status","error"]) || !record(item.error) || !keys(item.error,["code","message","retryable"]) || !identifier(item.error.code) || typeof item.error.message !== "string" || typeof item.error.retryable !== "boolean") throw new SettingsContentError();
      providerFailures++;failures.push({ scopeKey: item.scopeKey,code: "PROVIDER_ITEM_FAILED",retryable: item.error.retryable });continue;
    }
    if (item.status !== "succeeded" || !keys(item,["scopeKey","status","value"])) throw new SettingsContentError();
    const asset = validateSettingAsset(item.value,evidence);
    if (!asset || ids.has(asset.id)) { failures.push({ scopeKey: item.scopeKey,code: "INVALID_ASSET",retryable: true });continue; }
    ids.add(asset.id);assets.push(asset);
  }
  const declared = providerFailures === 0 ? "succeeded" : providerFailures === response.items.length ? "failed" : "partially_succeeded";
  if (response.status !== declared) throw new SettingsContentError();
  return { assets,failures,generationStatus: !failures.length ? "succeeded" : assets.length ? "partially_succeeded" : "failed" };
}
