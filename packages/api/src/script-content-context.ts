import type { Actor, ScriptService } from "@novel-adaptation/script";
import { ScriptError } from "@novel-adaptation/script";
import type { ProjectImportRepository } from "@novel-adaptation/project-import";
import type { StoryKnowledgeService } from "@novel-adaptation/story-knowledge";
import { StoryKnowledgeError } from "@novel-adaptation/story-knowledge";
import type { ScriptGenerationContextReader } from "@novel-adaptation/script/script-content";
import type { ModelTaskContextReader } from "@novel-adaptation/script/model-tasks";

type Projects = Pick<ProjectImportRepository,"findProjectAccess" | "findProject" | "findChapter">;
export class ScriptContentContext implements ScriptGenerationContextReader, ModelTaskContextReader {
  private readonly projects: Projects; private readonly knowledge: StoryKnowledgeService; private readonly plans: ScriptService;
  constructor(projects: Projects,knowledge: StoryKnowledgeService,plans: ScriptService) { this.projects = projects; this.knowledge = knowledge; this.plans = plans; }
  async canRead(actor: Actor,p: string,c: string) { return !!await this.projects.findProjectAccess(actor,p) && !!await this.projects.findChapter(actor,p,c); }
  async findGenerationContext(actor: Actor,p: string,c: string) {
    if (!await this.canRead(actor,p,c)) return null;
    const project = await this.projects.findProject(actor,p), chapter = await this.projects.findChapter(actor,p,c);
    const source = chapter?.versions.find(v => v.id === chapter.activeSourceVersionId);
    if (!project || project.workspaceId !== actor.workspaceId || !source || !source.fragments.length || !source.text.trim() || source.characterCount > 20000) return null;
    try {
      const plan = await this.plans.getEpisodePlan(actor,p,c), bible = await this.knowledge.getConfirmedStoryBible(actor,p,c);
      const knowledge = await this.knowledge.getVersion(actor,p,c,bible.versionId);
      if (plan.status !== "confirmed" || plan.sourceVersionId !== source.id || plan.storyBibleVersionId !== bible.versionId
        || knowledge.sourceVersionId !== source.id || knowledge.status !== "confirmed" || plan.targetDurationSeconds !== project.targetDurationSeconds
        || plan.aspectRatio !== project.aspectRatio || plan.narrativeMode !== project.narrativeMode || plan.majorAdaptationProposals.some(p => !p.decision)) return null;
      return { sourceVersionId: source.id,planVersionId: plan.id,confirmedPlan: plan,
        confirmedStoryKnowledge: { versionId: bible.versionId,facts: bible.facts.map(({ id,statement }) => ({ id,statement })) },
        fragments: source.fragments.map(({ id,text }) => ({ id,text })),approvedAdditionIds: [] };
    } catch (error) {
      if (error instanceof ScriptError && error.code === "EPISODE_PLAN_NOT_FOUND" || error instanceof StoryKnowledgeError && error.code === "STAGE_RESULT_NOT_FOUND") return null;
      throw error;
    }
  }
  async read(actor: Actor,p: string,c: string) {
    const context = await this.findGenerationContext(actor,p,c);
    if (!context) return null;
    const plan = context.confirmedPlan;
    return { stage: "script" as const,resultType: "scriptContent" as const,sourceVersionId: context.sourceVersionId,
      upstreamConfirmedVersionIds: [plan.id,plan.storyBibleVersionId],generationParameters: { targetDurationSeconds: plan.targetDurationSeconds,aspectRatio: plan.aspectRatio,narrativeMode: plan.narrativeMode } };
  }
}
