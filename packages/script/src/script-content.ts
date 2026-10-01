import type { Actor, EpisodePlanVersion, ProjectAccessReader } from "./index.ts";

export type Transformation = "retained" | "compressed" | "merged" | "visualized" | "actionized" | "narrated" | "sonified";
export type ScriptProvenance = Readonly<{
  type: "source_fragment"; sourceVersionId: string; fragmentId: string; transformation: Transformation;
}> | Readonly<{ type: "approved_addition"; additionId: string }>;
export type ScriptElement = Readonly<{
  id: string; sceneId: string; elementType: "environment" | "action" | "dialogue" | "narration" | "sound";
  ordinal: number; text: string; speaker?: string; provenance: ScriptProvenance[];
  lastEdit?: Readonly<{ editedBy: string; editedAt: string; reason: string }>;
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
export type ScriptContentVersion = Readonly<{
  id: string; parentVersionId: string | null; projectId: string; chapterId: string;
  sourceVersionId: string; planVersionId: string; jobId: string; status: "candidate";
  generationStatus: "succeeded" | "partially_succeeded" | "failed";
  createdBy: string; createdAt: string; elements: ScriptElement[];
  scenes: ScriptScene[];
  suggestions?: ScriptSuggestion[];
  failures: Array<Readonly<{ scopeKey: string; code: string; message: string; retryable: boolean }>>;
}>;
export interface ScriptContentRepository {
  findActive(actor: Actor, projectId: string, chapterId: string): Promise<ScriptContentVersion | null>;
  save(actor: Actor, version: ScriptContentVersion, expectedActiveVersionId: string | null): Promise<ScriptContentVersion>;
}
export interface ScriptGenerationContextReader {
  // Returns null unless the actor is a project member and the plan is confirmed.
  findGenerationContext(actor: Actor, projectId: string, chapterId: string): Promise<ScriptGenerationContext | null>;
}
export class ScriptContentError extends Error {
  readonly code: "CONTEXT_NOT_FOUND" | "FORBIDDEN" | "INVALID_GENERATION" | "INVALID_EDIT" | "VERSION_CONFLICT" | "ELEMENT_NOT_FOUND" | "SUGGESTION_NOT_FOUND" | "SUGGESTION_CONFLICT";
  constructor(code: ScriptContentError["code"], message: string) {
    super(message); this.name = "ScriptContentError"; this.code = code;
  }
}
export class InMemoryScriptContentRepository implements ScriptContentRepository {
  readonly #active = new Map<string, ScriptContentVersion>();
  readonly #versions = new Map<string, ScriptContentVersion>();
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
    this.#active.set(key, saved);
    return structuredClone(saved);
  }
}
export class ScriptContentService {
  private readonly dependencies: {
    repository: ScriptContentRepository; contextReader: ScriptGenerationContextReader;
    idGenerator: () => string; clock: () => Date;
    accessReader?: ProjectAccessReader;
  };
  constructor(dependencies: ScriptContentService["dependencies"]) { this.dependencies = dependencies; }

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

  async recordGeneration(actor: Actor, input: {
    expectedActiveVersionId: string | null; projectId: string; chapterId: string;
    sourceVersionId: string; planVersionId: string; jobId: string;
    scenes: unknown[];
    items: Array<{ scopeKey: string; value?: unknown; error?: { code: string; message: string; retryable: boolean } }>;
  }): Promise<ScriptContentVersion> {
    const context = await this.dependencies.contextReader.findGenerationContext(actor, input.projectId, input.chapterId);
    if (!context) throw new ScriptContentError("CONTEXT_NOT_FOUND", "项目不存在或拆集方案尚未确认");
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
      if (!value || ids.has(value.id) || !scenes.some(({ id }) => id === value.sceneId)) {
        failures.push({ scopeKey: item.scopeKey, code: "INVALID_ELEMENT", message: "剧本条目结构或出处无效", retryable: true });
      } else { ids.add(value.id); elements.push(value); }
    }
    return this.dependencies.repository.save(actor, {
      id: this.dependencies.idGenerator(), parentVersionId: input.expectedActiveVersionId,
      projectId: input.projectId, chapterId: input.chapterId, sourceVersionId: input.sourceVersionId,
      planVersionId: input.planVersionId, jobId: input.jobId, status: "candidate",
      generationStatus: failures.length === 0 ? "succeeded" : elements.length === 0 ? "failed" : "partially_succeeded",
      createdBy: actor.userId, createdAt: this.dependencies.clock().toISOString(), elements, failures, scenes,
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
