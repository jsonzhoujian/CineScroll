import type { Actor } from "@novel-adaptation/identity";
import type { ProjectImportRepository } from "@novel-adaptation/project-import";
import type { ModelTaskContextReader, TaskInput } from "@novel-adaptation/script/model-tasks";

/** Reads only authoritative imported versions; import-time scanning is not a current compliance verdict. */
export class StoryKnowledgeTaskContext implements ModelTaskContextReader {
  private readonly projects: Pick<ProjectImportRepository, "findProjectAccess" | "findProject" | "findChapter">;
  constructor(projects: Pick<ProjectImportRepository, "findProjectAccess" | "findProject" | "findChapter">) { this.projects = projects; }
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
