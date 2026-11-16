import { StoryboardStorageError } from "@novel-adaptation/script/postgres-storyboard-candidates";
import type { Actor } from "@novel-adaptation/script";
import { ScriptContentError } from "@novel-adaptation/script/script-content";
import { StoryboardContentError } from "@novel-adaptation/script/storyboard-content";
import { StoryboardUpstreamError, type ConfirmedStoryboardHandoff } from "@novel-adaptation/script/storyboard-handoff";
import { StoryboardRunner, type StoryboardCandidateRepository, type StoryboardRequest } from "@novel-adaptation/script/storyboard-runner";
import { ModelTaskError, TaskExecutionError, type ModelTask, type ModelTaskContextReader, type ModelTaskService, type StoryRetrySelection } from "@novel-adaptation/script/model-tasks";

type Handoff = Pick<ConfirmedStoryboardHandoff, "read">;
type Credentials = { apiKey: string; providerId: string; modelId: string; processingRegion: "mainland" };

export function storyboardTaskContext(script: ModelTaskContextReader, handoff: Handoff, repository?: Pick<StoryboardCandidateRepository, "findGeneration">): ModelTaskContextReader {
  const context: ModelTaskContextReader = {
    async canRead(actor, projectId, chapterId) {
      return await script.canRead?.(actor, projectId, chapterId) === true;
    },
    async read(actor, projectId, chapterId) {
      const base = await script.read(actor, projectId, chapterId);
      if (!base) return null;
      if (base.stage !== "script" || base.resultType !== "scriptContent") throw new ModelTaskError("INVALID_CONTEXT");
      try {
        const formal = await handoff.read(actor, projectId, chapterId);
        const ids = formal.script.upstreamConfirmedVersionIds;
        if (base.sourceVersionId !== formal.sourceVersionId || ids.length !== base.upstreamConfirmedVersionIds.length
          || ids.some((id, i) => id !== base.upstreamConfirmedVersionIds[i])) throw new ModelTaskError("UPSTREAM_CHANGED");
        return {
          stage: "storyboard", resultType: "storyboardContent", sourceVersionId: formal.sourceVersionId,
          upstreamConfirmedVersionIds: formal.upstreamConfirmedVersionIds, generationParameters: base.generationParameters,
        };
      } catch (error) {
        if (isStale(error)) throw new ModelTaskError("UPSTREAM_CHANGED");
        throw error;
      }
    },
    async readRetry(actor, projectId, chapterId, selection: StoryRetrySelection) {
      const current = await context.read(actor, projectId, chapterId);
      if (!current || !repository) return null;
      const base = await repository.findGeneration(actor, {
        projectId, chapterId, jobId: selection.expectedActiveVersionId, sourceVersionId: current.sourceVersionId,
        upstreamConfirmedVersionIds: current.upstreamConfirmedVersionIds,
      });
      if (!base || !selection.scopeKeys.every(key => base.failures.some(failure => failure.scopeKey === key && failure.retryable))) throw new ModelTaskError("UPSTREAM_CHANGED");
      return { ...current, retry: { expectedActiveVersionId: base.jobId, retryOfJobId: base.jobId, scopeKeys: [...selection.scopeKeys].sort() } };
    },
  };
  return context;
}

function isStale(error: unknown) {
  return error instanceof StoryboardUpstreamError
    || error instanceof ScriptContentError && ["CONTEXT_NOT_FOUND", "INVALID_STATE"].includes(error.code);
}

function taskIdentity(actor: Actor, task: ModelTask) {
  if (task.workspaceId !== actor.workspaceId || task.createdBy !== actor.userId
    || task.input.stage !== "storyboard" || task.input.resultType !== "storyboardContent") throw new ModelTaskError("TASK_NOT_FOUND");
  return {
    jobId: task.id, projectId: task.projectId, chapterId: task.chapterId, sourceVersionId: task.input.sourceVersionId,
    upstreamConfirmedVersionIds: task.input.upstreamConfirmedVersionIds,
  };
}

export class StoryboardTaskExecutor {
  private readonly options: {
    tasks: ModelTaskService;
    handoff: Handoff;
    context: ModelTaskContextReader;
    repository: StoryboardCandidateRepository;
    model: { generate(request: StoryboardRequest, credentials: Credentials): Promise<unknown> };
  };

  constructor(options: StoryboardTaskExecutor["options"]) { this.options = options; }

  recover(actor: Actor, id: string) {
    const { tasks, repository } = this.options;
    return tasks.recover(actor, id, async task => {
      const identity = taskIdentity(actor, task);
      const candidate = await repository.findGeneration(actor, identity);
      if (!candidate || candidate.createdBy !== actor.userId || candidate.jobId !== identity.jobId
        || candidate.projectId !== identity.projectId || candidate.chapterId !== identity.chapterId
        || candidate.sourceVersionId !== identity.sourceVersionId
        || candidate.upstreamConfirmedVersionIds.length !== identity.upstreamConfirmedVersionIds.length
        || identity.upstreamConfirmedVersionIds.some((value, i) => candidate.upstreamConfirmedVersionIds[i] !== value)) return null;
      return { candidateVersionId: identity.jobId, extractionStatus: candidate.generationStatus };
    });
  }

  async run(actor: Actor, id: string, signal?: AbortSignal) {
    const { tasks, handoff, repository, model, context } = this.options;
    const task = await tasks.get(actor, id);
    const identity = taskIdentity(actor, task);
    return tasks.run(actor, id, async credentials => {
      let invoked = false;
      const guard = async () => {
        await tasks.assertGenerationAllowed(actor, task.projectId, task.chapterId, task.input);
        const current = await context.read(actor, task.projectId, task.chapterId);
        const expected = task.input.generationParameters;
        if (!current || current.stage !== task.input.stage || current.resultType !== task.input.resultType
          || current.sourceVersionId !== identity.sourceVersionId || current.upstreamConfirmedVersionIds.length !== identity.upstreamConfirmedVersionIds.length
          || identity.upstreamConfirmedVersionIds.some((value, i) => current.upstreamConfirmedVersionIds[i] !== value)
          || current.generationParameters.targetDurationSeconds !== expected.targetDurationSeconds
          || current.generationParameters.aspectRatio !== expected.aspectRatio
          || current.generationParameters.narrativeMode !== expected.narrativeMode) throw new StoryboardUpstreamError();
      };
      const runner = new StoryboardRunner({
        handoff, repository, model: { async generate(request) {
          await guard();
          invoked = true;
          const response = await model.generate(request, credentials);
          await guard();
          return response;
        } },
      });
      try {
        const candidate = await runner.run(actor, identity, task.input.retry);
        return { candidateVersionId: identity.jobId, extractionStatus: candidate.generationStatus };
      } catch (error) {
        if ((error instanceof ModelTaskError || error instanceof StoryboardStorageError) && error.code === "POLICY_RESTRICTED") throw new TaskExecutionError("POLICY_RESTRICTED");
        if (isStale(error) || error instanceof ModelTaskError && error.code === "UPSTREAM_CHANGED") throw new TaskExecutionError("UPSTREAM_CHANGED");
        if (error instanceof StoryboardContentError || error instanceof StoryboardStorageError && error.code === "INVALID_CANDIDATE") throw new TaskExecutionError("INVALID_RESPONSE");
        if (invoked) throw new TaskExecutionError("EXECUTION_UNCERTAIN");
        throw error;
      }
    }, signal);
  }
}
