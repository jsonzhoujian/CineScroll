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
  lastEdit?: Readonly<{
    editedBy: string;
    editedAt: string;
    reason: string;
  }>;
  locked?: boolean;
  lockedBy?: string;
  lockedAt?: string;
  lockHistory?: Array<Readonly<{
    action: "lock" | "unlock";
    actorId: string;
    at: string;
    reason: string;
  }>>;
}>;

export type ExtractionFailure = Readonly<{
  scopeKey: string;
  originJobId: string;
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
  status: "candidate" | "needs_resolution" | "confirmed";
  confirmedBy?: string;
  confirmedAt?: string;
  facts: StoryFact[];
  failures: ExtractionFailure[];
}>;

export type StoryBible = Readonly<{
  id: string;
  versionId: string;
  projectId: string;
  chapterId: string;
  confirmedBy: string;
  confirmedAt: string;
  facts: StoryFact[];
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
  findRetryResult(
    actor: Actor,
    projectId: string,
    chapterId: string,
    idempotencyKey: string,
  ): Promise<{ fingerprint: string; version: StoryKnowledgeVersion } | null>;
  saveRetryCandidate(
    actor: Actor,
    version: StoryKnowledgeVersion,
    expectedActiveVersionId: string,
    idempotencyKey: string,
    fingerprint: string,
  ): Promise<StoryKnowledgeVersion>;
  saveConfirmed(
    actor: Actor,
    version: StoryKnowledgeVersion,
    storyBible: StoryBible,
    expectedActiveVersionId: string,
    confirmation?: { candidateVersionId: string; fingerprint: string },
  ): Promise<{ version: StoryKnowledgeVersion; storyBible: StoryBible }>;
  findConfirmedStoryBible(actor: Actor, projectId: string, chapterId: string): Promise<StoryBible | null>;
  findConfirmationResult(
    actor: Actor,
    projectId: string,
    chapterId: string,
    candidateVersionId: string,
  ): Promise<{ fingerprint: string; version: StoryKnowledgeVersion; storyBible: StoryBible } | null>;
}

export interface SourceVersionReader {
  findSourceVersion(
    actor: Actor,
    projectId: string,
    chapterId: string,
    sourceVersionId: string,
  ): Promise<{ id: string; fragmentIds: string[] } | null>;
}

export interface ProjectAccessReader {
  findProjectAccess(
    actor: Actor,
    projectId: string,
  ): Promise<{ role: "owner" | "editor" | "reviewer" } | null>;
}

export class StoryKnowledgeError extends Error {
  readonly code:
    | "SOURCE_VERSION_NOT_FOUND"
    | "INVALID_EXTRACTION"
    | "STAGE_RESULT_NOT_FOUND"
    | "FACT_NOT_FOUND"
    | "FACT_NOT_PENDING"
    | "INVALID_DECISION"
    | "INVALID_EDIT"
    | "INVALID_REVIEW"
    | "INVALID_RETRY"
    | "INVALID_CONFIRMATION"
    | "INVALID_LOCK"
    | "FORBIDDEN"
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
  readonly #retryResults = new Map<string, { fingerprint: string; versionId: string }>();
  readonly #confirmedVersionIds = new Map<string, string>();
  readonly #storyBibles = new Map<string, StoryBible>();
  readonly #confirmationResults = new Map<string, { fingerprint: string; versionId: string }>();

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

  async findRetryResult(
    actor: Actor,
    projectId: string,
    chapterId: string,
    idempotencyKey: string,
  ): Promise<{ fingerprint: string; version: StoryKnowledgeVersion } | null> {
    const stageKey = key(actor, projectId, chapterId);
    const result = this.#retryResults.get(versionKey(stageKey, idempotencyKey));
    if (!result) return null;
    const version = this.#versions.get(versionKey(stageKey, result.versionId));
    return version ? { fingerprint: result.fingerprint, version: structuredClone(version) } : null;
  }

  async saveRetryCandidate(
    actor: Actor,
    version: StoryKnowledgeVersion,
    expectedActiveVersionId: string,
    idempotencyKey: string,
    fingerprint: string,
  ): Promise<StoryKnowledgeVersion> {
    const stageKey = key(actor, version.projectId, version.chapterId);
    const resultKey = versionKey(stageKey, idempotencyKey);
    const existing = this.#retryResults.get(resultKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new StoryKnowledgeError("INVALID_RETRY", "相同重试任务返回了不同内容");
      }
      const saved = this.#versions.get(versionKey(stageKey, existing.versionId));
      if (saved) return structuredClone(saved);
    }
    const saved = await this.saveCandidate(actor, version, expectedActiveVersionId);
    this.#retryResults.set(resultKey, { fingerprint, versionId: saved.id });
    return saved;
  }

  async saveConfirmed(
    actor: Actor,
    version: StoryKnowledgeVersion,
    storyBible: StoryBible,
    expectedActiveVersionId: string,
    confirmation?: { candidateVersionId: string; fingerprint: string },
  ): Promise<{ version: StoryKnowledgeVersion; storyBible: StoryBible }> {
    const stageKey = key(actor, version.projectId, version.chapterId);
    if (confirmation) {
      const resultKey = versionKey(stageKey, confirmation.candidateVersionId);
      const existing = this.#confirmationResults.get(resultKey);
      if (existing) {
        if (existing.fingerprint !== confirmation.fingerprint) {
          throw new StoryKnowledgeError("INVALID_CONFIRMATION", "同一候选版本收到了不同的确认命令");
        }
        const existingVersion = this.#versions.get(versionKey(stageKey, existing.versionId));
        const existingBible = this.#storyBibles.get(versionKey(stageKey, existing.versionId));
        if (existingVersion && existingBible) return {
          version: structuredClone(existingVersion),
          storyBible: structuredClone(existingBible),
        };
      }
    }
    if ((this.#activeVersionIds.get(stageKey) ?? null) !== expectedActiveVersionId) {
      throw new StoryKnowledgeError("VERSION_CONFLICT", "故事知识已被其他操作更新，请刷新后重试");
    }
    const saved = structuredClone(version);
    this.#versions.set(versionKey(stageKey, saved.id), saved);
    this.#activeVersionIds.set(stageKey, saved.id);
    this.#confirmedVersionIds.set(stageKey, saved.id);
    this.#storyBibles.set(versionKey(stageKey, saved.id), structuredClone(storyBible));
    if (confirmation) {
      this.#confirmationResults.set(versionKey(stageKey, confirmation.candidateVersionId), {
        fingerprint: confirmation.fingerprint,
        versionId: saved.id,
      });
    }
    return { version: structuredClone(saved), storyBible: structuredClone(storyBible) };
  }

  async findConfirmedStoryBible(actor: Actor, projectId: string, chapterId: string): Promise<StoryBible | null> {
    const stageKey = key(actor, projectId, chapterId);
    const confirmedVersionId = this.#confirmedVersionIds.get(stageKey);
    const storyBible = confirmedVersionId
      ? this.#storyBibles.get(versionKey(stageKey, confirmedVersionId))
      : undefined;
    return storyBible ? structuredClone(storyBible) : null;
  }

  async findConfirmationResult(
    actor: Actor,
    projectId: string,
    chapterId: string,
    candidateVersionId: string,
  ): Promise<{ fingerprint: string; version: StoryKnowledgeVersion; storyBible: StoryBible } | null> {
    const stageKey = key(actor, projectId, chapterId);
    const result = this.#confirmationResults.get(versionKey(stageKey, candidateVersionId));
    if (!result) return null;
    const version = this.#versions.get(versionKey(stageKey, result.versionId));
    const storyBible = this.#storyBibles.get(versionKey(stageKey, result.versionId));
    return version && storyBible ? {
      fingerprint: result.fingerprint,
      version: structuredClone(version),
      storyBible: structuredClone(storyBible),
    } : null;
  }
}

export class StoryKnowledgeService {
  readonly #repository: StoryKnowledgeRepository;
  readonly #sourceReader: SourceVersionReader;
  readonly #projectAccessReader: ProjectAccessReader | undefined;
  readonly #idGenerator: () => string;
  readonly #clock: () => Date;

  constructor(options: {
    repository: StoryKnowledgeRepository;
    sourceReader: SourceVersionReader;
    projectAccessReader?: ProjectAccessReader;
    idGenerator: () => string;
    clock: () => Date;
  }) {
    this.#repository = options.repository;
    this.#sourceReader = options.sourceReader;
    this.#projectAccessReader = options.projectAccessReader;
    this.#idGenerator = options.idGenerator;
    this.#clock = options.clock;
  }

  async recordExtraction(
    actor: Actor,
    input: unknown,
    expectedActiveVersionId: string | null = null,
  ): Promise<StoryKnowledgeVersion> {
    const extraction = parseStoryKnowledgeExtraction(input);
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
        failures.push({ scopeKey: item.scopeKey, originJobId: extraction.jobId, ...item.error });
        continue;
      }
      if (item.value.evidence.length === 0) {
        failures.push({
          scopeKey: item.scopeKey,
          originJobId: extraction.jobId,
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
          originJobId: extraction.jobId,
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

  async getActive(
    actor: Actor,
    projectId: string,
    chapterId: string,
  ): Promise<StoryKnowledgeVersion> {
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
    return version;
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
    const { expectedActiveVersionId, factId, alternativeFactIds, statement, reason, conflictClassification } = decision;
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
    if (current.id !== expectedActiveVersionId) {
      throw new StoryKnowledgeError("VERSION_CONFLICT", "故事知识已被其他操作更新，请刷新后重试");
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

  async editFact(
    actor: Actor,
    projectId: string,
    chapterId: string,
    input: unknown,
  ): Promise<StoryKnowledgeVersion> {
    const edit = parseFactEdit(input);
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
    if (current.id !== edit.expectedActiveVersionId) {
      throw new StoryKnowledgeError("VERSION_CONFLICT", "故事知识已被其他操作更新，请刷新后重试");
    }
    const target = current.facts.find((fact) => fact.id === edit.factId);
    if (!target) throw new StoryKnowledgeError("FACT_NOT_FOUND", "故事事实不存在");
    if (target.decision) throw new StoryKnowledgeError("INVALID_EDIT", "已接受或拒绝的故事事实不能直接编辑");
    const editedAt = this.#clock().toISOString();
    const facts = current.facts.map((fact): StoryFact => fact.id === edit.factId ? {
      ...structuredClone(fact),
      statement: edit.statement,
      assertionKind: "user_confirmed",
      lastEdit: { editedBy: actor.userId, editedAt, reason: edit.reason },
    } : structuredClone(fact));
    return this.#repository.saveCandidate(actor, {
      ...current,
      id: this.#idGenerator(),
      parentVersionId: current.id,
      createdAt: editedAt,
      createdBy: actor.userId,
      facts,
    }, current.id);
  }

  async reviewFact(
    actor: Actor,
    projectId: string,
    chapterId: string,
    input: unknown,
  ): Promise<StoryKnowledgeVersion> {
    const review = parseFactReview(input);
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
    if (current.id !== review.expectedActiveVersionId) {
      throw new StoryKnowledgeError("VERSION_CONFLICT", "故事知识已被其他操作更新，请刷新后重试");
    }
    const target = current.facts.find((fact) => fact.id === review.factId);
    if (!target) throw new StoryKnowledgeError("FACT_NOT_FOUND", "故事事实不存在");
    if (target.resolutionStatus !== "resolved" || target.decision) {
      throw new StoryKnowledgeError("INVALID_REVIEW", "故事事实尚不可审核或已经处理");
    }
    const decidedAt = this.#clock().toISOString();
    const facts = current.facts.map((fact): StoryFact => fact.id === review.factId ? {
      ...structuredClone(fact),
      decision: {
        outcome: review.outcome,
        decidedBy: actor.userId,
        decidedAt,
        reason: review.reason,
      },
    } : structuredClone(fact));
    return this.#repository.saveCandidate(actor, {
      ...current,
      id: this.#idGenerator(),
      parentVersionId: current.id,
      createdAt: decidedAt,
      createdBy: actor.userId,
      facts,
    }, current.id);
  }

  async recordRetry(
    actor: Actor,
    projectId: string,
    chapterId: string,
    input: unknown,
  ): Promise<StoryKnowledgeVersion> {
    const command = parseRetryCommand(input);
    const { expectedActiveVersionId, retryOfJobId, extraction } = command;
    if (extraction.projectId !== projectId || extraction.chapterId !== chapterId) {
      throw new StoryKnowledgeError("INVALID_RETRY", "重试结果不属于当前项目章节");
    }
    const requestedScopes = extraction.items.map(({ scopeKey }) => scopeKey);
    const idempotencyKey = retryIdempotencyKey(retryOfJobId, extraction.jobId, requestedScopes);
    const fingerprint = canonicalStringify(extraction);
    const existing = await this.#repository.findRetryResult(
      actor,
      projectId,
      chapterId,
      idempotencyKey,
    );
    if (existing) {
      const source = await this.#sourceReader.findSourceVersion(
        actor,
        projectId,
        chapterId,
        existing.version.sourceVersionId,
      );
      if (!source || source.id !== existing.version.sourceVersionId) {
        throw new StoryKnowledgeError("STAGE_RESULT_NOT_FOUND", "故事知识阶段结果不存在");
      }
      if (existing.fingerprint !== fingerprint) {
        throw new StoryKnowledgeError("INVALID_RETRY", "相同重试任务返回了不同内容");
      }
      return existing.version;
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
    if (current.id !== expectedActiveVersionId) {
      throw new StoryKnowledgeError("VERSION_CONFLICT", "故事知识已被其他操作更新，请刷新后重试");
    }
    if (extraction.sourceVersionId !== current.sourceVersionId) {
      throw new StoryKnowledgeError("INVALID_RETRY", "重试必须使用当前故事知识的原文版本");
    }

    const retryableScopes = new Set(
      current.failures.filter(({ retryable }) => retryable).map(({ scopeKey }) => scopeKey),
    );
    if (new Set(requestedScopes).size !== requestedScopes.length
      || requestedScopes.some((scopeKey) => !retryableScopes.has(scopeKey))) {
      throw new StoryKnowledgeError("INVALID_RETRY", "只能重试当前版本中标记为可重试的失败范围");
    }
    if (requestedScopes.some((scopeKey) => current.failures.find(
      (failure) => failure.scopeKey === scopeKey,
    )?.originJobId !== retryOfJobId)) {
      throw new StoryKnowledgeError("INVALID_RETRY", "重试任务未关联所选失败范围的来源任务");
    }

    const fragmentIds = new Set(source.fragmentIds);
    const facts = current.facts.map((fact) => structuredClone(fact));
    const failures = current.failures
      .filter(({ scopeKey }) => !requestedScopes.includes(scopeKey))
      .map((failure) => structuredClone(failure));
    const factIds = new Set(facts.map(({ id }) => id));
    for (const item of extraction.items) {
      if (item.status === "failed") {
        failures.push({ scopeKey: item.scopeKey, originJobId: extraction.jobId, ...item.error });
        continue;
      }
      if (factIds.has(item.value.id)) {
        throw new StoryKnowledgeError("INVALID_RETRY", "重试结果包含重复的故事事实");
      }
      if (item.value.evidence.length === 0) {
        failures.push({ scopeKey: item.scopeKey, originJobId: extraction.jobId, code: "EVIDENCE_REQUIRED", message: "每条故事知识必须关联至少一个原文片段", retryable: true });
        continue;
      }
      if (item.value.evidence.some(
        (evidence) => evidence.sourceVersionId !== source.id || !fragmentIds.has(evidence.fragmentId),
      )) {
        failures.push({ scopeKey: item.scopeKey, originJobId: extraction.jobId, code: "INVALID_EVIDENCE", message: "故事知识引用了无效的原文证据", retryable: true });
        continue;
      }
      factIds.add(item.value.id);
      facts.push(structuredClone(item.value));
    }

    return this.#repository.saveRetryCandidate(actor, {
      ...current,
      id: this.#idGenerator(),
      parentVersionId: current.id,
      extractionJobId: extraction.jobId,
      createdAt: this.#clock().toISOString(),
      createdBy: actor.userId,
      extractionStatus: finalExtractionStatus(facts.length, failures.length),
      status: facts.some(({ resolutionStatus }) => resolutionStatus !== "resolved") ? "needs_resolution" : "candidate",
      facts,
      failures,
    }, current.id, idempotencyKey, fingerprint);
  }

  async confirmStage(
    actor: Actor,
    projectId: string,
    chapterId: string,
    input: unknown,
  ): Promise<{ version: StoryKnowledgeVersion; storyBible: StoryBible }> {
    const command = parseConfirmation(input);
    const access = await this.#projectAccessReader?.findProjectAccess(actor, projectId);
    if (!access || (access.role !== "owner" && access.role !== "reviewer")) {
      throw new StoryKnowledgeError("FORBIDDEN", "只有负责人或审核人可以确认故事知识");
    }
    const confirmationFingerprint = canonicalStringify(command);
    const existing = await this.#repository.findConfirmationResult(
      actor,
      projectId,
      chapterId,
      command.expectedActiveVersionId,
    );
    if (existing) {
      const source = await this.#sourceReader.findSourceVersion(
        actor,
        projectId,
        chapterId,
        existing.version.sourceVersionId,
      );
      if (!source || source.id !== existing.version.sourceVersionId) {
        throw new StoryKnowledgeError("STAGE_RESULT_NOT_FOUND", "故事知识阶段结果不存在");
      }
      if (existing.fingerprint !== confirmationFingerprint) {
        throw new StoryKnowledgeError("INVALID_CONFIRMATION", "同一候选版本收到了不同的确认命令");
      }
      return { version: existing.version, storyBible: existing.storyBible };
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
    if (current.id !== command.expectedActiveVersionId) {
      throw new StoryKnowledgeError("VERSION_CONFLICT", "故事知识已被其他操作更新，请刷新后重试");
    }
    if (current.status !== "candidate"
      || current.failures.length > 0
      || current.facts.some(({ resolutionStatus }) => resolutionStatus !== "resolved")) {
      throw new StoryKnowledgeError("INVALID_CONFIRMATION", "故事知识仍有未解决问题或失败范围");
    }
    const fragmentIds = new Set(source.fragmentIds);
    if (current.facts.some((fact) => fact.evidence.length === 0 || fact.evidence.some(
      (evidence) => evidence.sourceVersionId !== source.id || !fragmentIds.has(evidence.fragmentId),
    ))) {
      throw new StoryKnowledgeError("INVALID_CONFIRMATION", "故事知识包含无效原文出处");
    }
    const confirmedAt = this.#clock().toISOString();
    const facts = current.facts.map((fact): StoryFact => ({
      ...structuredClone(fact),
      locked: false,
      lockHistory: [],
      ...(fact.decision ? {} : {
        decision: {
          outcome: "accepted" as const,
          decidedBy: actor.userId,
          decidedAt: confirmedAt,
          reason: command.reason,
        },
      }),
    }));
    const acceptedFacts = facts.filter(({ decision }) => decision?.outcome === "accepted");
    if (acceptedFacts.length === 0) {
      throw new StoryKnowledgeError("INVALID_CONFIRMATION", "故事圣经至少需要一条已接受事实");
    }
    const versionId = this.#idGenerator();
    const versionDraft: StoryKnowledgeVersion = {
      ...current,
      id: versionId,
      parentVersionId: current.id,
      createdAt: confirmedAt,
      createdBy: actor.userId,
      status: "confirmed",
      confirmedBy: actor.userId,
      confirmedAt,
      facts,
    };
    const storyBible: StoryBible = {
      id: `bible:${versionId}`,
      versionId,
      projectId,
      chapterId,
      confirmedBy: actor.userId,
      confirmedAt,
      facts: acceptedFacts.map((fact) => structuredClone(fact)),
    };
    const saved = await this.#repository.saveConfirmed(
      actor,
      versionDraft,
      storyBible,
      current.id,
      { candidateVersionId: current.id, fingerprint: confirmationFingerprint },
    );
    return saved;
  }

  async getConfirmedStoryBible(
    actor: Actor,
    projectId: string,
    chapterId: string,
  ): Promise<StoryBible> {
    const storyBible = await this.#repository.findConfirmedStoryBible(actor, projectId, chapterId);
    if (!storyBible) throw new StoryKnowledgeError("STAGE_RESULT_NOT_FOUND", "已确认故事圣经不存在");
    const sourceVersionId = storyBible.facts[0]?.evidence[0]?.sourceVersionId;
    if (!sourceVersionId) throw new StoryKnowledgeError("STAGE_RESULT_NOT_FOUND", "已确认故事圣经不存在");
    const source = await this.#sourceReader.findSourceVersion(actor, projectId, chapterId, sourceVersionId);
    if (!source || source.id !== sourceVersionId) {
      throw new StoryKnowledgeError("STAGE_RESULT_NOT_FOUND", "已确认故事圣经不存在");
    }
    return storyBible;
  }

  async setFactLock(
    actor: Actor,
    projectId: string,
    chapterId: string,
    input: unknown,
  ): Promise<StoryKnowledgeVersion> {
    const command = parseFactLock(input);
    const access = await this.#projectAccessReader?.findProjectAccess(actor, projectId);
    if (!access || (access.role !== "owner" && access.role !== "reviewer")) {
      throw new StoryKnowledgeError("FORBIDDEN", "只有负责人或审核人可以锁定故事事实");
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
    if (current.id !== command.expectedActiveVersionId) {
      throw new StoryKnowledgeError("VERSION_CONFLICT", "故事知识已被其他操作更新，请刷新后重试");
    }
    if (current.status !== "confirmed") {
      throw new StoryKnowledgeError("INVALID_LOCK", "只能锁定已确认版本中的故事事实");
    }
    const target = current.facts.find((fact) => fact.id === command.factId);
    if (!target || target.decision?.outcome !== "accepted") {
      throw new StoryKnowledgeError("FACT_NOT_FOUND", "已确认故事事实不存在");
    }
    const locked = target.locked ?? false;
    if ((command.action === "lock" && locked) || (command.action === "unlock" && !locked)) {
      throw new StoryKnowledgeError("INVALID_LOCK", "故事事实已经处于目标锁定状态");
    }
    const at = this.#clock().toISOString();
    const facts = current.facts.map((fact): StoryFact => {
      if (fact.id !== command.factId) return structuredClone(fact);
      const history = [
        ...(fact.lockHistory ?? []).map((entry) => structuredClone(entry)),
        { action: command.action, actorId: actor.userId, at, reason: command.reason },
      ];
      const cloned = structuredClone(fact);
      if (command.action === "lock") return {
        ...cloned,
        locked: true,
        lockedBy: actor.userId,
        lockedAt: at,
        lockHistory: history,
      };
      const { lockedBy: _lockedBy, lockedAt: _lockedAt, ...withoutCurrentLock } = cloned;
      return { ...withoutCurrentLock, locked: false, lockHistory: history };
    });
    const versionId = this.#idGenerator();
    const version: StoryKnowledgeVersion = {
      ...current,
      id: versionId,
      parentVersionId: current.id,
      createdAt: at,
      createdBy: actor.userId,
      facts,
    };
    const storyBible: StoryBible = {
      id: `bible:${versionId}`,
      versionId,
      projectId,
      chapterId,
      confirmedBy: version.confirmedBy ?? actor.userId,
      confirmedAt: version.confirmedAt ?? at,
      facts: facts.filter(({ decision }) => decision?.outcome === "accepted").map((fact) => structuredClone(fact)),
    };
    return (await this.#repository.saveConfirmed(actor, version, storyBible, current.id)).version;
  }
}

const FACT_TYPES = ["character", "relationship", "event", "location", "prop", "worldRule"] as const;
const ASSERTION_KINDS = ["explicit", "inferred", "user_confirmed"] as const;
const RESOLUTION_STATUSES = ["resolved", "pending_identity", "conflicting"] as const;
const EXTRACTION_STATUSES = ["succeeded", "partially_succeeded", "failed"] as const;
const CONFLICT_CLASSIFICATIONS = ["setting_change", "character_misunderstanding", "author_contradiction", "other"] as const;

export function parseStoryKnowledgeExtraction(input: unknown): StoryKnowledgeExtraction {
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
  expectedActiveVersionId: string;
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
  const allowed = new Set(["expectedActiveVersionId", "factId", "alternativeFactIds", "statement", "reason", "conflictClassification"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalidDecision();
  if (value.alternativeFactIds !== undefined && !Array.isArray(value.alternativeFactIds)) invalidDecision();
  try {
    return {
      expectedActiveVersionId: nonBlank(value.expectedActiveVersionId),
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

function parseFactEdit(input: unknown): {
  expectedActiveVersionId: string;
  factId: string;
  statement: string;
  reason: string;
} {
  try {
    const value = recordWithKeys(input, ["expectedActiveVersionId", "factId", "statement", "reason"]);
    return {
      expectedActiveVersionId: nonBlank(value.expectedActiveVersionId),
      factId: nonBlank(value.factId),
      statement: nonBlank(value.statement),
      reason: nonBlank(value.reason),
    };
  } catch {
    throw new StoryKnowledgeError("INVALID_EDIT", "故事事实编辑不符合运行时契约");
  }
}

function parseFactReview(input: unknown): {
  expectedActiveVersionId: string;
  factId: string;
  outcome: "accepted" | "rejected";
  reason: string;
} {
  try {
    const value = recordWithKeys(input, ["expectedActiveVersionId", "factId", "outcome", "reason"]);
    return {
      expectedActiveVersionId: nonBlank(value.expectedActiveVersionId),
      factId: nonBlank(value.factId),
      outcome: enumValue(value.outcome, ["accepted", "rejected"] as const),
      reason: nonBlank(value.reason),
    };
  } catch {
    throw new StoryKnowledgeError("INVALID_REVIEW", "故事事实审核不符合运行时契约");
  }
}

function parseRetryCommand(input: unknown): {
  expectedActiveVersionId: string;
  retryOfJobId: string;
  extraction: StoryKnowledgeExtraction;
} {
  try {
    const value = recordWithKeys(input, ["expectedActiveVersionId", "retryOfJobId", "extraction"]);
    return {
      expectedActiveVersionId: nonBlank(value.expectedActiveVersionId),
      retryOfJobId: nonBlank(value.retryOfJobId),
      extraction: parseStoryKnowledgeExtraction(value.extraction),
    };
  } catch {
    throw new StoryKnowledgeError("INVALID_RETRY", "局部重试命令不符合运行时契约");
  }
}

function parseConfirmation(input: unknown): { expectedActiveVersionId: string; reason: string } {
  try {
    const value = recordWithKeys(input, ["expectedActiveVersionId", "reason"]);
    return {
      expectedActiveVersionId: nonBlank(value.expectedActiveVersionId),
      reason: nonBlank(value.reason),
    };
  } catch {
    throw new StoryKnowledgeError("INVALID_CONFIRMATION", "故事知识确认命令不符合运行时契约");
  }
}

function parseFactLock(input: unknown): {
  expectedActiveVersionId: string;
  factId: string;
  action: "lock" | "unlock";
  reason: string;
} {
  try {
    const value = recordWithKeys(input, ["expectedActiveVersionId", "factId", "action", "reason"]);
    return {
      expectedActiveVersionId: nonBlank(value.expectedActiveVersionId),
      factId: nonBlank(value.factId),
      action: enumValue(value.action, ["lock", "unlock"] as const),
      reason: nonBlank(value.reason),
    };
  } catch {
    throw new StoryKnowledgeError("INVALID_LOCK", "故事事实锁定命令不符合运行时契约");
  }
}

function retryIdempotencyKey(retryOfJobId: string, jobId: string, scopeKeys: string[]): string {
  return `${retryOfJobId}:${jobId}:${[...scopeKeys].sort().join(",")}`;
}

function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
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
