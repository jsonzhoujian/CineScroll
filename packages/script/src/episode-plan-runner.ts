import type {
  Actor,
  AspectRatio,
  EpisodePlanItem,
  EpisodePlanVersion,
  MajorAdaptationKind,
  NarrativeMode,
  TargetDurationSeconds,
} from "./index.ts";
import { ScriptError, ScriptService } from "./index.ts";

export type EpisodePlanGenerationRequest = Readonly<{
  contractVersion: "0.1.0";
  jobId: string;
  stage: "script";
  projectId: string;
  chapterId: string;
  sourceVersionId: string;
  upstreamConfirmedVersionIds: readonly string[];
  scopeKeys: readonly string[];
  generationParameters: Readonly<{
    targetDurationSeconds: TargetDurationSeconds;
    aspectRatio: AspectRatio;
    narrativeMode: NarrativeMode;
  }>;
  input: Readonly<{
    sourceFragments: ReadonlyArray<Readonly<{ id: string; text: string }>>;
    confirmedUpstreamContent: ReadonlyArray<Readonly<{
      id: string;
      factType: "character" | "relationship" | "event" | "location" | "prop" | "worldRule";
      statement: string;
      isCoreEvent: boolean;
    }>>;
    approvedAdditionIds: readonly string[];
    lockedItemIds: readonly string[];
  }>;
}>;

export interface EpisodePlanModelPort {
  generate(request: EpisodePlanGenerationRequest): Promise<unknown>;
}

type EpisodePlanRecommendation = Readonly<{
  contractVersion: "0.1.0";
  jobId: string;
  stage: "script";
  resultType: "episodePlan";
  projectId: string;
  chapterId: string;
  sourceVersionId: string;
  upstreamConfirmedVersionIds: string[];
  status: "succeeded";
  recommendationRationale: string;
  episodes: EpisodePlanItem[];
  majorAdaptationProposals: Array<Readonly<{
    id: string;
    kind: MajorAdaptationKind;
    summary: string;
    rationale: string;
    affectedFactIds: string[];
  }>>;
}>;

export class EpisodePlanModelError extends Error {
  readonly code: "INVALID_REQUEST" | "INVALID_RESPONSE" | "PROVIDER_UNAVAILABLE";

  constructor(code: EpisodePlanModelError["code"], message: string) {
    super(message);
    this.name = "EpisodePlanModelError";
    this.code = code;
  }
}

export class EpisodePlanRunner {
  readonly #model: EpisodePlanModelPort;
  readonly #script: ScriptService;

  constructor(options: { model: EpisodePlanModelPort; script: ScriptService }) {
    this.#model = options.model;
    this.#script = options.script;
  }

  async run(
    actor: Actor,
    request: unknown,
    expectedActiveVersionId: string | null,
  ): Promise<EpisodePlanVersion> {
    assertGenerationRequest(request);
    const trustedSnapshot = deepFreeze(structuredClone(request));
    let rawResponse: unknown;
    try {
      rawResponse = await this.#model.generate(trustedSnapshot);
    } catch {
      throw new EpisodePlanModelError("PROVIDER_UNAVAILABLE", "拆集建议服务暂时不可用，请稍后重试");
    }
    const response = parseRecommendation(rawResponse);
    assertMatchingEnvelope(trustedSnapshot, response);
    assertRecommendationEvidence(trustedSnapshot, response);
    try {
      return await this.#script.recordEpisodePlan(actor, {
        expectedActiveVersionId,
        projectId: trustedSnapshot.projectId,
        chapterId: trustedSnapshot.chapterId,
        sourceVersionId: trustedSnapshot.sourceVersionId,
        storyBibleVersionId: trustedSnapshot.upstreamConfirmedVersionIds[0]!,
        generationJobId: trustedSnapshot.jobId,
        ...trustedSnapshot.generationParameters,
        recommendationRationale: response.recommendationRationale,
        episodes: response.episodes,
        majorAdaptationProposals: response.majorAdaptationProposals,
      });
    } catch (error) {
      if (error instanceof ScriptError && error.code === "INVALID_EPISODE_PLAN") {
        throw new EpisodePlanModelError("INVALID_RESPONSE", "拆集建议模型返回了无效内容");
      }
      throw error;
    }
  }
}

function assertGenerationRequest(request: unknown): asserts request is EpisodePlanGenerationRequest {
  if (!isRecord(request)
    || !hasOnlyKeys(request, ["contractVersion", "jobId", "stage", "projectId", "chapterId",
      "sourceVersionId", "upstreamConfirmedVersionIds", "scopeKeys", "generationParameters", "input"])
    || request.contractVersion !== "0.1.0" || request.stage !== "script"
    || !areNonBlankStrings([request.jobId, request.projectId, request.chapterId, request.sourceVersionId])
    || !isUniqueStringArray(request.upstreamConfirmedVersionIds, true)
    || request.upstreamConfirmedVersionIds.length !== 1
    || !isUniqueStringArray(request.scopeKeys, true) || !request.scopeKeys.includes("episode-plan")
    || !isGenerationParameters(request.generationParameters)
    || !isGenerationInput(request.input)) {
    throw new EpisodePlanModelError("INVALID_REQUEST", "拆集建议模型输入快照不符合运行时契约");
  }
}

function parseRecommendation(value: unknown): EpisodePlanRecommendation {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ["contractVersion", "jobId", "stage", "resultType", "projectId", "chapterId",
      "sourceVersionId", "upstreamConfirmedVersionIds", "status", "recommendationRationale", "episodes",
      "majorAdaptationProposals"])
    || value.contractVersion !== "0.1.0" || value.stage !== "script" || value.resultType !== "episodePlan"
    || value.status !== "succeeded" || !areNonBlankStrings([value.jobId, value.projectId, value.chapterId,
      value.sourceVersionId, value.recommendationRationale])
    || !isUniqueStringArray(value.upstreamConfirmedVersionIds, true)
    || !Array.isArray(value.episodes) || value.episodes.length === 0 || !value.episodes.every(isEpisode)
    || !Array.isArray(value.majorAdaptationProposals)
    || !value.majorAdaptationProposals.every(isMajorAdaptationProposal)) {
    throw new EpisodePlanModelError("INVALID_RESPONSE", "拆集建议模型返回了无效响应");
  }
  return structuredClone(value) as EpisodePlanRecommendation;
}

function assertMatchingEnvelope(request: EpisodePlanGenerationRequest, response: EpisodePlanRecommendation): void {
  if (response.jobId !== request.jobId || response.projectId !== request.projectId
    || response.chapterId !== request.chapterId || response.sourceVersionId !== request.sourceVersionId
    || response.upstreamConfirmedVersionIds.length !== request.upstreamConfirmedVersionIds.length
    || response.upstreamConfirmedVersionIds.some((id, index) => id !== request.upstreamConfirmedVersionIds[index])) {
    throw new EpisodePlanModelError("INVALID_RESPONSE", "模型响应与拆集建议任务不匹配");
  }
}

function assertRecommendationEvidence(
  request: EpisodePlanGenerationRequest,
  response: EpisodePlanRecommendation,
): void {
  const fragmentIds = new Set(request.input.sourceFragments.map(({ id }) => id));
  const snapshotFactIds = new Set(request.input.confirmedUpstreamContent.map(({ id }) => id));
  const coreEventFactIds = new Set(request.input.confirmedUpstreamContent
    .filter(({ factType, isCoreEvent }) => factType === "event" && isCoreEvent)
    .map(({ id }) => id));
  if (response.episodes.some((episode) => episode.sourceFragmentIds.some((id) => !fragmentIds.has(id))
    || episode.coreEventFactIds.some((id) => !coreEventFactIds.has(id)))
    || response.majorAdaptationProposals.some((proposal) => proposal.affectedFactIds.some((id) => !snapshotFactIds.has(id)))) {
    throw new EpisodePlanModelError("INVALID_RESPONSE", "拆集建议引用了任务快照之外的原文或核心事件");
  }
  const coveredEvents = new Set(response.episodes.flatMap(({ coreEventFactIds: ids }) => ids));
  if ([...coreEventFactIds].some((id) => !coveredEvents.has(id))) {
    throw new EpisodePlanModelError("INVALID_RESPONSE", "拆集建议遗漏了任务快照中的核心事件");
  }
}

function isEpisode(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["id", "ordinal", "title", "sourceFragmentIds", "coreEventFactIds"])
    && areNonBlankStrings([value.id, value.title]) && Number.isInteger(value.ordinal) && (value.ordinal as number) >= 1
    && isUniqueStringArray(value.sourceFragmentIds, true) && isUniqueStringArray(value.coreEventFactIds, true);
}

function isMajorAdaptationProposal(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["id", "kind", "summary", "rationale", "affectedFactIds"])
    && areNonBlankStrings([value.id, value.summary, value.rationale])
    && ["merge_characters", "delete_core_event", "reorder_events"].includes(value.kind as string)
    && isUniqueStringArray(value.affectedFactIds, true);
}

function isGenerationParameters(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["targetDurationSeconds", "aspectRatio", "narrativeMode"])
    && [60, 180, 300].includes(value.targetDurationSeconds as number)
    && ["9:16", "16:9"].includes(value.aspectRatio as string)
    && ["narration", "dialogue"].includes(value.narrativeMode as string);
}

function isGenerationInput(value: unknown): boolean {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ["sourceFragments", "confirmedUpstreamContent", "approvedAdditionIds", "lockedItemIds"])
    || !Array.isArray(value.sourceFragments) || value.sourceFragments.length === 0
    || !Array.isArray(value.confirmedUpstreamContent) || value.confirmedUpstreamContent.length === 0
    || !value.confirmedUpstreamContent.every(isConfirmedFact)
    || !isUniqueStringArray(value.approvedAdditionIds) || !isUniqueStringArray(value.lockedItemIds)) return false;
  return value.sourceFragments.every((fragment) => isRecord(fragment)
    && hasOnlyKeys(fragment, ["id", "text"]) && areNonBlankStrings([fragment.id, fragment.text]))
    && new Set(value.sourceFragments.map((fragment) => isRecord(fragment) ? fragment.id : undefined)).size
      === value.sourceFragments.length;
}

function isConfirmedFact(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["id", "factType", "statement", "isCoreEvent"])
    && areNonBlankStrings([value.id, value.statement])
    && ["character", "relationship", "event", "location", "prop", "worldRule"].includes(value.factType as string)
    && typeof value.isCoreEvent === "boolean"
    && (value.isCoreEvent === false || value.factType === "event");
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

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
