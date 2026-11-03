import type { Actor } from "./index.ts";
import type { ConfirmedScriptHandoff } from "./script-handoff.ts";
import { validateSettingsResponse,type SettingsGenerationResult,type SettingsResponseIdentity } from "./settings-content.ts";
export type SettingsCandidate = SettingsGenerationResult & SettingsResponseIdentity & { id: string;status: "candidate";createdBy: string;createdAt: string;scriptVersionId: string };
export interface SettingsCandidateRepository {
  findGeneration(actor: Actor,p: string,c: string,jobId: string): Promise<SettingsCandidate | null>;
  /** Must recheck current formal script and register dependencies atomically with the candidate write. */
  saveGeneration(actor: Actor,candidate: SettingsCandidate): Promise<SettingsCandidate>;
}
export type SettingsGenerationRequest = SettingsResponseIdentity & { contractVersion: "0.1.0";stage: "settings";input: Awaited<ReturnType<ConfirmedScriptHandoff["read"]>> };
export class SettingsGenerationError extends Error {
  readonly code: "INVALID_REQUEST" | "UPSTREAM_CHANGED" | "PROVIDER_UNAVAILABLE";
  constructor(code: SettingsGenerationError["code"]) { super(code);this.name = "SettingsGenerationError";this.code = code; }
}
export class SettingsRunner {
  private readonly options: { handoff: Pick<ConfirmedScriptHandoff,"read">;repository: SettingsCandidateRepository;model: { generate(request: SettingsGenerationRequest): Promise<unknown> };idGenerator(): string;clock(): Date };
  constructor(options: SettingsRunner["options"]) { this.options = options; }
  async run(actor: Actor,p: string,c: string,jobId: string) {
    if (![p,c,jobId].every(v => typeof v === "string" && !!v.trim() && v.length <= 256 && !/[\r\n]/.test(v))) throw new SettingsGenerationError("INVALID_REQUEST");
    const upstream = await this.options.handoff.read(actor,p,c);
    const existing = await this.options.repository.findGeneration(actor,p,c,jobId);
    if (existing) return existing; // Caller must bind task identity before using this internal boundary.
    const identity = { jobId,projectId: p,chapterId: c,sourceVersionId: upstream.version.sourceVersionId,upstreamConfirmedVersionIds: [upstream.version.id,...upstream.upstreamConfirmedVersionIds] };
    const request: SettingsGenerationRequest = structuredClone({ ...identity,contractVersion: "0.1.0",stage: "settings",input: upstream });
    let response: unknown;
    try { response = await this.options.model.generate(request); } catch { throw new SettingsGenerationError("PROVIDER_UNAVAILABLE"); }
    const current = await this.options.handoff.read(actor,p,c);
    if (current.version.id !== upstream.version.id || current.version.sourceVersionId !== upstream.version.sourceVersionId || current.upstreamConfirmedVersionIds.length !== upstream.upstreamConfirmedVersionIds.length || current.upstreamConfirmedVersionIds.some((id,i) => id !== upstream.upstreamConfirmedVersionIds[i])) throw new SettingsGenerationError("UPSTREAM_CHANGED");
    const result = validateSettingsResponse(response,identity,{ sourceVersionId: upstream.version.sourceVersionId,fragmentIds: upstream.sourceFragments.map(f => f.id),approvedAdditionIds: [] });
    return this.options.repository.saveGeneration(actor,{ ...result,...identity,id: this.options.idGenerator(),scriptVersionId: upstream.version.id,status: "candidate",createdBy: actor.userId,createdAt: this.options.clock().toISOString() });
  }
}
