import type { Actor } from "@novel-adaptation/identity";
import type { ProjectImportRepository } from "@novel-adaptation/project-import";
import { ModelTaskError } from "@novel-adaptation/script/model-tasks";
import { StoryKnowledgeError, type StoryKnowledgeService } from "@novel-adaptation/story-knowledge";

export type RetryPlanningOptions = {
  projects: Pick<ProjectImportRepository, "findProjectAccess" | "findChapter">;
  storyKnowledge: Pick<StoryKnowledgeService, "getActive">;
};
export type StoryRetrySelection = { expectedActiveVersionId: string; scopeKeys: string[] };

/** Read-only admission, not a reservation. Execution and merge must revalidate. */
export class StoryKnowledgeRetryPlanner {
  private readonly options: RetryPlanningOptions;
  constructor(options: RetryPlanningOptions) { this.options = options; }
  async plan(actor: Actor, projectId: string, chapterId: string, selection: StoryRetrySelection) {
    if (!Array.isArray(selection.scopeKeys) || !selection.scopeKeys.length || selection.scopeKeys.length > 100 || new Set(selection.scopeKeys).size !== selection.scopeKeys.length
      || ![selection.expectedActiveVersionId, ...selection.scopeKeys].every(value => typeof value === "string" && !!value.trim() && value.length <= 256 && !/[\r\n]/.test(value))) {
      throw new ModelTaskError("INVALID_CONTEXT");
    }
    if (!await this.options.projects.findProjectAccess(actor, projectId)) throw new ModelTaskError("TASK_NOT_FOUND");
    const chapter = await this.options.projects.findChapter(actor, projectId, chapterId);
    if (!chapter) throw new ModelTaskError("TASK_NOT_FOUND");
    let candidate;
    try { candidate = await this.options.storyKnowledge.getActive(actor, projectId, chapterId); }
    catch (error) {
      if (error instanceof StoryKnowledgeError && error.code === "STAGE_RESULT_NOT_FOUND") throw new ModelTaskError("TASK_NOT_FOUND");
      throw error;
    }
    if (candidate.sourceVersionId !== chapter.activeSourceVersionId) throw new ModelTaskError("UPSTREAM_CHANGED");
    if (candidate.id !== selection.expectedActiveVersionId || candidate.status === "confirmed") throw new ModelTaskError("STATE_CONFLICT");
    const failures = selection.scopeKeys.map(scope => candidate.failures.find(failure => failure.scopeKey === scope));
    if (failures.some(failure => !failure?.retryable)) throw new ModelTaskError("INVALID_CONTEXT");
    const origins = new Set(failures.map(failure => failure!.originJobId));
    if (origins.size !== 1) throw new ModelTaskError("INVALID_CONTEXT");
    return { projectId, chapterId, expectedActiveVersionId: candidate.id, sourceVersionId: candidate.sourceVersionId,
      retryOfJobId: failures[0]!.originJobId, scopeKeys: [...selection.scopeKeys].sort() };
  }
}
