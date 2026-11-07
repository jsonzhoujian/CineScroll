import type { Actor } from "./index.ts";
import type { ConfirmedStoryboardHandoff } from "./storyboard-handoff.ts";
import { StoryboardUpstreamError } from "./storyboard-handoff.ts";
import { validateStoryboardResponse, type StoryboardResponseIdentity } from "./storyboard-content.ts";

type FormalInput = Awaited<ReturnType<ConfirmedStoryboardHandoff["read"]>>;
export type StoryboardRequest = StoryboardResponseIdentity & {
  contractVersion: "0.1.0";
  stage: "storyboard";
  input: FormalInput;
};
export type StoryboardCandidate = StoryboardResponseIdentity & ReturnType<typeof validateStoryboardResponse> & {
  createdBy: string;
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
  async run(actor: Actor, task: StoryboardResponseIdentity): Promise<StoryboardCandidate> {
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
    const response = await model.generate(structuredClone({
      ...identity, contractVersion: "0.1.0", stage: "storyboard", input: upstream,
    }));
    await readCurrent();
    const result = validateStoryboardResponse(response, identity, upstream.context);
    return repository.saveGeneration(actor, { ...identity, ...result, createdBy: actor.userId });
  }
}
