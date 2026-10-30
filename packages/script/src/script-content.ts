import { createHash } from "node:crypto";
import type { Actor, EpisodePlanVersion, ProjectAccessReader } from "./index.ts";

export type Transformation = "retained" | "compressed" | "merged" | "visualized" | "actionized" | "narrated" | "sonified";
export type ScriptProvenance = Readonly<{
  type: "source_fragment"; sourceVersionId: string; fragmentId: string; transformation: Transformation;
}> | Readonly<{ type: "approved_addition"; additionId: string }>;
export type ScriptElement = Readonly<{
  id: string; sceneId: string; elementType: "environment" | "action" | "dialogue" | "narration" | "sound";
  ordinal: number; text: string; speaker?: string; provenance: ScriptProvenance[];
  lastEdit?: Readonly<{ editedBy: string; editedAt: string; reason: string }>;
  lockedBy?: string; lockedAt?: string;
}>;
export type ScriptScene = Readonly<{
  id: string; episodeId: string; ordinal: number; title: string; environment: string; characters: string[];
}>;
export type ScriptSuggestion = Readonly<{
  id: string; elementId: string; baseText: string; text: string; reason: string;
  submittedBy: string; submittedAt: string; status: "pending" | "accepted" | "rejected";
  decidedBy?: string; decidedAt?: string;
}>;
export type ScriptGenerationContext = Readonly<{
  planVersionId: string; sourceVersionId: string;
  fragments: Array<Readonly<{ id: string; text: string }>>; approvedAdditionIds: string[];
  confirmedPlan?: EpisodePlanVersion;
  confirmedStoryKnowledge?: { versionId: string; facts: Array<{ id: string; statement: string }> };
}>;
export type ScriptReviewCommand = { requestId: string;expectedActiveVersionId: string;reason: string } & (
  { kind: "edit" | "suggest";elementId: string;text: string } | { kind: "decide";suggestionId: string;decision: "accepted" | "rejected" });
export type ScriptReviewOperation = { requestId: string;fingerprint: string;kind: ScriptReviewCommand["kind"];targetId: string;reason: string };
export type ScriptRetrySelection = { expectedActiveVersionId: string;scopeKeys: string[] };
export type ScriptRetrySnapshot = ScriptRetrySelection & { retryOfJobId: string;failureOrigins?: Array<{ scopeKey: string;jobId: string }> };
export type ScriptContentVersion = Readonly<{
  retry?: ScriptRetrySnapshot;
  reviewOperation?: ScriptReviewOperation;
  id: string; parentVersionId: string | null; projectId: string; chapterId: string;
  sourceVersionId: string; planVersionId: string; jobId: string; status: "candidate" | "confirmed";
  confirmedBy?: string; confirmedAt?: string; confirmationCandidateVersionId?: string;
  generationStatus: "succeeded" | "partially_succeeded" | "failed";
  createdBy: string; createdAt: string; elements: ScriptElement[];
  scenes: ScriptScene[];
  suggestions?: ScriptSuggestion[];
  failures: Array<Readonly<{ scopeKey: string; originJobId?: string; code: string; message: string; retryable: boolean }>>;
}>;
export interface ScriptContentRepository {
  findReviewOperation?(actor: Actor,projectId: string,chapterId: string,requestId: string): Promise<ScriptContentVersion | null>;
  findGeneration?(actor: Actor, projectId: string, chapterId: string, jobId: string): Promise<ScriptContentVersion | null>;
  findActive(actor: Actor, projectId: string, chapterId: string): Promise<ScriptContentVersion | null>;
  save(actor: Actor, version: ScriptContentVersion, expectedActiveVersionId: string | null): Promise<ScriptContentVersion>;
}
export interface ScriptGenerationContextReader {
  // Returns null unless the actor is a project member and the plan is confirmed.
  findGenerationContext(actor: Actor, projectId: string, chapterId: string): Promise<ScriptGenerationContext | null>;
}
export class ScriptContentError extends Error {
  readonly code: "CONTEXT_NOT_FOUND" | "FORBIDDEN" | "INVALID_GENERATION" | "INVALID_EDIT" | "VERSION_CONFLICT" | "ELEMENT_NOT_FOUND" | "SUGGESTION_NOT_FOUND" | "SUGGESTION_CONFLICT" | "INVALID_CONFIRMATION" | "INVALID_STATE" | "STORAGE_UNAVAILABLE";
  constructor(code: ScriptContentError["code"], message: string) {
    super(message); this.name = "ScriptContentError"; this.code = code;
  }
}
export class InMemoryScriptContentRepository implements ScriptContentRepository {
  readonly #active = new Map<string, ScriptContentVersion>();
  readonly #versions = new Map<string, ScriptContentVersion>();
  readonly #generations = new Map<string, ScriptContentVersion>();
  async findReviewOperation(actor: Actor,p: string,c: string,requestId: string) {
    return structuredClone([...this.#versions.entries()].find(([key,v]) => key === JSON.stringify([scopeKey(actor,p,c),v.id]) && v.createdBy === actor.userId && v.reviewOperation?.requestId === requestId)?.[1] ?? null);
  }
  async findGeneration(actor: Actor, projectId: string, chapterId: string, jobId: string) {
    return structuredClone(this.#generations.get(JSON.stringify([scopeKey(actor,projectId,chapterId),jobId])) ?? null);
  }
  async findActive(actor: Actor, projectId: string, chapterId: string): Promise<ScriptContentVersion | null> {
    const result = this.#active.get(scopeKey(actor, projectId, chapterId));
    return result ? structuredClone(result) : null;
  }
  async save(actor: Actor, version: ScriptContentVersion, expectedActiveVersionId: string | null): Promise<ScriptContentVersion> {
    const key = scopeKey(actor, version.projectId, version.chapterId);
    if ((this.#active.get(key)?.id ?? null) !== expectedActiveVersionId) {
      throw new ScriptContentError("VERSION_CONFLICT", "剧本已更新，请刷新后重试");
    }
    const saved = structuredClone(version);
    this.#versions.set(JSON.stringify([key, version.id]), saved);
    const generationKey = JSON.stringify([key,version.jobId]);
    if (!this.#generations.has(generationKey)) this.#generations.set(generationKey,saved);
    this.#active.set(key, saved);
    return structuredClone(saved);
  }
}
export class ScriptContentService {
  private readonly dependencies: {
    repository: ScriptContentRepository; contextReader: ScriptGenerationContextReader;
    idGenerator: () => string; clock: () => Date;
    accessReader?: ProjectAccessReader;
    // Must evaluate this exact immutable snapshot; absent evaluator fails closed.
    confirmationGate?: { validate(version: ScriptContentVersion): Promise<boolean> };
  };
  constructor(dependencies: ScriptContentService["dependencies"]) { this.dependencies = dependencies; }

  async getReviewPermissions(actor: Actor,p: string) {
    const access = await this.dependencies.accessReader?.findProjectAccess(actor,p);
    return { canSuggest: !!access,canEdit: !!access && access.role !== "editor",canDecide: !!access && access.role !== "editor" };
  }
  async reviewCandidate(actor: Actor,p: string,c: string,input: ScriptReviewCommand): Promise<ScriptContentVersion> {
    if (!isRecord(input) || !["edit","suggest","decide"].includes(input.kind) || !nonblank(input.requestId) || input.requestId.length > 256
      || !nonblank(input.expectedActiveVersionId) || !nonblank(input.reason) || input.reason.length > 2000
      || !onlyKeys(input,input.kind === "decide" ? ["kind","requestId","expectedActiveVersionId","suggestionId","decision","reason"] : ["kind","requestId","expectedActiveVersionId","elementId","text","reason"])) throw new ScriptContentError("INVALID_EDIT","审核命令无效");
    const current = await this.readEditableVersion(actor,p,c,null,input.kind !== "suggest");
    if (current.status !== "candidate") throw new ScriptContentError("INVALID_STATE","仅可修改候选剧本");
    const normalized = input.kind === "decide" ? { kind: input.kind,requestId: input.requestId,expectedActiveVersionId: input.expectedActiveVersionId,suggestionId: input.suggestionId,decision: input.decision,reason: input.reason.trim() }
      : { kind: input.kind,requestId: input.requestId,expectedActiveVersionId: input.expectedActiveVersionId,elementId: input.elementId,text: input.text,reason: input.reason.trim() };
    const fingerprint = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
    const repository = this.dependencies.repository;
    if (!repository.findReviewOperation) throw new ScriptContentError("STORAGE_UNAVAILABLE","审核存储未就绪");
    const replay = await repository.findReviewOperation(actor,p,c,input.requestId);
    if (replay) { if (replay.reviewOperation?.fingerprint !== fingerprint) throw new ScriptContentError("VERSION_CONFLICT","请求标识已用于其他修改"); return replay; }
    if (current.id !== input.expectedActiveVersionId) throw new ScriptContentError("VERSION_CONFLICT","剧本已更新，请重新读取");
    const operation: ScriptReviewOperation = { requestId: input.requestId,fingerprint,kind: input.kind,targetId: input.kind === "decide" ? input.suggestionId : input.elementId,reason: input.reason.trim() };
    const scoped = new ScriptContentService({ ...this.dependencies,repository: {
      findActive: repository.findActive.bind(repository),
      save: (a,v,expected) => repository.save(a,{ ...v,reviewOperation: operation },expected),
    } });
    try {
      if (input.kind === "edit") return await scoped.editElement(actor,p,c,{ expectedActiveVersionId: input.expectedActiveVersionId,elementId: input.elementId,text: input.text,reason: input.reason });
      if (input.kind === "suggest") return await scoped.submitSuggestion(actor,p,c,{ expectedActiveVersionId: input.expectedActiveVersionId,elementId: input.elementId,text: input.text,reason: input.reason });
      if (input.kind === "decide") {
        const decided = await scoped.decideSuggestion(actor,p,c,{ expectedActiveVersionId: input.expectedActiveVersionId,suggestionId: input.suggestionId,decision: input.decision });
        if (decided.id !== current.id) {
          if (decided.createdBy === actor.userId && decided.reviewOperation?.requestId === operation.requestId && decided.reviewOperation.fingerprint === operation.fingerprint) return decided;
          throw new ScriptContentError("VERSION_CONFLICT","建议已被其他请求处理，请重新读取");
        }
        return await repository.save(actor,{ ...current,id: this.dependencies.idGenerator(),parentVersionId: current.id,createdBy: actor.userId,createdAt: this.dependencies.clock().toISOString(),reviewOperation: operation },current.id);
      }
      throw new ScriptContentError("INVALID_EDIT","审核命令无效");
    } catch (error) {
      if (error instanceof ScriptContentError && ["VERSION_CONFLICT","STORAGE_UNAVAILABLE"].includes(error.code)) {
        const saved = await repository.findReviewOperation(actor,p,c,input.requestId);
        if (saved?.reviewOperation?.fingerprint === fingerprint) return saved;
      }
      throw error;
    }
  }

  async confirmContent(actor: Actor, projectId: string, chapterId: string, expectedVersionId: string): Promise<ScriptContentVersion> {
    const current = await this.readEditableVersion(actor, projectId, chapterId, null, true);
    if (current.status === "confirmed" && (current.id === expectedVersionId || current.confirmationCandidateVersionId === expectedVersionId)) return current;
    if (current.id !== expectedVersionId) throw new ScriptContentError("VERSION_CONFLICT", "剧本已更新，请刷新后重试");
    if (current.status !== "candidate") throw new ScriptContentError("INVALID_STATE", "仅候选剧本可确认");
    if (current.generationStatus !== "succeeded" || current.failures.length || !current.elements.length || !current.scenes.length
      || current.suggestions?.some(({ status }) => status === "pending")
      || await this.dependencies.confirmationGate?.validate(structuredClone(current)) !== true) {
      throw new ScriptContentError("INVALID_CONFIRMATION", "剧本存在失败、未决建议或未通过质量验收");
    }
    const createdAt = this.dependencies.clock().toISOString();
    return this.dependencies.repository.save(actor, {
      ...current, id: this.dependencies.idGenerator(), parentVersionId: current.id, status: "confirmed",
      createdBy: actor.userId, createdAt, confirmedBy: actor.userId, confirmedAt: createdAt,
      confirmationCandidateVersionId: current.id,
    }, current.id);
  }

  async lockContent(actor: Actor, projectId: string, chapterId: string, expectedVersionId: string, elementIds?: string[]): Promise<ScriptContentVersion> {
    const current = await this.readEditableVersion(actor, projectId, chapterId, null, true);
    if (current.status !== "confirmed") throw new ScriptContentError("INVALID_STATE", "仅已确认剧本可锁定");
    const targets = elementIds ?? current.elements.map(({ id }) => id);
    if (!Array.isArray(targets) || !targets.length || !targets.every(nonblank) || new Set(targets).size !== targets.length
      || targets.some((id) => !current.elements.some((element) => element.id === id))) throw new ScriptContentError("INVALID_EDIT", "锁定条目无效");
    if (targets.every((id) => current.elements.find((element) => element.id === id)?.lockedAt)
      && (current.id === expectedVersionId || current.parentVersionId === expectedVersionId)) return current;
    if (current.id !== expectedVersionId) throw new ScriptContentError("VERSION_CONFLICT", "剧本已更新，请刷新后重试");
    const createdAt = this.dependencies.clock().toISOString();
    return this.dependencies.repository.save(actor, {
      ...current, id: this.dependencies.idGenerator(), parentVersionId: current.id,
      createdBy: actor.userId, createdAt,
      elements: current.elements.map((element) => targets.includes(element.id) && !element.lockedAt
        ? { ...element, lockedBy: actor.userId, lockedAt: createdAt } : element),
    }, current.id);
  }

  private async readEditableVersion(actor: Actor, projectId: string, chapterId: string, expectedVersionId: string | null, review: boolean): Promise<ScriptContentVersion> {
    const context = await this.dependencies.contextReader.findGenerationContext(actor, projectId, chapterId);
    if (!context) throw new ScriptContentError("CONTEXT_NOT_FOUND", "项目不存在或拆集方案尚未确认");
    const access = await this.dependencies.accessReader?.findProjectAccess(actor, projectId);
    if (!access || (review && access.role === "editor")) throw new ScriptContentError("FORBIDDEN", "无权执行此剧本操作");
    const current = await this.dependencies.repository.findActive(actor, projectId, chapterId);
    if (!current || current.sourceVersionId !== context.sourceVersionId || current.planVersionId !== context.planVersionId) {
      throw new ScriptContentError("CONTEXT_NOT_FOUND", "剧本依据已变化");
    }
    if (expectedVersionId !== null && current.id !== expectedVersionId) throw new ScriptContentError("VERSION_CONFLICT", "剧本已更新，请刷新后重试");
    return current;
  }

  async submitSuggestion(actor: Actor, projectId: string, chapterId: string, input: {
    expectedActiveVersionId: string; elementId: string; text: string; reason: string;
  }): Promise<ScriptContentVersion> {
    if (!isRecord(input) || !onlyKeys(input, ["expectedActiveVersionId", "elementId", "text", "reason"])
      || !nonblank(input.expectedActiveVersionId) || !nonblank(input.elementId) || !nonblank(input.text) || !nonblank(input.reason)) {
      throw new ScriptContentError("INVALID_EDIT", "修改内容和理由不能为空");
    }
    const current = await this.readEditableVersion(actor, projectId, chapterId, input.expectedActiveVersionId, false);
    if (current.status !== "candidate") throw new ScriptContentError("INVALID_STATE", "正式剧本修改流程尚未开放");
    const element = current.elements.find(({ id }) => id === input.elementId);
    if (!element) throw new ScriptContentError("ELEMENT_NOT_FOUND", "剧本条目不存在");
    const createdAt = this.dependencies.clock().toISOString();
    return this.dependencies.repository.save(actor, {
      ...current, id: this.dependencies.idGenerator(), parentVersionId: current.id, createdBy: actor.userId, createdAt,
      suggestions: [...(current.suggestions ?? []), {
        id: this.dependencies.idGenerator(), elementId: element.id, baseText: element.text,
        text: input.text.trim(), reason: input.reason.trim(), submittedBy: actor.userId, submittedAt: createdAt, status: "pending",
      }],
    }, current.id);
  }

  async decideSuggestion(actor: Actor, projectId: string, chapterId: string, input: {
    expectedActiveVersionId: string; suggestionId: string; decision: "accepted" | "rejected";
  }): Promise<ScriptContentVersion> {
    if (!isRecord(input) || !onlyKeys(input, ["expectedActiveVersionId", "suggestionId", "decision"])
      || !nonblank(input.expectedActiveVersionId) || !nonblank(input.suggestionId)
      || !["accepted", "rejected"].includes(input.decision)) throw new ScriptContentError("INVALID_EDIT", "建议裁决无效");
    const current = await this.readEditableVersion(actor, projectId, chapterId, null, true);
    if (current.status !== "candidate") throw new ScriptContentError("INVALID_STATE", "正式剧本修改流程尚未开放");
    const suggestion = current.suggestions?.find(({ id }) => id === input.suggestionId);
    if (!suggestion) throw new ScriptContentError("SUGGESTION_NOT_FOUND", "修改建议不存在");
    if (suggestion.status === input.decision) return current;
    if (suggestion.status !== "pending") throw new ScriptContentError("SUGGESTION_CONFLICT", "修改建议已裁决");
    if (current.id !== input.expectedActiveVersionId) throw new ScriptContentError("VERSION_CONFLICT", "剧本已更新，请刷新后重试");
    const element = current.elements.find(({ id }) => id === suggestion.elementId);
    if (input.decision === "accepted" && (!element || element.text !== suggestion.baseText)) {
      throw new ScriptContentError("SUGGESTION_CONFLICT", "建议对应内容已修改，请重新提交");
    }
    const createdAt = this.dependencies.clock().toISOString();
    return this.dependencies.repository.save(actor, {
      ...current, id: this.dependencies.idGenerator(), parentVersionId: current.id, createdBy: actor.userId, createdAt,
      elements: current.elements.map((item) => input.decision === "accepted" && item.id === suggestion.elementId ? {
        ...item, text: suggestion.text, lastEdit: { editedBy: actor.userId, editedAt: createdAt, reason: suggestion.reason },
      } : item),
      suggestions: current.suggestions!.map((item) => item.id === suggestion.id ? {
        ...item, status: input.decision, decidedBy: actor.userId, decidedAt: createdAt,
      } : item),
    }, current.id);
  }

  async editElement(actor: Actor, projectId: string, chapterId: string, input: {
    expectedActiveVersionId: string; elementId: string; text: string; reason: string;
  }): Promise<ScriptContentVersion> {
    if (!isRecord(input) || !onlyKeys(input, ["expectedActiveVersionId", "elementId", "text", "reason"])
      || !nonblank(input.expectedActiveVersionId) || !nonblank(input.elementId)
      || !nonblank(input.text) || !nonblank(input.reason)) {
      throw new ScriptContentError("INVALID_EDIT", "修改内容和理由不能为空");
    }
    const current = await this.readEditableVersion(actor, projectId, chapterId, input.expectedActiveVersionId, true);
    if (current.status !== "candidate") throw new ScriptContentError("INVALID_STATE", "正式剧本不可直接编辑");
    if (!current.elements.some(({ id }) => id === input.elementId)) throw new ScriptContentError("ELEMENT_NOT_FOUND", "剧本条目不存在");
    const editedAt = this.dependencies.clock().toISOString();
    return this.dependencies.repository.save(actor, {
      ...current, id: this.dependencies.idGenerator(), parentVersionId: current.id,
      createdBy: actor.userId, createdAt: editedAt,
      elements: current.elements.map((element) => element.id === input.elementId ? {
        ...element, text: input.text.trim(), lastEdit: { editedBy: actor.userId, editedAt, reason: input.reason.trim() },
      } : element),
    }, current.id);
  }

  async getRetryCandidate(actor: Actor,p: string,c: string,selection: ScriptRetrySelection) {
    const context = await this.dependencies.contextReader.findGenerationContext(actor,p,c);
    if (!context) throw new ScriptContentError("CONTEXT_NOT_FOUND","剧本依据已变化");
    const current = await this.dependencies.repository.findActive(actor,p,c);
    if (!current || current.sourceVersionId !== context.sourceVersionId || current.planVersionId !== context.planVersionId) throw new ScriptContentError("CONTEXT_NOT_FOUND","剧本依据已变化");
    assertScriptRetrySelection(current,selection);
    return current;
  }
  async recordRetry(actor: Actor,input: {
    projectId: string;chapterId: string;jobId: string;sourceVersionId: string;planVersionId: string;retry: ScriptRetrySnapshot;
    scenes: unknown[];items: Array<{ scopeKey: string;value?: unknown;error?: { code: string;message: string;retryable: boolean } }>;
  }): Promise<ScriptContentVersion> {
    const current = await this.getRetryCandidate(actor,input.projectId,input.chapterId,input.retry);
    if (current.jobId !== input.retry.retryOfJobId || current.sourceVersionId !== input.sourceVersionId || current.planVersionId !== input.planVersionId) throw new ScriptContentError("VERSION_CONFLICT","重试依据已变化");
    if (!Array.isArray(input.items) || input.items.length !== input.retry.scopeKeys.length || input.items.some(i => !isRecord(i) || !nonblank(i.scopeKey)) || new Set(input.items.map(i => i.scopeKey)).size !== input.items.length
      || input.items.some(i => !input.retry.scopeKeys.includes(i.scopeKey)) || !Array.isArray(input.scenes)) throw new ScriptContentError("INVALID_GENERATION","重试返回范围不匹配");
    const scenes: unknown[] = [...current.scenes];
    for (const scene of input.scenes) {
      if (!isRecord(scene)) throw new ScriptContentError("INVALID_GENERATION","重试场次无效");
      const existing = current.scenes.find(s => s.id === scene.id);
      if (existing) {
        if (scene.episodeId !== existing.episodeId || scene.ordinal !== existing.ordinal || scene.title !== existing.title || scene.environment !== existing.environment
          || !Array.isArray(scene.characters) || scene.characters.length !== existing.characters.length || scene.characters.some((v,i) => v !== existing.characters[i])) throw new ScriptContentError("INVALID_GENERATION","重试不得修改既有场次");
      } else scenes.push(scene);
    }
    const protectedItems = input.items.map(item => {
      const value = item.value;
      return isRecord(value) && current.elements.some(e => e.id === value.id || e.sceneId === value.sceneId && e.ordinal === value.ordinal)
        ? { scopeKey: item.scopeKey,error: { code: "EXISTING_ELEMENT",message: "重试不得覆盖成功或锁定内容",retryable: true } } : item;
    });
    // Validate returned items through the same canonical generation rules without a preliminary write.
    const validator = new ScriptContentService({ ...this.dependencies,repository: { findActive: async () => null,save: async (_a,v) => v } });
    const generated = await validator.recordGeneration(actor,{ ...input,expectedActiveVersionId: current.id,scenes,items: protectedItems });
    const failureOrigins = input.retry.scopeKeys.map(scopeKey => ({ scopeKey,jobId: current.failures.find(f => f.scopeKey === scopeKey)!.originJobId ?? current.jobId }));
    if (input.retry.failureOrigins && (input.retry.failureOrigins.length !== failureOrigins.length || failureOrigins.some(f => !input.retry.failureOrigins!.some(other => other.scopeKey === f.scopeKey && other.jobId === f.jobId)))) throw new ScriptContentError("VERSION_CONFLICT","失败来源已变化");
    const failures = [...current.failures.filter(f => !input.retry.scopeKeys.includes(f.scopeKey)).map(f => ({ ...f,originJobId: f.originJobId ?? current.jobId })),...generated.failures];
    const elements = [...current.elements,...generated.elements];
    const { reviewOperation: _reviewOperation,retry: _previousRetry,...unchanged } = current;
    return this.dependencies.repository.save(actor,{
      ...unchanged,id: generated.id,parentVersionId: current.id,jobId: input.jobId,retry: { ...structuredClone(input.retry),failureOrigins },
      createdBy: actor.userId,createdAt: generated.createdAt,elements,failures,
      scenes: generated.scenes.filter(s => current.scenes.some(old => old.id === s.id) || generated.elements.some(e => e.sceneId === s.id)),
      generationStatus: failures.length === 0 ? "succeeded" : elements.length ? "partially_succeeded" : "failed",
    },current.id);
  }

  async recordGeneration(actor: Actor, input: {
    expectedActiveVersionId: string | null; projectId: string; chapterId: string;
    sourceVersionId: string; planVersionId: string; jobId: string;
    scenes: unknown[];
    items: Array<{ scopeKey: string; value?: unknown; error?: { code: string; message: string; retryable: boolean } }>;
  }): Promise<ScriptContentVersion> {
    const context = await this.dependencies.contextReader.findGenerationContext(actor, input.projectId, input.chapterId);
    if (!context) throw new ScriptContentError("CONTEXT_NOT_FOUND", "项目不存在或拆集方案尚未确认");
    const active = await this.dependencies.repository.findActive(actor, input.projectId, input.chapterId);
    if (active && active.status !== "candidate") throw new ScriptContentError("INVALID_STATE", "正式剧本不可被生成任务覆盖");
    if (context.planVersionId !== input.planVersionId || context.sourceVersionId !== input.sourceVersionId) {
      throw new ScriptContentError("INVALID_GENERATION", "剧本生成依据与已确认方案不一致");
    }
    if (!Array.isArray(input.items) || input.items.length === 0
      || input.items.some((item) => !isRecord(item) || !nonblank(item.scopeKey))
      || new Set(input.items.map(({ scopeKey }) => scopeKey)).size !== input.items.length) {
      throw new ScriptContentError("INVALID_GENERATION", "剧本生成条目范围无效");
    }
    const elements: ScriptElement[] = [];
    const scenes: ScriptScene[] = [];
    if (!Array.isArray(input.scenes)) throw new ScriptContentError("INVALID_GENERATION", "缺少场次列表");
    {
      const episodeIds = new Set(context.confirmedPlan?.episodes.map(({ id }) => id));
      for (const scene of input.scenes) {
        if (!isRecord(scene) || !onlyKeys(scene, ["id", "episodeId", "ordinal", "title", "environment", "characters"])
          || !nonblank(scene.id) || !nonblank(scene.episodeId) || !episodeIds.has(scene.episodeId)
          || !nonblank(scene.title) || !nonblank(scene.environment) || !Number.isInteger(scene.ordinal) || Number(scene.ordinal) < 1
          || !Array.isArray(scene.characters) || !scene.characters.every(nonblank)
          || new Set(scene.characters).size !== scene.characters.length || scenes.some(({ id }) => id === scene.id)
          || scenes.some((existing) => existing.episodeId === scene.episodeId && existing.ordinal === scene.ordinal)) {
          throw new ScriptContentError("INVALID_GENERATION", "场次结构或集数归属无效");
        }
        scenes.push(structuredClone(scene) as ScriptScene);
      }
    }
    const failures: ScriptContentVersion["failures"] = [];
    const ids = new Set<string>();
    for (const item of input.items) {
      if (item.error) {
        if (item.value !== undefined || !isRecord(item.error) || !onlyKeys(item.error, ["code", "message", "retryable"])
          || !nonblank(item.error.code) || !nonblank(item.error.message) || typeof item.error.retryable !== "boolean") {
          throw new ScriptContentError("INVALID_GENERATION", "剧本失败条目无效");
        }
        failures.push({ scopeKey: item.scopeKey, code: item.error.code, message: item.error.message, retryable: item.error.retryable });
        continue;
      }
      const value = parseElement(item.value, context);
      if (!value || ids.has(value.id) || elements.some(e => e.sceneId === value.sceneId && e.ordinal === value.ordinal) || !scenes.some(({ id }) => id === value.sceneId)) {
        failures.push({ scopeKey: item.scopeKey, code: "INVALID_ELEMENT", message: "剧本条目结构或出处无效", retryable: true });
      } else { ids.add(value.id); elements.push(value); }
    }
    return this.dependencies.repository.save(actor, {
      id: this.dependencies.idGenerator(), parentVersionId: input.expectedActiveVersionId,
      projectId: input.projectId, chapterId: input.chapterId, sourceVersionId: input.sourceVersionId,
      planVersionId: input.planVersionId, jobId: input.jobId, status: "candidate",
      generationStatus: failures.length === 0 ? "succeeded" : elements.length === 0 ? "failed" : "partially_succeeded",
      createdBy: actor.userId, createdAt: this.dependencies.clock().toISOString(), elements, failures: failures.map(f => ({ ...f,originJobId: input.jobId })), scenes,
    }, input.expectedActiveVersionId);
  }

  async getElementEvidence(actor: Actor, projectId: string, chapterId: string, elementId: string): Promise<Array<{
    id: string; text: string; transformation: Transformation;
  }>> {
    const context = await this.dependencies.contextReader.findGenerationContext(actor, projectId, chapterId);
    if (!context) throw new ScriptContentError("CONTEXT_NOT_FOUND", "项目不存在或拆集方案尚未确认");
    const version = await this.dependencies.repository.findActive(actor, projectId, chapterId);
    if (!version || version.sourceVersionId !== context.sourceVersionId || version.planVersionId !== context.planVersionId) {
      throw new ScriptContentError("CONTEXT_NOT_FOUND", "剧本依据已变化，请查看对应历史版本");
    }
    const element = version.elements.find(({ id }) => id === elementId);
    if (!element) throw new ScriptContentError("ELEMENT_NOT_FOUND", "剧本条目不存在");
    return element.provenance.flatMap((evidence) => {
      if (evidence.type !== "source_fragment") return [];
      const fragment = context.fragments.find(({ id }) => id === evidence.fragmentId);
      return fragment ? [{ ...fragment, transformation: evidence.transformation }] : [];
    });
  }
}

export function assertScriptRetrySelection(current: ScriptContentVersion,selection: ScriptRetrySelection) {
  if (!selection || !nonblank(selection.expectedActiveVersionId) || current.id !== selection.expectedActiveVersionId) throw new ScriptContentError("VERSION_CONFLICT","候选已变化，请重新读取");
  if (current.status !== "candidate") throw new ScriptContentError("INVALID_STATE","只能重试候选失败项");
  if (!Array.isArray(selection.scopeKeys) || !selection.scopeKeys.length || selection.scopeKeys.length > 100 || selection.scopeKeys.some(s => !nonblank(s) || s.length > 256 || /[\r\n]/.test(s))
    || new Set(selection.scopeKeys).size !== selection.scopeKeys.length || selection.scopeKeys.some(s => !current.failures.some(f => f.scopeKey === s && f.retryable))) throw new ScriptContentError("INVALID_GENERATION","只能选择可重试失败范围");
}

function parseElement(value: unknown, context: ScriptGenerationContext): ScriptElement | null {
  if (!isRecord(value) || !onlyKeys(value, ["id", "sceneId", "elementType", "ordinal", "text", "speaker", "provenance"])
    || !nonblank(value.id) || !nonblank(value.sceneId) || !nonblank(value.text)
    || !nonblank(value.elementType) || !["environment", "action", "dialogue", "narration", "sound"].includes(value.elementType)
    || !Number.isInteger(value.ordinal) || Number(value.ordinal) < 1
    || (value.speaker !== undefined && !nonblank(value.speaker))
    || !Array.isArray(value.provenance) || value.provenance.length === 0) return null;
  for (const evidence of value.provenance) {
    if (!isRecord(evidence)) return null;
    if (evidence.type === "source_fragment") {
      if (!onlyKeys(evidence, ["type", "sourceVersionId", "fragmentId", "transformation"])
        || evidence.sourceVersionId !== context.sourceVersionId
        || !context.fragments.some(({ id }) => id === evidence.fragmentId)
        || !nonblank(evidence.transformation)
        || !["retained", "compressed", "merged", "visualized", "actionized", "narrated", "sonified"].includes(evidence.transformation)) return null;
    } else if (evidence.type === "approved_addition") {
      if (!onlyKeys(evidence, ["type", "additionId"]) || !nonblank(evidence.additionId)
        || !context.approvedAdditionIds.includes(evidence.additionId)) return null;
    } else return null;
  }
  return structuredClone(value) as ScriptElement;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonblank(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function scopeKey(actor: Actor, projectId: string, chapterId: string): string { return JSON.stringify([actor.workspaceId, projectId, chapterId]); }
