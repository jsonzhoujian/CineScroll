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
