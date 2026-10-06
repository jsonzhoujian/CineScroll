import type { Actor, StoryKnowledgeVersion } from "./index.ts";
import { parseStoryKnowledgeExtraction, StoryKnowledgeError, StoryKnowledgeService } from "./index.ts";

export type StoryKnowledgeGenerationRequest = Readonly<{
  contractVersion: "0.1.0";
  jobId: string;
  stage: "storyKnowledge";
  projectId: string;
  chapterId: string;
  sourceVersionId: string;
  upstreamConfirmedVersionIds: readonly string[];
  scopeKeys: readonly string[];
  retryOfJobId?: string;
  generationParameters: Readonly<{
    targetDurationSeconds: 60 | 180 | 300;
    aspectRatio: "9:16" | "16:9";
    narrativeMode: "narration" | "dialogue";
  }>;
  input: Readonly<{
    sourceFragments: ReadonlyArray<Readonly<{ id: string; text: string }>>;
    confirmedUpstreamContent: ReadonlyArray<Readonly<Record<string, unknown>>>;
    approvedAdditionIds: readonly string[];
    lockedItemIds: readonly string[];
  }>;
}>;

export interface StoryKnowledgeModelPort {
  generate(request: StoryKnowledgeGenerationRequest): Promise<unknown>;
}

export class StoryKnowledgeModelError extends Error {
  readonly code: "INVALID_REQUEST" | "INVALID_RESPONSE" | "PROVIDER_UNAVAILABLE";

  constructor(code: StoryKnowledgeModelError["code"], message: string) {
    super(message);
    this.name = "StoryKnowledgeModelError";
    this.code = code;
  }
}

export class StoryKnowledgeExtractionRunner {
  readonly #model: StoryKnowledgeModelPort;
  readonly #storyKnowledge: StoryKnowledgeService;

  constructor(options: { model: StoryKnowledgeModelPort; storyKnowledge: StoryKnowledgeService }) {
    this.#model = options.model;
    this.#storyKnowledge = options.storyKnowledge;
  }

  async run(
    actor: Actor,
    request: unknown,
    expectedActiveVersionId: string | null,
  ): Promise<StoryKnowledgeVersion> {
    assertGenerationRequest(request);
    if (request.retryOfJobId && !isNonBlankString(expectedActiveVersionId)) {
      throw new StoryKnowledgeModelError("INVALID_REQUEST", "故事知识重试缺少活动版本基准");
    }
    const trustedSnapshot = deepFreeze(structuredClone(request));
    const response = await this.#model.generate(trustedSnapshot);
    let extraction;
    try {
      extraction = parseStoryKnowledgeExtraction(response);
    } catch (error) {
      if (error instanceof StoryKnowledgeError && error.code === "INVALID_EXTRACTION") {
        throw new StoryKnowledgeModelError("INVALID_RESPONSE", "故事知识模型返回了无效响应");
      }
      throw error;
    }
    assertMatchingEnvelope(trustedSnapshot, extraction);
    try {
      if (trustedSnapshot.retryOfJobId) {
        assertRetryScopes(trustedSnapshot.scopeKeys, extraction);
        return await this.#storyKnowledge.recordRetry(actor, trustedSnapshot.projectId, trustedSnapshot.chapterId, {
          expectedActiveVersionId,
          retryOfJobId: trustedSnapshot.retryOfJobId,
          extraction,
        }, true);
      }
      return await this.#storyKnowledge.recordExtraction(actor, extraction, expectedActiveVersionId);
    } catch (error) {
      if (error instanceof StoryKnowledgeError && error.code === "INVALID_EXTRACTION") {
        throw new StoryKnowledgeModelError("INVALID_RESPONSE", "故事知识模型返回了无效响应");
      }
      throw error;
    }
  }
}

export function assertGenerationRequest(request: unknown): asserts request is StoryKnowledgeGenerationRequest {
  if (!isRecord(request)
    || !hasOnlyKeys(request, ["contractVersion", "jobId", "stage", "projectId", "chapterId", "sourceVersionId",
      "upstreamConfirmedVersionIds", "scopeKeys", "retryOfJobId", "generationParameters", "input"])
    || request.contractVersion !== "0.1.0" || request.stage !== "storyKnowledge"
    || !areNonBlankStrings([request.jobId, request.projectId, request.chapterId, request.sourceVersionId])
    || (request.retryOfJobId !== undefined && !isNonBlankString(request.retryOfJobId))
    || !isUniqueStringArray(request.upstreamConfirmedVersionIds)
    || !isUniqueStringArray(request.scopeKeys, true)
    || !isGenerationParameters(request.generationParameters)
    || !isGenerationInput(request.input)) {
    throw new StoryKnowledgeModelError("INVALID_REQUEST", "故事知识模型输入快照不符合运行时契约");
  }
}

function assertMatchingEnvelope(request: StoryKnowledgeGenerationRequest, response: unknown): void {
  if (!isRecord(response)
    || response.contractVersion !== request.contractVersion
    || response.jobId !== request.jobId
    || response.stage !== request.stage
    || response.projectId !== request.projectId
    || response.chapterId !== request.chapterId
    || response.sourceVersionId !== request.sourceVersionId) {
    throw new StoryKnowledgeModelError("INVALID_RESPONSE", "模型响应与故事知识任务不匹配");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function areNonBlankStrings(values: readonly unknown[]): boolean {
  return values.every(isNonBlankString);
}

function isUniqueStringArray(value: unknown, requireItem = false): value is string[] {
  return Array.isArray(value) && (!requireItem || value.length > 0)
    && value.every(isNonBlankString) && new Set(value).size === value.length;
}

function isGenerationParameters(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ["targetDurationSeconds", "aspectRatio", "narrativeMode"])
    && [60, 180, 300].includes(value.targetDurationSeconds as number)
    && ["9:16", "16:9"].includes(value.aspectRatio as string)
    && ["narration", "dialogue"].includes(value.narrativeMode as string);
}

function isGenerationInput(value: unknown): boolean {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ["sourceFragments", "confirmedUpstreamContent", "approvedAdditionIds", "lockedItemIds"])
    || !Array.isArray(value.sourceFragments) || value.sourceFragments.length === 0
    || !Array.isArray(value.confirmedUpstreamContent) || !value.confirmedUpstreamContent.every(isJsonRecord)
    || !isUniqueStringArray(value.approvedAdditionIds)
    || !isUniqueStringArray(value.lockedItemIds)) return false;
  const fragments = value.sourceFragments;
  return fragments.every((fragment) => isRecord(fragment)
    && typeof fragment.id === "string" && isNonBlankString(fragment.text))
    && new Set(fragments.map((fragment) => fragment.id)).size === fragments.length;
}

function assertRetryScopes(requestedScopes: readonly string[], response: unknown): void {
  if (!isRecord(response) || !Array.isArray(response.items)) {
    throw new StoryKnowledgeModelError("INVALID_RESPONSE", "故事知识模型返回了无效响应");
  }
  const responseScopes = response.items.map((item) => isRecord(item) ? item.scopeKey : undefined);
  if (!responseScopes.every(isNonBlankString)
    || responseScopes.length !== requestedScopes.length
    || new Set(responseScopes).size !== responseScopes.length
    || requestedScopes.some((scope) => !responseScopes.includes(scope))) {
    throw new StoryKnowledgeModelError("INVALID_RESPONSE", "故事知识重试结果与请求范围不匹配");
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return isJsonValue(value, new WeakSet()) && isRecord(value);
}

function isJsonValue(value: unknown, ancestors: WeakSet<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, ancestors))
    : isRecord(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
      && Object.values(value).every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
