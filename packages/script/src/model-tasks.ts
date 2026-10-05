import type { Actor, AspectRatio, NarrativeMode, TargetDurationSeconds } from "./index.ts";
import { ModelSettingsError, type TaskModelSnapshot, type WorkspaceModelSettings } from "./model-settings.ts";

export type TaskInput = { stage: "story_knowledge" | "script"; sourceVersionId: string; upstreamConfirmedVersionIds: string[];
  generationParameters: { targetDurationSeconds: TargetDurationSeconds; aspectRatio: AspectRatio; narrativeMode: NarrativeMode } };
export type TaskState = "queued" | "running" | "paused" | "failed" | "succeeded";
export type TaskReason = "VERSION_CONFLICT" | "FORBIDDEN" | "NOT_READY" | "UPSTREAM_CHANGED" | "PROVIDER_UNAVAILABLE" | "INVALID_RESPONSE" | "CANDIDATE_EXISTS" | "EXECUTION_UNCERTAIN";
export type TaskResult = { candidateVersionId: string; extractionStatus: "succeeded" | "partially_succeeded" | "failed" };
/** Controlled execution outcomes only; never include provider messages or raw responses. */
export class TaskExecutionError extends Error {
  readonly code: "UPSTREAM_CHANGED" | "INVALID_RESPONSE" | "CANDIDATE_EXISTS";
  constructor(code: TaskExecutionError["code"]) { super(code); this.code = code; }
}
export type ModelTask = { id: string; workspaceId: string; createdBy: string; projectId: string; chapterId: string;
  parentTaskId: string | null; input: TaskInput; model: TaskModelSnapshot; state: TaskState; revision: number; reason: TaskReason | null; result: TaskResult | null; leaseExpiresAt: string | null };
export class ModelTaskError extends Error {
  readonly code: "TASK_NOT_FOUND" | "STATE_CONFLICT" | "UPSTREAM_CHANGED" | "INVALID_CONTEXT" | "STORAGE_UNAVAILABLE";
  constructor(code: ModelTaskError["code"]) { super(code); this.code = code; }
}
export interface ModelTaskRepository {
  find(workspaceId: string, id: string): Promise<ModelTask | null>;
  insert(task: ModelTask): Promise<ModelTask>;
  transition(workspaceId: string, id: string, expectedRevision: number, state: TaskState, reason: TaskReason | null, result?: TaskResult | null): Promise<ModelTask>;
  recover(workspaceId: string, id: string, expectedRevision: number, result: TaskResult | null): Promise<ModelTask>;
}
export function validateTaskStatus(state: TaskState, reason: TaskReason | null): void {
  if (!(reason === null && ["queued", "running", "succeeded"].includes(state)
    || state === "paused" && reason !== null && ["VERSION_CONFLICT", "FORBIDDEN", "NOT_READY", "UPSTREAM_CHANGED", "EXECUTION_UNCERTAIN"].includes(reason)
    || state === "failed" && reason !== null && ["PROVIDER_UNAVAILABLE", "INVALID_RESPONSE", "CANDIDATE_EXISTS"].includes(reason))) throw new ModelTaskError("STATE_CONFLICT");
}
export function validateTaskResult(state: TaskState, result: TaskResult | null): void {
  if (result === null) return;
  if (state !== "succeeded" || typeof result.candidateVersionId !== "string" || !result.candidateVersionId.trim()
    || result.candidateVersionId.length > 256 || Object.keys(result).some(key => !["candidateVersionId", "extractionStatus"].includes(key))
    || !["succeeded", "partially_succeeded", "failed"].includes(result.extractionStatus)) throw new ModelTaskError("STATE_CONFLICT");
}
export interface ModelTaskContextReader {
  /** Must verify project membership, stage prerequisites and confirmed upstream versions. */
  read(actor: Actor, projectId: string, chapterId: string): Promise<TaskInput | null>;
}
type ModelTaskOptions = { settings: WorkspaceModelSettings; repository: ModelTaskRepository; contextReader: ModelTaskContextReader; idGenerator(): string };
export class ModelTaskService {
  readonly #options: ModelTaskOptions;
  constructor(options: ModelTaskOptions) { this.#options = options; }
  async #context(actor: Actor, projectId: string, chapterId: string) {
    const input = await this.#options.contextReader.read(actor, projectId, chapterId);
    if (!input) throw new ModelTaskError("TASK_NOT_FOUND");
    if (!["story_knowledge", "script"].includes(input.stage) || !input.sourceVersionId
      || (input.stage === "script" && !input.upstreamConfirmedVersionIds.length)
      || (input.stage === "story_knowledge" && input.upstreamConfirmedVersionIds.length !== 0) || input.upstreamConfirmedVersionIds.some(id => !id)
      || ![60, 180, 300].includes(input.generationParameters.targetDurationSeconds)
      || !["9:16", "16:9"].includes(input.generationParameters.aspectRatio)
      || !["narration", "dialogue"].includes(input.generationParameters.narrativeMode)) throw new ModelTaskError("INVALID_CONTEXT");
    return { stage: input.stage, sourceVersionId: input.sourceVersionId, upstreamConfirmedVersionIds: [...input.upstreamConfirmedVersionIds],
      generationParameters: { targetDurationSeconds: input.generationParameters.targetDurationSeconds,
        aspectRatio: input.generationParameters.aspectRatio, narrativeMode: input.generationParameters.narrativeMode } };
  }
  async get(actor: Actor, id: string) {
    const task = await this.#options.repository.find(actor.workspaceId, id);
    if (!task) throw new ModelTaskError("TASK_NOT_FOUND");
    await this.#context(actor, task.projectId, task.chapterId);
    return task;
  }
  async submit(actor: Actor, input: { projectId: string; chapterId: string; configurationVersionId: string; modelId: string }) {
    const context = await this.#context(actor, input.projectId, input.chapterId);
    const model = await this.#options.settings.selectForTask(actor, input.configurationVersionId, input.modelId);
    return this.#options.repository.insert({ id: this.#options.idGenerator(), workspaceId: actor.workspaceId, createdBy: actor.userId,
      projectId: input.projectId, chapterId: input.chapterId, parentTaskId: null, input: context, model, state: "queued", revision: 0, reason: null, result: null, leaseExpiresAt: null });
  }
  async resubmit(actor: Actor, id: string, selection: { configurationVersionId: string; modelId: string }) {
    const old = await this.get(actor, id);
    const current = await this.#context(actor, old.projectId, old.chapterId);
    if (!sameInput(old.input, current)) throw new ModelTaskError("UPSTREAM_CHANGED");
    if (old.state !== "paused" || old.reason === "EXECUTION_UNCERTAIN") throw new ModelTaskError("STATE_CONFLICT");
    const model = await this.#options.settings.selectForTask(actor, selection.configurationVersionId, selection.modelId);
    return this.#options.repository.insert({ ...old, id: this.#options.idGenerator(), createdBy: actor.userId,
      parentTaskId: old.id, model, state: "queued", revision: 0, reason: null, result: null, leaseExpiresAt: null });
  }
  /** Internal reconciliation only. Reader must return a persisted, task-matched result, never invoke a model. */
  async recover(actor: Actor, id: string, readResult: (task: ModelTask) => Promise<TaskResult | null>) {
    const task = await this.get(actor, id);
    if (!(task.state === "running" || task.state === "paused" && task.reason === "EXECUTION_UNCERTAIN")) throw new ModelTaskError("STATE_CONFLICT");
    const result = await readResult(structuredClone(task));
    validateTaskResult("succeeded", result);
    return this.#options.repository.recover(actor.workspaceId, id, task.revision, result);
  }
  async run(actor: Actor, id: string, invoke: (input: { jobId: string; input: TaskInput; apiKey: string; providerId: string; modelId: string; processingRegion: "mainland" }) => Promise<TaskResult | void>) {
    const task = await this.get(actor, id);
    if (task.state !== "queued") throw new ModelTaskError("STATE_CONFLICT");
    const running = await this.#options.repository.transition(actor.workspaceId, id, task.revision, "running", null);
    let state: TaskState = "succeeded", reason: TaskReason | null = null;
    let result: TaskResult | null = null;
    let executionError: TaskExecutionError | null = null;
    try {
      const context = await this.#context(actor, task.projectId, task.chapterId);
      if (!sameInput(task.input, context)) { state = "paused"; reason = "UPSTREAM_CHANGED"; }
      else result = await this.#options.settings.executeForTask(actor, task.model, async credentials => {
        try { return await invoke({ ...credentials, jobId: task.id, input: structuredClone(task.input) }) ?? null; }
        catch (error) { if (error instanceof TaskExecutionError) executionError = error; throw error; }
      });
      validateTaskResult(state, result);
    } catch (error) {
      result = null;
      if (executionError) {
        reason = (executionError as TaskExecutionError).code;
        state = reason === "UPSTREAM_CHANGED" ? "paused" : "failed";
      } else if (error instanceof ModelSettingsError && ["VERSION_CONFLICT", "FORBIDDEN", "NOT_READY"].includes(error.code)) {
        state = "paused"; reason = error.code as TaskReason;
      } else { state = "failed"; reason = "PROVIDER_UNAVAILABLE"; }
    }
    return this.#options.repository.transition(actor.workspaceId, id, running.revision, state, reason, result);
  }
}
function sameInput(a: TaskInput, b: TaskInput) {
  return a.stage === b.stage && a.sourceVersionId === b.sourceVersionId
    && a.upstreamConfirmedVersionIds.length === b.upstreamConfirmedVersionIds.length
    && a.upstreamConfirmedVersionIds.every((id, i) => id === b.upstreamConfirmedVersionIds[i])
    && a.generationParameters.targetDurationSeconds === b.generationParameters.targetDurationSeconds
    && a.generationParameters.aspectRatio === b.generationParameters.aspectRatio
    && a.generationParameters.narrativeMode === b.generationParameters.narrativeMode;
}
export class InMemoryModelTaskRepository implements ModelTaskRepository {
  readonly #tasks = new Map<string, ModelTask>();
  readonly #clock: () => number;
  constructor(clock: () => number = Date.now) { this.#clock = clock; }
  #key(workspaceId: string, id: string) { return JSON.stringify([workspaceId, id]); }
  async find(workspaceId: string, id: string) { return structuredClone(this.#tasks.get(this.#key(workspaceId, id)) ?? null); }
  async insert(task: ModelTask) {
    if (task.state !== "queued" || task.revision !== 0 || task.reason !== null || task.result !== null || task.leaseExpiresAt !== null) throw new ModelTaskError("STATE_CONFLICT");
    if (this.#tasks.has(this.#key(task.workspaceId, task.id)) || (task.parentTaskId && [...this.#tasks.values()].some(t => t.workspaceId === task.workspaceId && t.parentTaskId === task.parentTaskId))) throw new ModelTaskError("STATE_CONFLICT");
    this.#tasks.set(this.#key(task.workspaceId, task.id), structuredClone(task)); return structuredClone(task);
  }
  async transition(workspaceId: string, id: string, revision: number, state: TaskState, reason: TaskReason | null, result: TaskResult | null = null) {
    validateTaskStatus(state, reason);
    validateTaskResult(state, result);
    const old = this.#tasks.get(this.#key(workspaceId, id));
    if (!old || old.revision !== revision || !(old.state === "queued" && state === "running" || old.state === "running" && ["paused", "failed", "succeeded"].includes(state))) throw new ModelTaskError("STATE_CONFLICT");
    const updated = { ...old, state, reason, result: structuredClone(result), revision: revision + 1,
      leaseExpiresAt: state === "running" ? new Date(this.#clock() + 600_000).toISOString() : null };
    this.#tasks.set(this.#key(workspaceId, id), updated); return structuredClone(updated);
  }
  async recover(workspaceId: string, id: string, revision: number, result: TaskResult | null) {
    validateTaskResult("succeeded", result);
    const old = this.#tasks.get(this.#key(workspaceId, id));
    if (!old || old.revision !== revision || !(old.state === "running" && (old.leaseExpiresAt === null || Date.parse(old.leaseExpiresAt) <= this.#clock())
      || old.state === "paused" && old.reason === "EXECUTION_UNCERTAIN" && result !== null)) throw new ModelTaskError("STATE_CONFLICT");
    const updated: ModelTask = { ...old, state: result ? "succeeded" : "paused", reason: result ? null : "EXECUTION_UNCERTAIN",
      result: structuredClone(result), leaseExpiresAt: null, revision: revision + 1 };
    this.#tasks.set(this.#key(workspaceId, id), updated); return structuredClone(updated);
  }
}
