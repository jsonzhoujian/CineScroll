export type Actor = Readonly<{ userId: string; workspaceId: string }>;
export type FactType = "character" | "relationship" | "event" | "location" | "prop" | "worldRule";
export type AssertionKind = "explicit" | "inferred" | "user_confirmed";
export type ResolutionStatus = "resolved" | "pending_identity" | "conflicting";
export type ConflictClassification = "setting_change" | "character_misunderstanding" | "author_contradiction" | "other";

export type SourceEvidence = Readonly<{
  sourceVersionId: string;
  fragmentId: string;
}>;

export type StoryFact = Readonly<{
  id: string;
  factType: FactType;
  statement: string;
  assertionKind: AssertionKind;
  resolutionStatus: ResolutionStatus;
  resolutionGroupId: string | null;
  evidence: SourceEvidence[];
  decision?: Readonly<{
    outcome: "accepted" | "rejected";
    conflictClassification?: ConflictClassification;
    decidedBy: string;
    decidedAt: string;
    reason: string;
  }>;
}>;

export type ExtractionFailure = Readonly<{
  scopeKey: string;
  code: string;
  message: string;
  retryable: boolean;
}>;

export type StoryKnowledgeExtraction = Readonly<{
  contractVersion: "0.1.0";
  jobId: string;
  stage: "storyKnowledge";
  projectId: string;
  chapterId: string;
  sourceVersionId: string;
  status: "succeeded" | "partially_succeeded" | "failed";
  items: Array<
    | Readonly<{ scopeKey: string; status: "succeeded"; value: StoryFact }>
    | Readonly<{ scopeKey: string; status: "failed"; error: { code: string; message: string; retryable: boolean } }>
  >;
}>;

export type StoryKnowledgeVersion = Readonly<{
  id: string;
  parentVersionId: string | null;
  projectId: string;
  chapterId: string;
  sourceVersionId: string;
  extractionJobId: string;
  createdAt: string;
  createdBy: string;
  extractionStatus: "succeeded" | "partially_succeeded" | "failed";
  status: "candidate" | "needs_resolution";
  facts: StoryFact[];
  failures: ExtractionFailure[];
}>;

export interface StoryKnowledgeRepository {
  saveCandidate(
    actor: Actor,
    version: StoryKnowledgeVersion,
    expectedActiveVersionId?: string | null,
  ): Promise<StoryKnowledgeVersion>;
  findActive(actor: Actor, projectId: string, chapterId: string): Promise<StoryKnowledgeVersion | null>;
  findVersion(
    actor: Actor,
    projectId: string,
    chapterId: string,
    versionId: string,
  ): Promise<StoryKnowledgeVersion | null>;
}

export interface SourceVersionReader {
  findSourceVersion(
    actor: Actor,
    projectId: string,
    chapterId: string,
    sourceVersionId: string,
  ): Promise<{ id: string; fragmentIds: string[] } | null>;
}

export class StoryKnowledgeError extends Error {
  readonly code:
    | "SOURCE_VERSION_NOT_FOUND"
    | "INVALID_EXTRACTION"
    | "STAGE_RESULT_NOT_FOUND"
    | "FACT_NOT_FOUND"
    | "FACT_NOT_PENDING"
    | "INVALID_DECISION"
    | "VERSION_CONFLICT";

  constructor(code: StoryKnowledgeError["code"], message: string) {
    super(message);
    this.name = "StoryKnowledgeError";
    this.code = code;
  }
}

export class InMemoryStoryKnowledgeRepository implements StoryKnowledgeRepository {
  readonly #activeVersionIds = new Map<string, string>();
  readonly #versions = new Map<string, StoryKnowledgeVersion>();

  async saveCandidate(
    actor: Actor,
    version: StoryKnowledgeVersion,
    expectedActiveVersionId?: string | null,
  ): Promise<StoryKnowledgeVersion> {
    const saved = structuredClone(version);
    const stageKey = key(actor, version.projectId, version.chapterId);
    if (expectedActiveVersionId !== undefined
      && (this.#activeVersionIds.get(stageKey) ?? null) !== expectedActiveVersionId) {
      throw new StoryKnowledgeError("VERSION_CONFLICT", "故事知识已被其他操作更新，请刷新后重试");
    }
    this.#versions.set(versionKey(stageKey, version.id), saved);
    this.#activeVersionIds.set(stageKey, version.id);
    return structuredClone(saved);
  }

  async findActive(actor: Actor, projectId: string, chapterId: string): Promise<StoryKnowledgeVersion | null> {
    const stageKey = key(actor, projectId, chapterId);
    const activeVersionId = this.#activeVersionIds.get(stageKey);
    const version = activeVersionId ? this.#versions.get(versionKey(stageKey, activeVersionId)) : undefined;
    return version ? structuredClone(version) : null;
  }

  async findVersion(
    actor: Actor,
    projectId: string,
    chapterId: string,
    versionId: string,
  ): Promise<StoryKnowledgeVersion | null> {
    const version = this.#versions.get(versionKey(key(actor, projectId, chapterId), versionId));
    return version ? structuredClone(version) : null;
  }
}

export class StoryKnowledgeService {
  readonly #repository: StoryKnowledgeRepository;
  readonly #sourceReader: SourceVersionReader;
  readonly #idGenerator: () => string;
  readonly #clock: () => Date;

  constructor(options: {
    repository: StoryKnowledgeRepository;
    sourceReader: SourceVersionReader;
    idGenerator: () => string;
    clock: () => Date;
  }) {
    this.#repository = options.repository;
    this.#sourceReader = options.sourceReader;
    this.#idGenerator = options.idGenerator;
    this.#clock = options.clock;
  }

  async recordExtraction(
    actor: Actor,
    input: unknown,
    expectedActiveVersionId: string | null = null,
  ): Promise<StoryKnowledgeVersion> {
    const extraction = parseExtraction(input);
    const source = await this.#sourceReader.findSourceVersion(
      actor,
      extraction.projectId,
      extraction.chapterId,
      extraction.sourceVersionId,
    );
    if (!source || source.id !== extraction.sourceVersionId) {
      throw new StoryKnowledgeError("SOURCE_VERSION_NOT_FOUND", "原文版本不存在或无权访问");
    }

    const fragmentIds = new Set(source.fragmentIds);
    const facts: StoryFact[] = [];
    const failures: ExtractionFailure[] = [];
    for (const item of extraction.items) {
      if (item.status === "failed") {
        failures.push({ scopeKey: item.scopeKey, ...item.error });
        continue;
      }
      if (item.value.evidence.length === 0) {
        failures.push({
          scopeKey: item.scopeKey,
          code: "EVIDENCE_REQUIRED",
          message: "每条故事知识必须关联至少一个原文片段",
          retryable: true,
        });
        continue;
      }
      if (item.value.evidence.some(
        (evidence) => evidence.sourceVersionId !== source.id || !fragmentIds.has(evidence.fragmentId),
      )) {
        failures.push({
          scopeKey: item.scopeKey,
          code: "INVALID_EVIDENCE",
          message: "故事知识引用了无效的原文证据",
          retryable: true,
        });
        continue;
      }
      facts.push(structuredClone(item.value));
    }

    return this.#repository.saveCandidate(actor, {
      id: this.#idGenerator(),
      parentVersionId: expectedActiveVersionId,
      projectId: extraction.projectId,
      chapterId: extraction.chapterId,
      sourceVersionId: extraction.sourceVersionId,
      extractionJobId: extraction.jobId,
      createdAt: this.#clock().toISOString(),
      createdBy: actor.userId,
      extractionStatus: finalExtractionStatus(facts.length, failures.length),
      status: facts.some(({ resolutionStatus }) => resolutionStatus !== "resolved") ? "needs_resolution" : "candidate",
      facts,
      failures,
    }, expectedActiveVersionId);
  }

  async getRetryableScopes(actor: Actor, projectId: string, chapterId: string): Promise<string[]> {
    const version = await this.#repository.findActive(actor, projectId, chapterId);
    if (!version) throw new StoryKnowledgeError("STAGE_RESULT_NOT_FOUND", "故事知识阶段结果不存在");
    const source = await this.#sourceReader.findSourceVersion(
      actor,
      projectId,
      chapterId,
      version.sourceVersionId,
    );
    if (!source || source.id !== version.sourceVersionId) {
      throw new StoryKnowledgeError("STAGE_RESULT_NOT_FOUND", "故事知识阶段结果不存在");
    }
    return version.failures.filter(({ retryable }) => retryable).map(({ scopeKey }) => scopeKey);
  }

  async getVersion(
    actor: Actor,
    projectId: string,
    chapterId: string,
    versionId: string,
  ): Promise<StoryKnowledgeVersion> {
    const version = await this.#repository.findVersion(actor, projectId, chapterId, versionId);
    if (!version) throw new StoryKnowledgeError("STAGE_RESULT_NOT_FOUND", "故事知识阶段结果不存在");
    const source = await this.#sourceReader.findSourceVersion(
      actor,
      projectId,
      chapterId,
      version.sourceVersionId,
    );
    if (!source || source.id !== version.sourceVersionId) {
      throw new StoryKnowledgeError("STAGE_RESULT_NOT_FOUND", "故事知识阶段结果不存在");
    }
    return version;
  }

  async resolveFact(
    actor: Actor,
    projectId: string,
    chapterId: string,
    input: unknown,
  ): Promise<StoryKnowledgeVersion> {
    const decision = parseDecision(input);
    const { factId, alternativeFactIds, statement, reason, conflictClassification } = decision;
    if (new Set([factId, ...alternativeFactIds]).size !== alternativeFactIds.length + 1) {
      throw new StoryKnowledgeError("INVALID_DECISION", "同一事实不能同时作为确认项和被否决项");
    }
    const current = await this.#repository.findActive(actor, projectId, chapterId);
    if (!current) throw new StoryKnowledgeError("STAGE_RESULT_NOT_FOUND", "故事知识阶段结果不存在");
    const source = await this.#sourceReader.findSourceVersion(
      actor,
      projectId,
      chapterId,
      current.sourceVersionId,
    );
    if (!source || source.id !== current.sourceVersionId) {
      throw new StoryKnowledgeError("STAGE_RESULT_NOT_FOUND", "故事知识阶段结果不存在");
    }

    const target = current.facts.find((fact) => fact.id === factId);
    if (!target) throw new StoryKnowledgeError("FACT_NOT_FOUND", "待确认故事知识不存在");
    if (target.resolutionStatus === "resolved") {
      throw new StoryKnowledgeError("FACT_NOT_PENDING", "故事知识没有待处理的不确定项");
    }
    if (!target.resolutionGroupId) {
      throw new StoryKnowledgeError("INVALID_DECISION", "待确认故事知识缺少候选组");
    }
    const unresolvedGroupIds = current.facts
      .filter((fact) => fact.resolutionGroupId === target.resolutionGroupId && fact.resolutionStatus !== "resolved")
      .map((fact) => fact.id);
    const decidedIds = new Set([factId, ...alternativeFactIds]);
    if (unresolvedGroupIds.length !== decidedIds.size
      || unresolvedGroupIds.some((id) => !decidedIds.has(id))) {
      throw new StoryKnowledgeError("INVALID_DECISION", "一次决定必须处理同一候选组的全部未决事实");
    }
    const involvesConflict = target.resolutionStatus === "conflicting";
    for (const alternativeFactId of alternativeFactIds) {
      const alternative = current.facts.find((fact) => fact.id === alternativeFactId);
      if (!alternative) throw new StoryKnowledgeError("FACT_NOT_FOUND", "冲突故事知识不存在");
      if (alternative.resolutionStatus === "resolved") {
        throw new StoryKnowledgeError("FACT_NOT_PENDING", "冲突故事知识没有待处理的不确定项");
      }
      if (alternative.resolutionGroupId !== target.resolutionGroupId
        || alternative.resolutionStatus !== target.resolutionStatus) {
        throw new StoryKnowledgeError("INVALID_DECISION", "只能同时处理同一候选组中的同类事实");
      }
    }
    if (involvesConflict && !conflictClassification) {
      throw new StoryKnowledgeError("INVALID_DECISION", "冲突事实必须选择冲突分类");
    }
    const decidedAt = this.#clock().toISOString();
    const rejected = new Set(alternativeFactIds);
    const decisionDetails = {
      decidedBy: actor.userId,
      decidedAt,
      reason,
      ...(conflictClassification ? { conflictClassification } : {}),
    };
    const facts = current.facts.map((fact): StoryFact => {
      if (fact.id === factId) return {
        ...structuredClone(fact),
        statement,
        assertionKind: "user_confirmed",
        resolutionStatus: "resolved",
        decision: { outcome: "accepted", ...decisionDetails },
      };
      if (rejected.has(fact.id)) return {
        ...structuredClone(fact),
        resolutionStatus: "resolved",
        decision: { outcome: "rejected", ...decisionDetails },
      };
      return structuredClone(fact);
    });

    return this.#repository.saveCandidate(actor, {
      ...current,
      id: this.#idGenerator(),
      parentVersionId: current.id,
      createdAt: decidedAt,
      createdBy: actor.userId,
      status: facts.some(({ resolutionStatus }) => resolutionStatus !== "resolved") ? "needs_resolution" : "candidate",
      facts,
    }, current.id);
  }
}

const FACT_TYPES = ["character", "relationship", "event", "location", "prop", "worldRule"] as const;
const ASSERTION_KINDS = ["explicit", "inferred", "user_confirmed"] as const;
const RESOLUTION_STATUSES = ["resolved", "pending_identity", "conflicting"] as const;
const EXTRACTION_STATUSES = ["succeeded", "partially_succeeded", "failed"] as const;
const CONFLICT_CLASSIFICATIONS = ["setting_change", "character_misunderstanding", "author_contradiction", "other"] as const;

function parseExtraction(input: unknown): StoryKnowledgeExtraction {
  const root = recordWithKeys(input, [
    "contractVersion", "jobId", "stage", "projectId", "chapterId", "sourceVersionId", "status", "items",
  ]);
  if (root.contractVersion !== "0.1.0" || root.stage !== "storyKnowledge") invalidExtraction();
  const status = enumValue(root.status, EXTRACTION_STATUSES);
  if (!Array.isArray(root.items)) invalidExtraction();

  const items: StoryKnowledgeExtraction["items"] = root.items.map((candidate) => {
    const item = record(candidate);
    if (item.status === "succeeded") {
      exactKeys(item, ["scopeKey", "status", "value"]);
      const value = recordWithKeys(item.value, [
        "id", "factType", "statement", "assertionKind", "resolutionStatus", "resolutionGroupId", "evidence",
      ]);
      if (!Array.isArray(value.evidence)) invalidExtraction();
      const resolutionStatus = enumValue(value.resolutionStatus, RESOLUTION_STATUSES);
      const resolutionGroupId = value.resolutionGroupId === null ? null : nonBlank(value.resolutionGroupId);
      if (resolutionStatus !== "resolved" && resolutionGroupId === null) invalidExtraction();
      return {
        scopeKey: nonBlank(item.scopeKey),
        status: "succeeded",
        value: {
          id: nonBlank(value.id),
          factType: enumValue(value.factType, FACT_TYPES),
          statement: nonBlank(value.statement),
          assertionKind: enumValue(value.assertionKind, ASSERTION_KINDS),
          resolutionStatus,
          resolutionGroupId,
          evidence: value.evidence.map((candidateEvidence) => {
            const evidence = recordWithKeys(candidateEvidence, ["sourceVersionId", "fragmentId"]);
            return {
              sourceVersionId: nonBlank(evidence.sourceVersionId),
              fragmentId: nonBlank(evidence.fragmentId),
            };
          }),
        },
      };
    }
    if (item.status === "failed") {
      exactKeys(item, ["scopeKey", "status", "error"]);
      const error = recordWithKeys(item.error, ["code", "message", "retryable"]);
      if (typeof error.retryable !== "boolean") invalidExtraction();
      return {
        scopeKey: nonBlank(item.scopeKey),
        status: "failed",
        error: {
          code: nonBlank(error.code),
          message: nonBlank(error.message),
          retryable: error.retryable,
        },
      };
    }
    return invalidExtraction();
  });

  const succeeded = items.filter((item) => item.status === "succeeded").length;
  const failed = items.length - succeeded;
  const consistent =
    (status === "succeeded" && succeeded > 0 && failed === 0)
    || (status === "failed" && failed > 0 && succeeded === 0)
    || (status === "partially_succeeded" && succeeded > 0 && failed > 0);
  if (!consistent) invalidExtraction();

  return {
    contractVersion: "0.1.0",
    jobId: nonBlank(root.jobId),
    stage: "storyKnowledge",
    projectId: nonBlank(root.projectId),
    chapterId: nonBlank(root.chapterId),
    sourceVersionId: nonBlank(root.sourceVersionId),
    status,
    items,
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalidExtraction();
  return value as Record<string, unknown>;
}

function recordWithKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const result = record(value);
  exactKeys(result, keys);
  return result;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const expected = new Set(keys);
  if (Object.keys(value).length !== expected.size || Object.keys(value).some((key) => !expected.has(key))) {
    invalidExtraction();
  }
}

function nonBlank(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) return invalidExtraction();
  return value;
}

function enumValue<const T extends readonly string[]>(value: unknown, options: T): T[number] {
  if (typeof value !== "string" || !options.includes(value)) return invalidExtraction();
  return value as T[number];
}

function invalidExtraction(): never {
  throw new StoryKnowledgeError("INVALID_EXTRACTION", "故事知识提取结果不符合运行时契约");
}

function parseDecision(input: unknown): {
  factId: string;
  alternativeFactIds: string[];
  statement: string;
  reason: string;
  conflictClassification?: ConflictClassification;
} {
  let value: Record<string, unknown>;
  try {
    value = record(input);
  } catch {
    return invalidDecision();
  }
  const allowed = new Set(["factId", "alternativeFactIds", "statement", "reason", "conflictClassification"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalidDecision();
  if (value.alternativeFactIds !== undefined && !Array.isArray(value.alternativeFactIds)) invalidDecision();
  try {
    return {
      factId: nonBlank(value.factId),
      alternativeFactIds: (value.alternativeFactIds ?? []).map((id) => nonBlank(id)),
      statement: nonBlank(value.statement),
      reason: nonBlank(value.reason),
      ...(value.conflictClassification === undefined ? {} : {
        conflictClassification: enumValue(value.conflictClassification, CONFLICT_CLASSIFICATIONS),
      }),
    };
  } catch {
    return invalidDecision();
  }
}

function invalidDecision(): never {
  throw new StoryKnowledgeError("INVALID_DECISION", "故事知识决定不符合运行时契约");
}

function finalExtractionStatus(
  succeeded: number,
  failed: number,
): StoryKnowledgeVersion["extractionStatus"] {
  if (succeeded > 0 && failed > 0) return "partially_succeeded";
  if (succeeded > 0) return "succeeded";
  return "failed";
}

function key(actor: Actor, projectId: string, chapterId: string): string {
  return `${actor.workspaceId}:${projectId}:${chapterId}`;
}

function versionKey(stageKey: string, versionId: string): string {
  return `${stageKey}:${versionId}`;
}
