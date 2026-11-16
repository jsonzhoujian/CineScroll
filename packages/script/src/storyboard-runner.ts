import type { StoryRetrySnapshot } from "./model-tasks.ts";
import type { Actor } from "./index.ts";
import type { ConfirmedStoryboardHandoff } from "./storyboard-handoff.ts";
import { StoryboardUpstreamError } from "./storyboard-handoff.ts";
import { validateStoryboardResponse, type StoryboardResponseIdentity } from "./storyboard-content.ts";

type FormalInput = Awaited<ReturnType<ConfirmedStoryboardHandoff["read"]>>;
export type StoryboardRequest = StoryboardResponseIdentity & {
  contractVersion: "0.1.0";
  stage: "storyboard";
  input: FormalInput;
  retryOfJobId?: string;
  scopeKeys?: readonly string[];
};
export type StoryboardCandidate = StoryboardResponseIdentity & ReturnType<typeof validateStoryboardResponse> & {
  createdBy: string;
  retry?: StoryRetrySnapshot;
};

export interface StoryboardCandidateRepository {
  findGeneration(actor: Actor, identity: StoryboardResponseIdentity): Promise<StoryboardCandidate | null>;
  /** Atomically recheck formal pointers, save by job identity, and register shot dependencies. */
  saveGeneration(actor: Actor, candidate: StoryboardCandidate): Promise<StoryboardCandidate>;
}

function matchesUpstream(actual: Pick<StoryboardResponseIdentity, "sourceVersionId" | "upstreamConfirmedVersionIds">, expected: StoryboardResponseIdentity) {
  return actual.sourceVersionId === expected.sourceVersionId
    && actual.upstreamConfirmedVersionIds.length === expected.upstreamConfirmedVersionIds.length
    && expected.upstreamConfirmedVersionIds.every((id, index) => actual.upstreamConfirmedVersionIds[index] === id);
}

export class StoryboardRunner {
  private readonly options: {
    handoff: Pick<ConfirmedStoryboardHandoff, "read">;
    repository: StoryboardCandidateRepository;
    model: { generate(request: StoryboardRequest): Promise<unknown> };
  };

  constructor(options: StoryboardRunner["options"]) { this.options = options; }

  /** The caller supplies the persisted, authorized task snapshot. */
  async run(actor: Actor, task: StoryboardResponseIdentity, retry?: StoryRetrySnapshot): Promise<StoryboardCandidate> {
    const identity = structuredClone(task);
    const { handoff, repository, model } = this.options;
    const existing = await repository.findGeneration(actor, identity);
    if (existing) {
      if (existing.createdBy !== actor.userId || existing.jobId !== identity.jobId
        || existing.projectId !== identity.projectId || existing.chapterId !== identity.chapterId
        || !matchesUpstream(existing, identity)) throw new StoryboardUpstreamError();
      return existing;
    }

    const readCurrent = async () => {
      const upstream = await handoff.read(actor, identity.projectId, identity.chapterId);
      if (!matchesUpstream(upstream, identity)) throw new StoryboardUpstreamError();
      return upstream;
    };
    const upstream = await readCurrent();
    const base = retry ? await repository.findGeneration(actor, { ...identity, jobId: retry.retryOfJobId }) : null;
    if (retry && (!base || base.createdBy !== actor.userId || base.jobId !== retry.retryOfJobId
      || base.projectId !== identity.projectId || base.chapterId !== identity.chapterId || !matchesUpstream(base, identity)
      || !retry.scopeKeys.every(key => base.failures.some(failure => failure.scopeKey === key && failure.retryable)))) throw new StoryboardUpstreamError();
    const response = await model.generate(structuredClone({
      ...identity, contractVersion: "0.1.0", stage: "storyboard", input: upstream,
      ...(retry ? { retryOfJobId: retry.retryOfJobId, scopeKeys: retry.scopeKeys } : {}),
    }));
    await readCurrent();
    const result = validateStoryboardResponse(response, identity, upstream.context, retry?.scopeKeys, base?.shots);
    const shots = [...(base?.shots ?? []), ...result.shots];
    const retainedFailures = base && retry ? base.failures.filter(failure => !retry.scopeKeys.includes(failure.scopeKey)) : [];
    const failures = [...retainedFailures, ...result.failures];
    return repository.saveGeneration(actor, {
      ...identity, shots, failures, createdBy: actor.userId,
      generationStatus: failures.length === 0 ? "succeeded" : shots.length ? "partially_succeeded" : "failed",
      ...(retry ? { retry } : {}),
    });
  }
}
