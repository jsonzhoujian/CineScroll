import { createHash } from "node:crypto";
import type { Actor,ProjectAccessReader } from "./index.ts";
import type { ConfirmedScriptHandoff } from "./script-handoff.ts";
import type { SettingsCandidate } from "./settings-runner.ts";
import { validateSettingAsset,type SettingAsset } from "./settings-content.ts";
export type SettingsReviewCommand = { requestId: string;expectedActiveVersionId: string;reason: string } & (
  { kind: "edit" | "suggest";assetId: string;value: unknown } | { kind: "decide";suggestionId: string;decision: "accepted" | "rejected" }
  | { kind: "confirm" } | { kind: "lock" | "unlock";assetId: string });
export type SettingsSuggestion = { id: string;assetId: string;baseVersionId: string;baseAssetHash: string;value: SettingAsset;reason: string;submittedBy: string;submittedAt: string;status: "pending" | "accepted" | "rejected";decidedBy?: string;decidedAt?: string;decisionReason?: string };
export type SettingsReviewOperation = { requestId: string;fingerprint: string;kind: SettingsReviewCommand["kind"];targetId: string;reason: string };
export type SettingsVersion = Omit<SettingsCandidate,"status"> & { status: "candidate" | "confirmed";parentVersionId: string | null;
  suggestions: SettingsSuggestion[];locks: Record<string,{ lockedBy: string;lockedAt: string }>;
  operation?: SettingsReviewOperation;confirmedBy?: string;confirmedAt?: string;revisionOfVersionId?: string };
export interface SettingsReviewRepository {
  findActive(a: Actor,p: string,c: string): Promise<SettingsVersion | null>;
  findConfirmed(a: Actor,p: string,c: string): Promise<SettingsVersion | null>;
  findVersion(a: Actor,p: string,c: string,id: string): Promise<SettingsVersion | null>;
  findOperation(a: Actor,p: string,c: string,requestId: string): Promise<SettingsVersion | null>;
  /** Persist immutable version and CAS head together; preserve independent formal pointer and recheck authority. */
  save(a: Actor,v: SettingsVersion,expectedActiveVersionId: string): Promise<SettingsVersion>;
}
export class SettingsReviewError extends Error {
  readonly code: "NOT_FOUND" | "FORBIDDEN" | "INVALID_COMMAND" | "INVALID_STATE" | "VERSION_CONFLICT" | "SUGGESTION_CONFLICT" | "LOCKED" | "UPSTREAM_CHANGED" | "STORAGE_UNAVAILABLE";
  constructor(code: SettingsReviewError["code"]) { super(code);this.name = "SettingsReviewError";this.code = code; }
}
export class SettingsReviewService {
  private readonly options: { repository: SettingsReviewRepository;handoff: Pick<ConfirmedScriptHandoff,"read">;access: ProjectAccessReader;idGenerator(): string;clock(): Date };
  constructor(options: SettingsReviewService["options"]) { this.options = options; }
  async permissions(a: Actor,p: string) {
    const access = await this.options.access.findProjectAccess(a,p);
    if (!access) throw new SettingsReviewError("NOT_FOUND");
    const reviewer = access.role === "owner" || access.role === "reviewer";
    return { canEdit: reviewer,canSuggest: true,canDecide: reviewer,canConfirm: reviewer,canLock: reviewer };
  }
  async execute(a: Actor,p: string,c: string,input: SettingsReviewCommand) {
    const command = parse(input);
    if (![p,c].every(identifier)) throw new SettingsReviewError("INVALID_COMMAND");
    const access = await this.options.access.findProjectAccess(a,p);
    if (!access) throw new SettingsReviewError("NOT_FOUND");
    if (access.role === "editor" && command.kind !== "suggest") throw new SettingsReviewError("FORBIDDEN");
    const formal = await this.options.handoff.read(a,p,c);
    const proposed = command.kind === "edit" || command.kind === "suggest" ? validateSettingAsset(command.value,{ sourceVersionId: formal.version.sourceVersionId,fragmentIds: formal.sourceFragments.map(f => f.id),approvedAdditionIds: [] }) : null;
    if ((command.kind === "edit" || command.kind === "suggest") && (!proposed || proposed.id !== command.assetId)) throw new SettingsReviewError("INVALID_COMMAND");
    const fingerprint = hash(command),repository = this.options.repository;
    const replay = await repository.findOperation(a,p,c,command.requestId);
    if (replay) {
      this.authority(replay,formal);
      if (replay.operation?.fingerprint !== fingerprint) throw new SettingsReviewError("VERSION_CONFLICT");
      return replay;
    }
    const base = await repository.findActive(a,p,c);
    if (!base) throw new SettingsReviewError("NOT_FOUND");
    this.authority(base,formal);
    if (base.id !== command.expectedActiveVersionId) throw new SettingsReviewError("VERSION_CONFLICT");
    const next = structuredClone(base),now = this.options.clock().toISOString();
    const assetId = "assetId" in command ? command.assetId : command.kind === "decide" ? next.suggestions.find(s => s.id === command.suggestionId)?.assetId : undefined;
    const asset = next.assets.find(v => v.id === assetId);
    if (command.kind !== "confirm" && !asset) throw new SettingsReviewError("NOT_FOUND");
    if (command.kind === "confirm") {
      if (base.status !== "candidate" || base.generationStatus !== "succeeded" || base.failures.length || !base.assets.length || base.suggestions.some(s => s.status === "pending")) throw new SettingsReviewError("INVALID_STATE");
      next.status = "confirmed";next.confirmedBy = a.userId;next.confirmedAt = now;
    } else if (command.kind === "lock" || command.kind === "unlock") {
      if (base.status !== "confirmed") throw new SettingsReviewError("INVALID_STATE");
      if (command.kind === "lock") {
        if (Object.hasOwn(next.locks,assetId!)) throw new SettingsReviewError("LOCKED");
        next.locks = { ...next.locks,[assetId!]: { lockedBy: a.userId,lockedAt: now } };
      } else {
        if (!Object.hasOwn(next.locks,assetId!)) throw new SettingsReviewError("INVALID_STATE");
        delete next.locks[assetId!];
      }
    } else if (command.kind === "decide") {
      const suggestion = next.suggestions.find(s => s.id === command.suggestionId)!;
      if (suggestion.status !== "pending") throw new SettingsReviewError("SUGGESTION_CONFLICT");
      if (command.decision === "accepted") {
        if (Object.hasOwn(next.locks,assetId!)) throw new SettingsReviewError("LOCKED");
        if (suggestion.baseAssetHash !== hash(asset)) throw new SettingsReviewError("SUGGESTION_CONFLICT");
        next.assets = next.assets.map(v => v.id === assetId ? suggestion.value : v);
        if (base.status === "confirmed") { next.status = "candidate";next.revisionOfVersionId = base.id;delete next.confirmedBy;delete next.confirmedAt; }
      }
      suggestion.status = command.decision;suggestion.decidedBy = a.userId;suggestion.decidedAt = now;suggestion.decisionReason = command.reason;
    } else if (command.kind === "edit" || command.kind === "suggest") {
      if (Object.hasOwn(next.locks,assetId!)) throw new SettingsReviewError("LOCKED");
      if (command.kind === "edit" && base.status !== "candidate") throw new SettingsReviewError("INVALID_STATE");
      const value = proposed;
      if (!value || value.id !== assetId || value.assetType !== asset!.assetType) throw new SettingsReviewError("INVALID_COMMAND");
      if (command.kind === "edit") next.assets = next.assets.map(v => v.id === assetId ? value : v);
      else next.suggestions.push({ id: this.options.idGenerator(),assetId: assetId!,baseVersionId: base.id,baseAssetHash: hash(asset),value,reason: command.reason,submittedBy: a.userId,submittedAt: now,status: "pending" });
    }
    next.id = this.options.idGenerator();next.parentVersionId = base.id;next.createdBy = a.userId;next.createdAt = now;
    next.operation = { requestId: command.requestId,fingerprint,kind: command.kind,targetId: command.kind === "confirm" ? base.id : command.kind === "decide" ? command.suggestionId : command.assetId,reason: command.reason };
    return repository.save(a,next,base.id);
  }
  private authority(v: SettingsVersion,current: Awaited<ReturnType<ConfirmedScriptHandoff["read"]>>) {
    const ids = [current.version.id,...current.upstreamConfirmedVersionIds];
    if (v.scriptVersionId !== current.version.id || v.sourceVersionId !== current.version.sourceVersionId || ids.length !== v.upstreamConfirmedVersionIds.length || ids.some((id,i) => id !== v.upstreamConfirmedVersionIds[i])) throw new SettingsReviewError("UPSTREAM_CHANGED");
  }
}
/** Reference CAS repository only; the production adapter must enforce RLS, authority and transitions in its transaction. */
export class InMemorySettingsReviewRepository implements SettingsReviewRepository {
  private readonly versions = new Map<string,SettingsVersion>();
  private readonly heads = new Map<string,string>();
  private readonly confirmed = new Map<string,string>();
  constructor(a: Actor,initial: SettingsCandidate) {
    const key = this.scope(a,initial.projectId,initial.chapterId);
    this.versions.set(JSON.stringify([key,initial.id]),structuredClone({ ...initial,parentVersionId: null,suggestions: [],locks: {} }));this.heads.set(key,initial.id);
  }
  private scope(a: Actor,p: string,c: string) { return JSON.stringify([a.workspaceId,p,c]); }
  async findVersion(a: Actor,p: string,c: string,id: string) { return structuredClone(this.versions.get(JSON.stringify([this.scope(a,p,c),id])) ?? null); }
  async findActive(a: Actor,p: string,c: string) { return this.findVersion(a,p,c,this.heads.get(this.scope(a,p,c)) ?? ""); }
  async findConfirmed(a: Actor,p: string,c: string) { return this.findVersion(a,p,c,this.confirmed.get(this.scope(a,p,c)) ?? ""); }
  async findOperation(a: Actor,p: string,c: string,id: string) {
    const scope = this.scope(a,p,c);
    return structuredClone([...this.versions.entries()].find(([key,v]) => key === JSON.stringify([scope,v.id]) && v.createdBy === a.userId && v.operation?.requestId === id)?.[1] ?? null);
  }
  async save(a: Actor,input: SettingsVersion,expected: string) {
    const v = structuredClone(input),scope = this.scope(a,v.projectId,v.chapterId);
    if (v.createdBy !== a.userId || v.parentVersionId !== expected || !v.operation) throw new SettingsReviewError("INVALID_COMMAND");
    const replay = [...this.versions.entries()].find(([key,old]) => key === JSON.stringify([scope,old.id]) && old.createdBy === a.userId && old.operation?.requestId === v.operation!.requestId)?.[1];
    if (replay) {
      if (replay.operation?.fingerprint !== v.operation.fingerprint) throw new SettingsReviewError("VERSION_CONFLICT");return structuredClone(replay);
    }
    const key = JSON.stringify([scope,v.id]);
    if (this.heads.get(scope) !== expected || this.versions.has(key)) throw new SettingsReviewError("VERSION_CONFLICT");
    this.versions.set(key,v);this.heads.set(scope,v.id);if (v.status === "confirmed") this.confirmed.set(scope,v.id);return structuredClone(v);
  }
}
function identifier(v: unknown): v is string { return typeof v === "string" && !!v.trim() && v.length <= 256 && !/[\r\n]/.test(v); }
function parse(v: SettingsReviewCommand): SettingsReviewCommand {
  if (!v || typeof v !== "object" || Array.isArray(v) || ![v.requestId,v.expectedActiveVersionId].every(identifier) || typeof v.reason !== "string" || !v.reason.trim() || v.reason.length > 2000) throw new SettingsReviewError("INVALID_COMMAND");
  const fields = v.kind === "edit" || v.kind === "suggest" ? ["assetId","value"] : v.kind === "decide" ? ["suggestionId","decision"] : v.kind === "lock" || v.kind === "unlock" ? ["assetId"] : v.kind === "confirm" ? [] : null;
  if (!fields || Object.keys(v).some(k => !["requestId","expectedActiveVersionId","reason","kind",...fields].includes(k))
    || "assetId" in v && !identifier(v.assetId) || v.kind === "decide" && (!identifier(v.suggestionId) || !["accepted","rejected"].includes(v.decision))) throw new SettingsReviewError("INVALID_COMMAND");
  return structuredClone({ ...v,reason: v.reason.trim() });
}
function hash(v: unknown): string {
  return createHash("sha256").update(JSON.stringify(v,(_key,value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)) : value)).digest("hex");
}
