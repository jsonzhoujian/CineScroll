export type Actor = Readonly<{ userId: string; workspaceId: string }>;
export type TargetDurationSeconds = 60 | 180 | 300;
export type AspectRatio = "9:16" | "16:9";
export type NarrativeMode = "narration" | "dialogue";
export type MajorAdaptationKind = "merge_characters" | "delete_core_event" | "reorder_events";

export type EpisodePlanItem = Readonly<{
  id: string;
  ordinal: number;
  title: string;
  sourceFragmentIds: string[];
  coreEventFactIds: string[];
}>;

export type MajorAdaptationProposal = Readonly<{
  id: string;
  kind: MajorAdaptationKind;
  summary: string;
  rationale: string;
  affectedFactIds: string[];
  decision?: Readonly<{
    outcome: "approved" | "rejected";
    reason: string;
    decidedBy: string;
    decidedAt: string;
  }>;
}>;

export type EpisodePlanVersion = Readonly<{
  id: string;
  parentVersionId: string | null;
  projectId: string;
  chapterId: string;
  sourceVersionId: string;
  storyBibleVersionId: string;
  targetDurationSeconds: TargetDurationSeconds;
  aspectRatio: AspectRatio;
  narrativeMode: NarrativeMode;
  recommendationRationale?: string;
  generationJobId?: string;
  episodes: EpisodePlanItem[];
  majorAdaptationProposals: MajorAdaptationProposal[];
  status: "candidate" | "confirmed";
  createdBy: string;
  createdAt: string;
  confirmedBy?: string;
  confirmedAt?: string;
}>;

export type RecordEpisodePlanInput = Readonly<{
  expectedActiveVersionId: string | null;
  projectId: string;
  chapterId: string;
  sourceVersionId: string;
  storyBibleVersionId: string;
  targetDurationSeconds: TargetDurationSeconds;
  aspectRatio: AspectRatio;
  narrativeMode: NarrativeMode;
  recommendationRationale?: string;
  generationJobId?: string;
  episodes: EpisodePlanItem[];
  majorAdaptationProposals: Array<Omit<MajorAdaptationProposal, "decision">>;
}>;

export interface ScriptRepository {
  saveEpisodePlan(
    actor: Actor,
    version: EpisodePlanVersion,
    expectedActiveVersionId?: string | null,
    operation?: Readonly<{ key: string; fingerprint: string }>,
  ): Promise<EpisodePlanVersion>;
  findActiveEpisodePlan(actor: Actor, projectId: string, chapterId: string): Promise<EpisodePlanVersion | null>;
  findConfirmedEpisodePlan(actor: Actor, projectId: string, chapterId: string): Promise<EpisodePlanVersion | null>;
  findOperationResult(
    actor: Actor,
    projectId: string,
    chapterId: string,
    operationKey: string,
  ): Promise<{ fingerprint: string; version: EpisodePlanVersion } | null>;
}

export interface ScriptUpstreamReader {
  findConfirmedStoryBible(
    actor: Actor,
    projectId: string,
    chapterId: string,
  ): Promise<{
    versionId: string;
    sourceVersionId: string;
    factIds: string[];
    fragmentIds: string[];
  } | null>;
}

export interface ProjectAccessReader {
  findProjectAccess(
    actor: Actor,
    projectId: string,
  ): Promise<{ role: "owner" | "editor" | "reviewer" } | null>;
}

export class ScriptError extends Error {
  readonly code:
    | "CONFIRMED_STORY_BIBLE_NOT_FOUND"
    | "INVALID_EPISODE_PLAN"
    | "EPISODE_PLAN_NOT_FOUND"
    | "PROPOSAL_NOT_FOUND"
    | "PROPOSAL_ALREADY_DECIDED"
    | "UNRESOLVED_MAJOR_ADAPTATION"
    | "CONFIRMED_PLAN_REQUIRES_SUGGESTION"
    | "FORBIDDEN"
    | "VERSION_CONFLICT";

  constructor(code: ScriptError["code"], message: string) {
    super(message);
    this.name = "ScriptError";
    this.code = code;
  }
}

export class InMemoryScriptRepository implements ScriptRepository {
  readonly #activeVersionIds = new Map<string, string>();
  readonly #versions = new Map<string, EpisodePlanVersion>();
  readonly #confirmedVersionIds = new Map<string, string>();
  readonly #operationResults = new Map<string, { fingerprint: string; versionId: string }>();

  async saveEpisodePlan(
    actor: Actor,
    version: EpisodePlanVersion,
    expectedActiveVersionId?: string | null,
    operation?: Readonly<{ key: string; fingerprint: string }>,
  ): Promise<EpisodePlanVersion> {
    const planKey = key(actor, version.projectId, version.chapterId);
    if (operation) {
      const operationResult = this.#operationResults.get(versionKey(planKey, operation.key));
      if (operationResult) {
        if (operationResult.fingerprint !== operation.fingerprint) {
          throw new ScriptError("INVALID_EPISODE_PLAN", "相同操作返回了不同内容");
        }
        const replayed = this.#versions.get(versionKey(planKey, operationResult.versionId));
        if (replayed) return structuredClone(replayed);
      }
    }
    const activeVersionId = this.#activeVersionIds.get(planKey) ?? null;
    if (expectedActiveVersionId !== undefined && activeVersionId !== expectedActiveVersionId) {
      throw new ScriptError("VERSION_CONFLICT", "拆集方案已被其他操作更新，请刷新后重试");
    }
    const saved = structuredClone(version);
    this.#versions.set(versionKey(planKey, version.id), saved);
    this.#activeVersionIds.set(planKey, version.id);
    if (version.status === "confirmed") this.#confirmedVersionIds.set(planKey, version.id);
    if (operation) {
      this.#operationResults.set(versionKey(planKey, operation.key), {
        fingerprint: operation.fingerprint,
        versionId: version.id,
      });
    }
    return structuredClone(saved);
  }

  async findActiveEpisodePlan(
    actor: Actor,
    projectId: string,
    chapterId: string,
  ): Promise<EpisodePlanVersion | null> {
    const planKey = key(actor, projectId, chapterId);
    const activeVersionId = this.#activeVersionIds.get(planKey);
    const version = activeVersionId ? this.#versions.get(versionKey(planKey, activeVersionId)) : undefined;
    return version ? structuredClone(version) : null;
  }

  async findConfirmedEpisodePlan(
    actor: Actor,
    projectId: string,
    chapterId: string,
  ): Promise<EpisodePlanVersion | null> {
    const planKey = key(actor, projectId, chapterId);
    const confirmedVersionId = this.#confirmedVersionIds.get(planKey);
    const version = confirmedVersionId ? this.#versions.get(versionKey(planKey, confirmedVersionId)) : undefined;
    return version ? structuredClone(version) : null;
  }

  async findOperationResult(
    actor: Actor,
    projectId: string,
    chapterId: string,
    operationKey: string,
  ): Promise<{ fingerprint: string; version: EpisodePlanVersion } | null> {
    const planKey = key(actor, projectId, chapterId);
    const result = this.#operationResults.get(versionKey(planKey, operationKey));
    if (!result) return null;
    const version = this.#versions.get(versionKey(planKey, result.versionId));
    return version ? { fingerprint: result.fingerprint, version: structuredClone(version) } : null;
  }
}

export class ScriptService {
  readonly #repository: ScriptRepository;
  readonly #upstreamReader: ScriptUpstreamReader;
  readonly #accessReader: ProjectAccessReader;
  readonly #idGenerator: () => string;
  readonly #clock: () => Date;

  constructor(dependencies: {
    repository: ScriptRepository;
    upstreamReader: ScriptUpstreamReader;
    accessReader: ProjectAccessReader;
    idGenerator: () => string;
    clock: () => Date;
  }) {
    this.#repository = dependencies.repository;
    this.#upstreamReader = dependencies.upstreamReader;
    this.#accessReader = dependencies.accessReader;
    this.#idGenerator = dependencies.idGenerator;
    this.#clock = dependencies.clock;
  }

  async recordEpisodePlan(
    actor: Actor,
    input: RecordEpisodePlanInput,
  ): Promise<EpisodePlanVersion> {
    const access = await this.#accessReader.findProjectAccess(actor, input.projectId);
    if (!access) throw new ScriptError("FORBIDDEN", "只有项目成员可以创建或调整拆集方案");
    const storyBible = await this.#upstreamReader.findConfirmedStoryBible(actor, input.projectId, input.chapterId);
    if (!storyBible) {
      throw new ScriptError("CONFIRMED_STORY_BIBLE_NOT_FOUND", "生成拆集方案前必须先确认故事知识");
    }
    const generationOperation = input.generationJobId ? {
      key: `generation:${input.generationJobId}`,
      fingerprint: JSON.stringify({ ...input, expectedActiveVersionId: undefined }),
    } : undefined;
    if (generationOperation) {
      const replayed = await this.#repository.findOperationResult(
        actor,
        input.projectId,
        input.chapterId,
        generationOperation.key,
      );
      if (replayed) {
        if (replayed.fingerprint !== generationOperation.fingerprint) {
          throw new ScriptError("INVALID_EPISODE_PLAN", "相同拆集任务返回了不同内容");
        }
        return replayed.version;
      }
    }
    const active = await this.#repository.findActiveEpisodePlan(actor, input.projectId, input.chapterId);
    if ((active?.id ?? null) !== input.expectedActiveVersionId) {
      throw new ScriptError("VERSION_CONFLICT", "拆集方案已被其他操作更新，请刷新后重试");
    }
    if (active?.status === "confirmed") {
      throw new ScriptError("CONFIRMED_PLAN_REQUIRES_SUGGESTION", "已确认拆集方案只能通过修改建议创建后续版本");
    }
    validateEpisodePlan(input, storyBible);
    const { expectedActiveVersionId: _expectedActiveVersionId, ...content } = input;
    return this.#repository.saveEpisodePlan(actor, {
      ...structuredClone(content),
      id: this.#idGenerator(),
      parentVersionId: active?.id ?? null,
      status: "candidate",
      createdBy: actor.userId,
      createdAt: this.#clock().toISOString(),
    }, input.expectedActiveVersionId, generationOperation);
  }

  async decideMajorAdaptation(
    actor: Actor,
    projectId: string,
    chapterId: string,
    input: {
      expectedActiveVersionId: string;
      proposalId: string;
      decision: "approved" | "rejected";
      reason: string;
    },
  ): Promise<EpisodePlanVersion> {
    await this.#requireReviewer(actor, projectId);
    const operation = {
      key: `decision:${input.expectedActiveVersionId}:${input.proposalId}`,
      fingerprint: JSON.stringify({ decision: input.decision, reason: input.reason.trim() }),
    };
    const replayed = await this.#repository.findOperationResult(actor, projectId, chapterId, operation.key);
    if (replayed) {
      if (replayed.fingerprint !== operation.fingerprint) {
        throw new ScriptError("INVALID_EPISODE_PLAN", "相同裁决操作的内容不一致");
      }
      return replayed.version;
    }
    const active = await this.#activeCandidate(actor, projectId, chapterId, input.expectedActiveVersionId);
    const proposal = active.majorAdaptationProposals.find(({ id }) => id === input.proposalId);
    if (!proposal) throw new ScriptError("PROPOSAL_NOT_FOUND", "重大改编建议不存在");
    if (proposal.decision) throw new ScriptError("PROPOSAL_ALREADY_DECIDED", "重大改编建议已经裁决");
    if (input.reason.trim().length === 0) throw new ScriptError("INVALID_EPISODE_PLAN", "裁决理由不能为空");
    const decidedAt = this.#clock().toISOString();
    return this.#repository.saveEpisodePlan(actor, {
      ...structuredClone(active),
      id: this.#idGenerator(),
      parentVersionId: active.id,
      createdBy: actor.userId,
      createdAt: decidedAt,
      majorAdaptationProposals: active.majorAdaptationProposals.map((item) => item.id === proposal.id
        ? { ...item, decision: { outcome: input.decision, reason: input.reason.trim(), decidedBy: actor.userId, decidedAt } }
        : item),
    }, active.id, operation);
  }

  async confirmEpisodePlan(
    actor: Actor,
    projectId: string,
    chapterId: string,
    input: { expectedActiveVersionId: string },
  ): Promise<EpisodePlanVersion> {
    await this.#requireReviewer(actor, projectId);
    const operation = { key: `confirmation:${input.expectedActiveVersionId}`, fingerprint: "confirm" };
    const replayed = await this.#repository.findOperationResult(actor, projectId, chapterId, operation.key);
    if (replayed) return replayed.version;
    const active = await this.#activeCandidate(actor, projectId, chapterId, input.expectedActiveVersionId);
    if (active.majorAdaptationProposals.some(({ decision }) => !decision)) {
      throw new ScriptError("UNRESOLVED_MAJOR_ADAPTATION", "所有重大改编建议都必须逐项批准或拒绝");
    }
    const confirmedAt = this.#clock().toISOString();
    return this.#repository.saveEpisodePlan(actor, {
      ...structuredClone(active),
      id: this.#idGenerator(),
      parentVersionId: active.id,
      status: "confirmed",
      createdBy: actor.userId,
      createdAt: confirmedAt,
      confirmedBy: actor.userId,
      confirmedAt,
    }, active.id, operation);
  }

  async #activeCandidate(
    actor: Actor,
    projectId: string,
    chapterId: string,
    expectedActiveVersionId: string,
  ): Promise<EpisodePlanVersion> {
    const active = await this.#repository.findActiveEpisodePlan(actor, projectId, chapterId);
    if (!active) throw new ScriptError("EPISODE_PLAN_NOT_FOUND", "拆集方案不存在");
    if (active.id !== expectedActiveVersionId) {
      throw new ScriptError("VERSION_CONFLICT", "拆集方案已被其他操作更新，请刷新后重试");
    }
    if (active.status !== "candidate") {
      throw new ScriptError("INVALID_EPISODE_PLAN", "已确认的拆集方案不能再次修改或确认");
    }
    return active;
  }

  async #requireReviewer(actor: Actor, projectId: string): Promise<void> {
    const access = await this.#accessReader.findProjectAccess(actor, projectId);
    if (!access || access.role === "editor") {
      throw new ScriptError("FORBIDDEN", "只有负责人或审核人可以裁决重大改编并确认拆集方案");
    }
  }
}

function validateEpisodePlan(
  input: RecordEpisodePlanInput,
  storyBible: Awaited<ReturnType<ScriptUpstreamReader["findConfirmedStoryBible"]>> & {},
): void {
  if (input.storyBibleVersionId !== storyBible.versionId || input.sourceVersionId !== storyBible.sourceVersionId) {
    throw new ScriptError("INVALID_EPISODE_PLAN", "拆集方案的上游版本与已确认故事知识不一致");
  }
  if (![60, 180, 300].includes(input.targetDurationSeconds)) {
    throw new ScriptError("INVALID_EPISODE_PLAN", "目标单集时长仅支持 1、3、5 分钟");
  }
  if (input.recommendationRationale !== undefined && input.recommendationRationale.trim().length === 0) {
    throw new ScriptError("INVALID_EPISODE_PLAN", "拆集建议理由不能为空");
  }
  if (input.episodes.length === 0) throw new ScriptError("INVALID_EPISODE_PLAN", "拆集方案至少包含一集");
  const fragmentIds = new Set(storyBible.fragmentIds);
  const factIds = new Set(storyBible.factIds);
  input.episodes.forEach((episode, index) => {
    if (episode.ordinal !== index + 1 || episode.title.trim().length === 0) {
      throw new ScriptError("INVALID_EPISODE_PLAN", "集序号必须连续且标题不能为空");
    }
    if (episode.sourceFragmentIds.length === 0 || episode.sourceFragmentIds.some((id) => !fragmentIds.has(id))) {
      throw new ScriptError("INVALID_EPISODE_PLAN", "每集必须关联当前原文版本中的片段");
    }
    if (episode.coreEventFactIds.length === 0 || episode.coreEventFactIds.some((id) => !factIds.has(id))) {
      throw new ScriptError("INVALID_EPISODE_PLAN", "每集必须关联已确认的核心事件");
    }
  });
  if (new Set(input.episodes.map(({ id }) => id)).size !== input.episodes.length) {
    throw new ScriptError("INVALID_EPISODE_PLAN", "每集必须使用唯一标识");
  }
  const proposalIds = new Set<string>();
  for (const proposal of input.majorAdaptationProposals) {
    if (proposalIds.has(proposal.id) || proposal.summary.trim().length === 0 || proposal.rationale.trim().length === 0) {
      throw new ScriptError("INVALID_EPISODE_PLAN", "重大改编建议必须唯一且说明完整");
    }
    if (proposal.affectedFactIds.length === 0 || proposal.affectedFactIds.some((id) => !factIds.has(id))) {
      throw new ScriptError("INVALID_EPISODE_PLAN", "重大改编建议必须关联已确认的故事事实");
    }
    proposalIds.add(proposal.id);
  }
}

function key(actor: Actor, projectId: string, chapterId: string): string {
  return `${actor.workspaceId}:${projectId}:${chapterId}`;
}

function versionKey(planKey: string, versionId: string): string {
  return `${planKey}:${versionId}`;
}
