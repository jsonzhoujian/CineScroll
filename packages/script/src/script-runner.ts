import type { Actor, AspectRatio, NarrativeMode, TargetDurationSeconds, EpisodePlanVersion } from "./index.ts";
import { ScriptContentError, ScriptContentService, type ScriptGenerationContextReader } from "./script-content.ts";

type ScriptRequest = Readonly<{
  contractVersion: "0.1.0"; jobId: string; stage: "script"; projectId: string; chapterId: string;
  sourceVersionId: string; upstreamConfirmedVersionIds: string[]; scopeKeys: string[];
  generationParameters: { targetDurationSeconds: TargetDurationSeconds; aspectRatio: AspectRatio; narrativeMode: NarrativeMode };
  input: { sourceFragments: Array<{ id: string; text: string }>; confirmedUpstreamContent: Array<EpisodePlanVersion | { versionId: string; facts: Array<{ id: string; statement: string }> }>;
    approvedAdditionIds: string[]; lockedItemIds: string[] };
}>;
export interface ScriptModelPort { generate(request: ScriptRequest): Promise<unknown> }
export class ScriptModelError extends Error {
  readonly code: "INVALID_REQUEST" | "INVALID_RESPONSE" | "PROVIDER_UNAVAILABLE";
  constructor(code: ScriptModelError["code"], message: string) { super(message); this.name = "ScriptModelError"; this.code = code; }
}
export class ScriptRunner {
  readonly #options: { contextReader: ScriptGenerationContextReader; service: ScriptContentService; model: ScriptModelPort };
  constructor(options: { contextReader: ScriptGenerationContextReader; service: ScriptContentService; model: ScriptModelPort }) { this.#options = options; }
  async run(actor: Actor, input: {
    projectId: string; chapterId: string; jobId: string; expectedActiveVersionId: string | null;
    generationParameters: ScriptRequest["generationParameters"];
  }) {
    if (![input.projectId, input.chapterId, input.jobId].every(nonblank)
      || ![60, 180, 300].includes(input.generationParameters.targetDurationSeconds)
      || !["9:16", "16:9"].includes(input.generationParameters.aspectRatio)
      || !["narration", "dialogue"].includes(input.generationParameters.narrativeMode)) {
      throw new ScriptModelError("INVALID_REQUEST", "剧本生成参数无效");
    }
    const context = await this.#options.contextReader.findGenerationContext(actor, input.projectId, input.chapterId);
    if (!context) throw new ScriptContentError("CONTEXT_NOT_FOUND", "项目不存在或拆集方案尚未确认");
    if (!context.confirmedPlan || context.confirmedPlan.status !== "confirmed" || context.confirmedPlan.id !== context.planVersionId) {
      throw new ScriptModelError("INVALID_REQUEST", "缺少已确认拆集方案内容");
    }
    if (!context.confirmedStoryKnowledge || context.confirmedStoryKnowledge.versionId !== context.confirmedPlan.storyBibleVersionId) {
      throw new ScriptModelError("INVALID_REQUEST", "缺少与拆集方案一致的已确认故事知识");
    }
    const request: ScriptRequest = freeze(structuredClone({
      contractVersion: "0.1.0", jobId: input.jobId, stage: "script", projectId: input.projectId, chapterId: input.chapterId,
      sourceVersionId: context.sourceVersionId, upstreamConfirmedVersionIds: [context.planVersionId, context.confirmedStoryKnowledge.versionId], scopeKeys: ["script"],
      generationParameters: input.generationParameters, input: { sourceFragments: context.fragments,
        confirmedUpstreamContent: [context.confirmedPlan, context.confirmedStoryKnowledge], approvedAdditionIds: context.approvedAdditionIds, lockedItemIds: [] },
    }));
    let response: unknown;
    try { response = await this.#options.model.generate(request); }
    catch { throw new ScriptModelError("PROVIDER_UNAVAILABLE", "剧本生成服务暂时不可用，请稍后重试"); }
    if (!record(response) || !onlyKeys(response, ["contractVersion", "jobId", "stage", "projectId", "chapterId", "sourceVersionId", "upstreamConfirmedVersionIds", "status", "items", "scenes"])
      || !Array.isArray(response.scenes)
      || response.contractVersion !== request.contractVersion || response.jobId !== request.jobId || response.stage !== "script"
      || response.projectId !== request.projectId || response.chapterId !== request.chapterId || response.sourceVersionId !== request.sourceVersionId
      || !Array.isArray(response.upstreamConfirmedVersionIds) || response.upstreamConfirmedVersionIds.length !== 2
      || response.upstreamConfirmedVersionIds.some((id, index) => id !== request.upstreamConfirmedVersionIds[index]) || !Array.isArray(response.items) || response.items.length === 0) {
      throw new ScriptModelError("INVALID_RESPONSE", "模型响应与剧本任务不匹配");
    }
    const items: Array<{ scopeKey: string; value?: unknown; error?: { code: string; message: string; retryable: boolean } }> = [];
    for (const item of response.items) {
      if (!record(item) || !nonblank(item.scopeKey)) throw new ScriptModelError("INVALID_RESPONSE", "剧本条目范围无效");
      if (item.status === "succeeded" && onlyKeys(item, ["scopeKey", "status", "value"])) {
        items.push({ scopeKey: item.scopeKey, value: item.value });
      } else if (item.status === "failed" && onlyKeys(item, ["scopeKey", "status", "error"]) && record(item.error)
        && onlyKeys(item.error, ["code", "message", "retryable"]) && nonblank(item.error.code) && nonblank(item.error.message) && typeof item.error.retryable === "boolean") {
        items.push({ scopeKey: item.scopeKey, error: { code: item.error.code, message: item.error.message, retryable: item.error.retryable } });
      } else throw new ScriptModelError("INVALID_RESPONSE", "剧本模型返回了无效条目");
    }
    const failures = items.filter(({ error }) => error).length;
    const status = failures === 0 ? "succeeded" : failures === items.length ? "failed" : "partially_succeeded";
    if (response.status !== status || new Set(items.map(({ scopeKey }) => scopeKey)).size !== items.length) {
      throw new ScriptModelError("INVALID_RESPONSE", "剧本模型响应状态或范围不一致");
    }
    return this.#options.service.recordGeneration(actor, { projectId: request.projectId, chapterId: request.chapterId,
      jobId: request.jobId, sourceVersionId: request.sourceVersionId, planVersionId: context.planVersionId,
      expectedActiveVersionId: input.expectedActiveVersionId, items, scenes: response.scenes });
  }
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function nonblank(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).every((key) => keys.includes(key)); }
function freeze<T>(value: T): T { if (typeof value !== "object" || value === null) return value; Object.values(value).forEach(freeze); return Object.freeze(value); }
