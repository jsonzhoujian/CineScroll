import type { SettingsRegenerationRepository } from "@novel-adaptation/script/settings-regeneration";
import type { SettingsReviewRepository,SettingsReviewService } from "@novel-adaptation/script/settings-review";
import { BadRequestException,Controller,Get,Header,Inject,Module,NotFoundException,Param,Query,Req,ServiceUnavailableException,UseGuards,type DynamicModule } from "@nestjs/common";
import type { Actor,SessionVerifier } from "@novel-adaptation/identity";
import type { ProjectImportRepository } from "@novel-adaptation/project-import";
import { ModelTaskError,type ModelTaskService } from "@novel-adaptation/script/model-tasks";
import { ScriptContentError,type ScriptContentRepository } from "@novel-adaptation/script/script-content";
import type { ConfirmedScriptHandoff } from "@novel-adaptation/script/script-handoff";
import type { SettingsCandidate,SettingsCandidateRepository } from "@novel-adaptation/script/settings-runner";
import type { SettingsTaskContext } from "./settings-task-executor.ts";
import { SESSION_VERIFIER,SessionGuard } from "./index.ts";
const SERVICES = Symbol("SETTINGS_READ");
type Services = { regeneration?: { tasks: ModelTaskService;repository: SettingsRegenerationRepository };reviews?: SettingsReviewRepository;review?: SettingsReviewService;sessionVerifier: SessionVerifier;tasks: ModelTaskService;repository: SettingsCandidateRepository & { findActive(a: Actor,p: string,c: string): Promise<SettingsCandidate | null> };
  context: Pick<SettingsTaskContext,"canRead">;handoff: Pick<ConfirmedScriptHandoff,"read">;projects: Pick<ProjectImportRepository,"findChapter">;scripts: Pick<ScriptContentRepository,"findVersion"> };
function identifier(v: unknown) { return typeof v === "string" && !!v.trim() && v.length <= 256 && !/[\r\n]/.test(v); }
class SettingsController {
  private readonly services: Services;
  constructor(services: Services) { this.services = services; }
  async view(request: { actor: Actor },p: string,c: string,query: Record<string,unknown>) {
    if (Object.keys(query).length) throw new BadRequestException();
    return this.read(request.actor,p,c);
  }
  async generation(request: { actor: Actor },p: string,c: string,id: string) {
    if (!identifier(id)) throw new BadRequestException();
    return this.read(request.actor,p,c,id);
  }
  async regeneration(request: { actor: Actor },p: string,c: string,id: string) {
    if (!identifier(id) || !this.services.regeneration) throw new NotFoundException();
    return this.read(request.actor,p,c,id,true);
  }
  private async read(a: Actor,p: string,c: string,jobId?: string,regeneration = false) {
    if (![p,c].every(identifier)) throw new BadRequestException();
    try {
      if (!await this.services.context.canRead(a,p,c)) throw new NotFoundException();
      if (jobId) {
        const task = await (regeneration ? this.services.regeneration!.tasks : this.services.tasks).get(a,jobId);
        if (task.projectId !== p || task.chapterId !== c || task.input.stage !== "settings" || task.input.resultType !== (regeneration ? "settingsRegeneration" : "settingsContent")) throw new NotFoundException();
      }
      const version = jobId ? await (regeneration ? this.services.regeneration!.repository : this.services.repository).findGeneration(a,p,c,jobId) : await (this.services.reviews ?? this.services.repository).findActive(a,p,c);
      if (!version) throw new NotFoundException();
      const chapter = await this.services.projects.findChapter(a,p,c),source = chapter?.versions.find(v => v.id === version.sourceVersionId);
      const scriptVersion = await this.services.scripts.findVersion?.(a,p,c,version.scriptVersionId);
      if (!source || !scriptVersion || scriptVersion.status !== "confirmed" || scriptVersion.sourceVersionId !== version.sourceVersionId) throw new Error("PINNED_EVIDENCE_UNAVAILABLE");
      let current = false;
      try {
        const formal = await this.services.handoff.read(a,p,c),ids = [formal.version.id,...formal.upstreamConfirmedVersionIds];
        current = formal.version.id === version.scriptVersionId && formal.version.sourceVersionId === version.sourceVersionId
          && ids.length === version.upstreamConfirmedVersionIds.length && ids.every((id,i) => id === version.upstreamConfirmedVersionIds[i]);
      } catch (error) {
        if (!(error instanceof ScriptContentError && ["CONTEXT_NOT_FOUND","INVALID_STATE"].includes(error.code))) throw error;
      }
      const active = !!this.services.reviews && (!jobId || (await this.services.reviews.findActive(a,p,c))?.id === version.id);
      const allowed = current && active && this.services.review ? await this.services.review.permissions(a,p) : { canEdit: false,canSuggest: false,canDecide: false,canConfirm: false,canLock: false };
      const permissions = { ...allowed,canEdit: allowed.canEdit && version.status === "candidate",canConfirm: allowed.canConfirm && version.status === "candidate",canLock: allowed.canLock && version.status === "confirmed" };
      return { version,current,active,permissions,sourceFragments: source.fragments.map(({ id,text }) => ({ id,text })),scriptVersion };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      if (error instanceof ModelTaskError && error.code === "TASK_NOT_FOUND") throw new NotFoundException();
      throw new ServiceUnavailableException({ code: "STORAGE_UNAVAILABLE",message: "STORAGE_UNAVAILABLE" });
    }
  }
}
Controller("projects/:projectId/chapters/:chapterId/settings")(SettingsController);UseGuards(SessionGuard)(SettingsController);Inject(SERVICES)(SettingsController,undefined,0);
for (const [method,path] of [["view",""],["generation","generations/:id"],["regeneration","regenerations/:id"]] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(SettingsController.prototype,method)!;
  Get(path)(SettingsController.prototype,method,descriptor);Header("Cache-Control","no-store")(SettingsController.prototype,method,descriptor);
  Req()(SettingsController.prototype,method,0);Param("projectId")(SettingsController.prototype,method,1);Param("chapterId")(SettingsController.prototype,method,2);
  if (method !== "view") Param("id")(SettingsController.prototype,method,3);else Query()(SettingsController.prototype,method,3);
}
export class SettingsApiModule {
  static register(services: Services): DynamicModule { return { module: SettingsApiModule,providers: [{ provide: SESSION_VERIFIER,useValue: services.sessionVerifier },{ provide: SERVICES,useValue: services }] }; }
}
Module({ controllers: [SettingsController],providers: [SessionGuard] })(SettingsApiModule);
