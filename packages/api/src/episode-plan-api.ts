import { BadRequestException, Body, Catch, Controller, Get, Header, Inject, Module, Param, Post, Req, UseGuards, type ArgumentsHost, type DynamicModule, type ExceptionFilter } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import type { Actor, SessionVerifier } from "@novel-adaptation/identity";
import type { ProjectImportRepository } from "@novel-adaptation/project-import";
import { ScriptError, type ScriptService, type ScriptUpstreamReader } from "@novel-adaptation/script";
import { StoryKnowledgeError, type StoryKnowledgeService } from "@novel-adaptation/story-knowledge";
import { SESSION_VERIFIER, SessionGuard } from "./index.ts";

type Projects = Pick<ProjectImportRepository, "findChapter" | "findProjectAccess">;
type Knowledge = Pick<StoryKnowledgeService, "getConfirmedStoryBible" | "getVersion">;
type Services = { sessionVerifier: SessionVerifier; script: ScriptService; projects: Projects; knowledge: Knowledge };
const SERVICES = Symbol("EPISODE_PLAN_SERVICES");
export class EpisodePlanUpstreamReader implements ScriptUpstreamReader {
  readonly #projects: Projects; readonly #knowledge: Knowledge;
  constructor(projects: Projects, knowledge: Knowledge) { this.#projects = projects; this.#knowledge = knowledge; }
  async findConfirmedStoryBible(actor: Actor, projectId: string, chapterId: string) {
    if (!await this.#projects.findProjectAccess(actor, projectId)) return null;
    const chapter = await this.#projects.findChapter(actor, projectId, chapterId);
    const bible = await currentBible(this.#knowledge, actor, projectId, chapterId);
    const source = chapter?.versions.find(v => v.id === chapter.activeSourceVersionId);
    if (!source || !bible) return null;
    const knowledge = await this.#knowledge.getVersion(actor, projectId, chapterId, bible.versionId);
    if (knowledge.sourceVersionId !== source.id || knowledge.status !== "confirmed") return null;
    return { versionId: bible.versionId, sourceVersionId: source.id, factIds: bible.facts.map(f => f.id), fragmentIds: source.fragments.map(f => f.id) };
  }
}
async function currentBible(knowledge: Knowledge, actor: Actor, projectId: string, chapterId: string) {
  try { return await knowledge.getConfirmedStoryBible(actor, projectId, chapterId); }
  catch (error) { if (error instanceof StoryKnowledgeError && error.code === "STAGE_RESULT_NOT_FOUND") return null; throw error; }
}
function identifier(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\r\n]/.test(value)) throw new BadRequestException("拆集参数无效");
  return value;
}
function command(body: unknown, decision = false) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !(decision ? ["expectedActiveVersionId", "decision", "reason"] : ["expectedActiveVersionId"]).includes(key))) throw new BadRequestException("拆集参数无效");
  const value = body as Record<string, unknown>;
  const expectedActiveVersionId = identifier(value.expectedActiveVersionId);
  if (decision && !["approved", "rejected"].includes(String(value.decision))) throw new BadRequestException("裁决参数无效");
  return { expectedActiveVersionId, ...(decision ? { decision: value.decision as "approved" | "rejected", reason: identifier(value.reason, 2000) } : {}) };
}
async function safely<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) { if (error instanceof ScriptError) throw error; throw new ScriptError("STORAGE_UNAVAILABLE", "拆集服务暂不可用"); }
}
class EpisodePlanController {
  readonly #services: Services;
  constructor(services: Services) { this.#services = services; }
  async #access(actor: Actor, p: string, c: string) {
    const role = await this.#services.projects.findProjectAccess(actor,p), chapter = role ? await this.#services.projects.findChapter(actor,p,c) : null;
    if (!role || !chapter) throw new ScriptError("EPISODE_PLAN_NOT_FOUND", "拆集方案不存在");
    return { role, chapter };
  }
  view(request: { actor: Actor }, p: string, c: string, versionId?: string) {
    p = identifier(p); c = identifier(c); if (versionId !== undefined) versionId = identifier(versionId);
    return safely(async () => {
      const { role, chapter } = await this.#access(request.actor,p,c);
      const plan = await this.#services.script.getEpisodePlan(request.actor,p,c,versionId);
      const [active, bible, knowledge] = await Promise.all([this.#services.script.getEpisodePlan(request.actor,p,c), currentBible(this.#services.knowledge,request.actor,p,c), this.#services.knowledge.getVersion(request.actor,p,c,plan.storyBibleVersionId)]);
      const source = chapter.versions.find(v => v.id === plan.sourceVersionId);
      const current = active.id === plan.id && chapter.activeSourceVersionId === plan.sourceVersionId && bible?.versionId === plan.storyBibleVersionId;
      return { plan, current, canReview: current && plan.status === "candidate" && role.role !== "editor", sourceFragments: source?.fragments.map(({ id,text }) => ({ id,text })) ?? [],
        coreEvents: knowledge.facts.filter(f => f.factType === "event" && f.decision?.outcome === "accepted").map(({ id,statement }) => ({ id,statement })) };
    });
  }
  decide(request: { actor: Actor }, p: string, c: string, proposalId: string, body: unknown) {
    p = identifier(p); c = identifier(c); proposalId = identifier(proposalId); const input = command(body,true);
    return safely(async () => { await this.#access(request.actor,p,c); return this.#services.script.decideMajorAdaptation(request.actor,p,c,{ expectedActiveVersionId: input.expectedActiveVersionId, proposalId, decision: input.decision!, reason: input.reason! }); });
  }
  confirm(request: { actor: Actor }, p: string, c: string, body: unknown) {
    p = identifier(p); c = identifier(c); const input = command(body);
    return safely(async () => { await this.#access(request.actor,p,c); return this.#services.script.confirmEpisodePlan(request.actor,p,c,input); });
  }
}
class EpisodePlanFilter implements ExceptionFilter<ScriptError> {
  catch(error: ScriptError, host: ArgumentsHost) {
    const status = error.code === "STORAGE_UNAVAILABLE" ? 503 : error.code === "FORBIDDEN" ? 403 : ["EPISODE_PLAN_NOT_FOUND", "PROPOSAL_NOT_FOUND"].includes(error.code) ? 404 : error.code === "INVALID_EPISODE_PLAN" ? 400 : 409;
    host.switchToHttp().getResponse().status(status).json({ code: error.code, message: error.code });
  }
}
Catch(ScriptError)(EpisodePlanFilter);
Controller("projects/:projectId/chapters/:chapterId/episode-plan")(EpisodePlanController);
UseGuards(SessionGuard)(EpisodePlanController);
Inject(SERVICES)(EpisodePlanController,undefined,0);
for (const [method, decorator] of [["view",Get()], ["decide",Post("proposals/:proposalId/decision")], ["confirm",Post("confirm")]] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(EpisodePlanController.prototype,method)!;
  decorator(EpisodePlanController.prototype,method,descriptor); Header("Cache-Control","no-store")(EpisodePlanController.prototype,method,descriptor);
  Req()(EpisodePlanController.prototype,method,0); Param("projectId")(EpisodePlanController.prototype,method,1); Param("chapterId")(EpisodePlanController.prototype,method,2);
  if (method === "decide") { Param("proposalId")(EpisodePlanController.prototype,method,3); Body()(EpisodePlanController.prototype,method,4); }
  if (method === "confirm") Body()(EpisodePlanController.prototype,method,3);
}
// Separate handler avoids decorating a method twice with distinct GET paths.
class EpisodePlanHistoryController {
  readonly #controller: EpisodePlanController;
  constructor(services: Services) { this.#controller = new EpisodePlanController(services); }
  view(request: { actor: Actor }, p: string, c: string, id: string) { return this.#controller.view(request,p,c,id); }
}
Controller("projects/:projectId/chapters/:chapterId/episode-plan/versions")(EpisodePlanHistoryController);
UseGuards(SessionGuard)(EpisodePlanHistoryController); Inject(SERVICES)(EpisodePlanHistoryController,undefined,0);
const history = Object.getOwnPropertyDescriptor(EpisodePlanHistoryController.prototype,"view")!;
Get(":versionId")(EpisodePlanHistoryController.prototype,"view",history); Header("Cache-Control","no-store")(EpisodePlanHistoryController.prototype,"view",history);
Req()(EpisodePlanHistoryController.prototype,"view",0); Param("projectId")(EpisodePlanHistoryController.prototype,"view",1); Param("chapterId")(EpisodePlanHistoryController.prototype,"view",2); Param("versionId")(EpisodePlanHistoryController.prototype,"view",3);
export class EpisodePlanApiModule {
  static register(services: Services): DynamicModule { return { module: EpisodePlanApiModule, providers: [{ provide: SERVICES, useValue: services }, { provide: SESSION_VERIFIER, useValue: services.sessionVerifier }] }; }
}
Module({ controllers: [EpisodePlanController,EpisodePlanHistoryController], providers: [SessionGuard, { provide: APP_FILTER, useClass: EpisodePlanFilter }] })(EpisodePlanApiModule);
