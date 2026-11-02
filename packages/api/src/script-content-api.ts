import type { ScriptRevisionService,ScriptRevisionCommand } from "@novel-adaptation/script/script-revision";
import { ModelTaskError, type ModelTaskService } from "@novel-adaptation/script/model-tasks";
import { ModelSettingsError } from "@novel-adaptation/script/model-settings";
import type { PublicationCommand, ScriptPublicationService } from "@novel-adaptation/script/script-publication";
import type { ModelRateLimiter } from "./model-rate-limit.ts";
import { enforceTaskSubmissionRate, type TaskSubmissionRequest } from "./task-submission-rate.ts";
import { BadRequestException, Body, Post, Catch, Controller, Get, Header, Inject, Module, Param, Query, Req, UseGuards, type ArgumentsHost, type DynamicModule, type ExceptionFilter } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import type { Actor, SessionVerifier } from "@novel-adaptation/identity";
import { ScriptContentError, type ScriptContentService, type ScriptReviewCommand, type ScriptContentRepository } from "@novel-adaptation/script/script-content";
import type { ScriptContentContext } from "./script-content-context.ts";
import { SESSION_VERIFIER, SessionGuard } from "./index.ts";
const SERVICES = Symbol("SCRIPT_CONTENT_READ");
type Services = { sessionVerifier: SessionVerifier;repository: ScriptContentRepository;context: ScriptContentContext;revision?: ScriptRevisionService;review?: ScriptContentService;publication?: ScriptPublicationService;qualityTasks?: ModelTaskService;rateLimiter?: ModelRateLimiter };
class ScriptContentController {
  private readonly services: Services;
  constructor(services: Services) { this.services = services; }
  async view(request: { actor: Actor },p: string,c: string) {
    if (![p,c].every(v => typeof v === "string" && !!v.trim() && v.length <= 256 && !/[\r\n]/.test(v))) throw new BadRequestException();
    try {
      if (!await this.services.context.canRead(request.actor,p,c)) throw new ScriptContentError("CONTEXT_NOT_FOUND","不可读取剧本");
      const version = await this.services.repository.findActive(request.actor,p,c);
      if (!version) throw new ScriptContentError("CONTEXT_NOT_FOUND","尚无剧本候选");
      const context = await this.services.context.findGenerationContext(request.actor,p,c);
      const current = context?.sourceVersionId === version.sourceVersionId && context?.planVersionId === version.planVersionId;
      return { version,current,episodes: current ? context!.confirmedPlan?.episodes.map(({ id,ordinal }) => ({ id,ordinal })) ?? [] : [],permissions: current && this.services.review ? await this.services.review.getReviewPermissions(request.actor,p) : { canEdit: false,canSuggest: false,canDecide: false },sourceFragments: current ? context!.fragments : [] };
    } catch (error) { if (error instanceof ScriptContentError) throw error; throw new ScriptContentError("STORAGE_UNAVAILABLE","剧本读取失败"); }
  }
  async revise(request: { actor: Actor },p: string,c: string,body: unknown) {
    if (![p,c].every(identifier)) throw new BadRequestException();
    if (!await this.services.context.canRead(request.actor,p,c)) throw new ScriptContentError("CONTEXT_NOT_FOUND","不可读取剧本");
    if (!this.services.revision) throw new ScriptContentError("STORAGE_UNAVAILABLE","修订服务未开放");
    try { return await this.services.revision.execute(request.actor,p,c,body as ScriptRevisionCommand); }
    catch (error) { if (error instanceof ScriptContentError) throw error;throw new ScriptContentError("STORAGE_UNAVAILABLE","修订服务暂不可用"); }
  }
  async historical(request: { actor: Actor },p: string,c: string,id: string) {
    if (![p,c,id].every(identifier)) throw new BadRequestException();
    if (!await this.services.context.canRead(request.actor,p,c)) throw new ScriptContentError("CONTEXT_NOT_FOUND","不可读取剧本");
    try {
      const version = id === "confirmed" ? await this.services.repository.findConfirmed?.(request.actor,p,c) : await this.services.repository.findVersion?.(request.actor,p,c,id);
      if (!version) throw new ScriptContentError("CONTEXT_NOT_FOUND","版本不存在");
      return { version };
    } catch (error) { if (error instanceof ScriptContentError) throw error;throw new ScriptContentError("STORAGE_UNAVAILABLE","版本读取失败"); }
  }
  async qualityList(request: { actor: Actor },p: string,c: string,query: Record<string,unknown>) {
    if (![p,c].every(identifier) || Object.keys(query).some(k => k !== "cursor") || query.cursor !== undefined && !identifier(query.cursor)) throw new BadRequestException();
    if (!this.services.qualityTasks) throw new ScriptContentError("STORAGE_UNAVAILABLE","评估未开放");
    return this.services.qualityTasks.listScriptQuality(request.actor,p,c,{ limit: 20,cursor: query.cursor as string ?? null });
  }
  async qualitySubmit(request: TaskSubmissionRequest,p: string,c: string,body: unknown) {
    const b = body as Record<string,unknown>;
    if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).some(k => !["requestId","configurationVersionId","modelId","expectedActiveVersionId"].includes(k)) || ![p,c,b.requestId,b.configurationVersionId,b.modelId,b.expectedActiveVersionId].every(identifier)) throw new BadRequestException();
    if (!this.services.qualityTasks) throw new ScriptContentError("STORAGE_UNAVAILABLE","评估未开放");
    await enforceTaskSubmissionRate(this.services.rateLimiter ?? null,request);
    return this.services.qualityTasks.submitScriptQuality(request.actor,{ projectId: p,chapterId: c,requestId: b.requestId as string,configurationVersionId: b.configurationVersionId as string,modelId: b.modelId as string,expectedActiveVersionId: b.expectedActiveVersionId as string });
  }
  async qualityRead(request: { actor: Actor },p: string,c: string,id: string) {
    if (![p,c,id].every(identifier)) throw new BadRequestException();
    if (!this.services.qualityTasks || !this.services.publication) throw new ScriptContentError("STORAGE_UNAVAILABLE","评估未开放");
    const task = await this.services.qualityTasks.get(request.actor,id);
    if (task.projectId !== p || task.chapterId !== c || task.input.resultType !== "scriptQuality") throw new ModelTaskError("TASK_NOT_FOUND");
    return { task,report: await this.services.publication.report(request.actor,p,c,id) };
  }
  async publish(request: { actor: Actor },p: string,c: string,body: unknown) {
    if (![p,c].every(identifier)) throw new BadRequestException();
    if (!this.services.publication) throw new ScriptContentError("STORAGE_UNAVAILABLE","确认未开放");
    return this.services.publication.execute(request.actor,p,c,body as PublicationCommand);
  }
  async command(request: { actor: Actor },p: string,c: string,body: unknown) {
    if (![p,c].every(v => typeof v === "string" && !!v.trim() && v.length <= 256 && !/[\r\n]/.test(v))) throw new BadRequestException();
    if (!this.services.review) throw new ScriptContentError("STORAGE_UNAVAILABLE","审核服务未开放");
    try { return await this.services.review.reviewCandidate(request.actor,p,c,body as ScriptReviewCommand); }
    catch (error) { if (error instanceof ScriptContentError) throw error; throw new ScriptContentError("STORAGE_UNAVAILABLE","审核服务暂不可用"); }
  }

}
function identifier(v: unknown) { return typeof v === "string" && !!v.trim() && v.length <= 256 && !/[\r\n]/.test(v); }
class ScriptContentFilter implements ExceptionFilter<ScriptContentError | ModelTaskError | ModelSettingsError> {
  catch(error: ScriptContentError | ModelTaskError | ModelSettingsError,host: ArgumentsHost) { host.switchToHttp().getResponse().status(["CONTEXT_NOT_FOUND","TASK_NOT_FOUND"].includes(error.code) ? 404 : ["FORBIDDEN","POLICY_RESTRICTED","WORKSPACE_TASK_DISABLED","TASK_PROVIDER_UNSUPPORTED"].includes(error.code) ? 403 : ["INVALID_EDIT","INVALID_CONTEXT"].includes(error.code) ? 400 : ["TASK_QUEUE_FULL","TASK_EXECUTION_FULL"].includes(error.code) ? 429 : ["STORAGE_UNAVAILABLE","NOT_READY","PROVIDER_UNAVAILABLE","TASK_LIMITS_UNAVAILABLE"].includes(error.code) ? 503 : 409).json({ code: error.code,message: error.code }); }
}
Catch(ScriptContentError,ModelTaskError,ModelSettingsError)(ScriptContentFilter);
Controller("projects/:projectId/chapters/:chapterId/script-content")(ScriptContentController); UseGuards(SessionGuard)(ScriptContentController); Inject(SERVICES)(ScriptContentController,undefined,0);
const descriptor = Object.getOwnPropertyDescriptor(ScriptContentController.prototype,"view")!;
Get()(ScriptContentController.prototype,"view",descriptor); Header("Cache-Control","no-store")(ScriptContentController.prototype,"view",descriptor);
Req()(ScriptContentController.prototype,"view",0); Param("projectId")(ScriptContentController.prototype,"view",1); Param("chapterId")(ScriptContentController.prototype,"view",2);
const commandDescriptor = Object.getOwnPropertyDescriptor(ScriptContentController.prototype,"command")!;
Post("review")(ScriptContentController.prototype,"command",commandDescriptor); Header("Cache-Control","no-store")(ScriptContentController.prototype,"command",commandDescriptor);
Req()(ScriptContentController.prototype,"command",0); Param("projectId")(ScriptContentController.prototype,"command",1); Param("chapterId")(ScriptContentController.prototype,"command",2); Body()(ScriptContentController.prototype,"command",3);
for (const [method,decorator] of [["revise",Post("revision")],["historical",Get("versions/:id")],["qualityList",Get("quality")],["qualitySubmit",Post("quality")],["qualityRead",Get("quality/:id")],["publish",Post("publication")]] as const) {
  const d = Object.getOwnPropertyDescriptor(ScriptContentController.prototype,method)!;
  decorator(ScriptContentController.prototype,method,d);Header("Cache-Control","no-store")(ScriptContentController.prototype,method,d);
  Req()(ScriptContentController.prototype,method,0);Param("projectId")(ScriptContentController.prototype,method,1);Param("chapterId")(ScriptContentController.prototype,method,2);
  if (method === "qualityList") Query()(ScriptContentController.prototype,method,3);else if (method === "qualityRead" || method === "historical") Param("id")(ScriptContentController.prototype,method,3); else Body()(ScriptContentController.prototype,method,3);
}
export class ScriptContentApiModule {
  static register(services: Services): DynamicModule { return { module: ScriptContentApiModule,providers: [{ provide: SERVICES,useValue: services },{ provide: SESSION_VERIFIER,useValue: services.sessionVerifier }] }; }
}
Module({ controllers: [ScriptContentController],providers: [SessionGuard,{ provide: APP_FILTER,useClass: ScriptContentFilter }] })(ScriptContentApiModule);
