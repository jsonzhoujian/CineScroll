export type Actor = Readonly<{ userId: string; workspaceId: string }>;
export type FactType = "character" | "relationship" | "event" | "location" | "prop" | "worldRule";
export type AssertionKind = "explicit" | "inferred" | "user_confirmed";
export type ResolutionStatus = "resolved" | "pending_identity" | "conflicting";

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
  evidence: SourceEvidence[];
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
  saveCandidate(actor: Actor, version: StoryKnowledgeVersion): Promise<StoryKnowledgeVersion>;
  findActive(actor: Actor, projectId: string, chapterId: string): Promise<StoryKnowledgeVersion | null>;
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
  readonly code: "SOURCE_VERSION_NOT_FOUND" | "INVALID_EXTRACTION" | "STAGE_RESULT_NOT_FOUND";

  constructor(code: StoryKnowledgeError["code"], message: string) {
    super(message);
    this.name = "StoryKnowledgeError";
    this.code = code;
  }
}

export class InMemoryStoryKnowledgeRepository implements StoryKnowledgeRepository {
  readonly #versions = new Map<string, StoryKnowledgeVersion>();

  async saveCandidate(actor: Actor, version: StoryKnowledgeVersion): Promise<StoryKnowledgeVersion> {
    const saved = structuredClone(version);
    this.#versions.set(key(actor, version.projectId, version.chapterId), saved);
    return structuredClone(saved);
  }

  async findActive(actor: Actor, projectId: string, chapterId: string): Promise<StoryKnowledgeVersion | null> {
    const version = this.#versions.get(key(actor, projectId, chapterId));
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

  async recordExtraction(actor: Actor, input: unknown): Promise<StoryKnowledgeVersion> {
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
    });
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
}

const FACT_TYPES = ["character", "relationship", "event", "location", "prop", "worldRule"] as const;
const ASSERTION_KINDS = ["explicit", "inferred", "user_confirmed"] as const;
const RESOLUTION_STATUSES = ["resolved", "pending_identity", "conflicting"] as const;
const EXTRACTION_STATUSES = ["succeeded", "partially_succeeded", "failed"] as const;

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
        "id", "factType", "statement", "assertionKind", "resolutionStatus", "evidence",
      ]);
      if (!Array.isArray(value.evidence)) invalidExtraction();
      return {
        scopeKey: nonBlank(item.scopeKey),
        status: "succeeded",
        value: {
          id: nonBlank(value.id),
          factType: enumValue(value.factType, FACT_TYPES),
          statement: nonBlank(value.statement),
          assertionKind: enumValue(value.assertionKind, ASSERTION_KINDS),
          resolutionStatus: enumValue(value.resolutionStatus, RESOLUTION_STATUSES),
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
