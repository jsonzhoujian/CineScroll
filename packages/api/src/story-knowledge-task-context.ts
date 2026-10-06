import type { Actor } from "@novel-adaptation/identity";
import type { ProjectImportRepository } from "@novel-adaptation/project-import";
import type { ModelTaskContextReader, TaskInput } from "@novel-adaptation/script/model-tasks";
import type { StoryKnowledgeRetryPlanner, StoryRetrySelection } from "./story-knowledge-retry-planner.ts";

/** Authority/source reader only; ModelTaskService separately enforces current generationPolicy. */
export class StoryKnowledgeTaskContext implements ModelTaskContextReader {
  private readonly projects: Pick<ProjectImportRepository, "findProjectAccess" | "findProject" | "findChapter">;
  private readonly retryPlanner: StoryKnowledgeRetryPlanner | undefined;
  constructor(projects: Pick<ProjectImportRepository, "findProjectAccess" | "findProject" | "findChapter">, retryPlanner?: StoryKnowledgeRetryPlanner) { this.projects = projects; this.retryPlanner = retryPlanner; }
  async readRetry(actor: Actor, projectId: string, chapterId: string, selection: StoryRetrySelection): Promise<TaskInput | null> {
    if (!this.retryPlanner) return null;
    const input = await this.read(actor, projectId, chapterId);
    if (!input) return null;
    const plan = await this.retryPlanner.plan(actor, projectId, chapterId, selection);
    if (plan.sourceVersionId !== input.sourceVersionId) return null;
    return { ...input, retry: { expectedActiveVersionId: plan.expectedActiveVersionId, retryOfJobId: plan.retryOfJobId, scopeKeys: plan.scopeKeys } };
  }
  async read(actor: Actor, projectId: string, chapterId: string): Promise<TaskInput | null> {
    if (!await this.projects.findProjectAccess(actor, projectId)) return null;
    const project = await this.projects.findProject(actor, projectId);
    if (!project || project.workspaceId !== actor.workspaceId) return null;
    const chapter = await this.projects.findChapter(actor, projectId, chapterId);
    const source = chapter?.versions.find(version => version.id === chapter.activeSourceVersionId);
    if (!source || !source.text.trim() || !source.fragments.length || source.characterCount > 20_000) return null;
    return { stage: "story_knowledge", sourceVersionId: source.id, upstreamConfirmedVersionIds: [], generationParameters: {
      targetDurationSeconds: project.targetDurationSeconds, aspectRatio: project.aspectRatio, narrativeMode: project.narrativeMode,
    } };
  }
}
