import { BadRequestException, Body, Catch, Controller, Get, Header, Inject, Module, Param, Post, Query, Req, UseGuards, type ArgumentsHost, type DynamicModule, type ExceptionFilter } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import type { Actor, SessionVerifier } from "@novel-adaptation/identity";
import { ModelSettingsError } from "@novel-adaptation/script/model-settings";
import { ModelTaskError, type ModelTaskService } from "@novel-adaptation/script/model-tasks";
import { SESSION_VERIFIER, SessionGuard } from "./index.ts";

const TASKS = Symbol("EPISODE_PLAN_TASKS");
function identifier(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\r\n]/.test(value)) throw new BadRequestException("拆集任务参数无效");
  return value;
}
function selection(body: unknown, submission = false) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !(submission ? ["configurationVersionId","modelId","requestId"] : ["configurationVersionId","modelId"]).includes(key))) throw new BadRequestException("拆集任务参数无效");
  const value = body as Record<string,unknown>;
  return { configurationVersionId: identifier(value.configurationVersionId),modelId: identifier(value.modelId),...(submission ? { requestId: identifier(value.requestId) } : {}) };
}
async function safely<T>(action: () => Promise<T>) {
  try { return await action(); } catch (error) {
    if (error instanceof ModelTaskError || error instanceof ModelSettingsError) throw error;
    throw new ModelTaskError("STORAGE_UNAVAILABLE");
  }
}
class EpisodePlanTaskController {
  readonly #tasks: ModelTaskService;
  constructor(tasks: ModelTaskService) { this.#tasks = tasks; }
  submit(request: { actor: Actor }, p: string, c: string, body: unknown) {
    const chosen = selection(body,true), projectId = identifier(p),chapterId = identifier(c);
    return safely(() => this.#tasks.submitEpisodePlan(request.actor,{ projectId,chapterId,configurationVersionId: chosen.configurationVersionId,modelId: chosen.modelId,requestId: chosen.requestId! }));
  }
  availability(request: { actor: Actor }, p: string, c: string, query: unknown) {
    const chosen = selection(query),projectId = identifier(p),chapterId = identifier(c);
    return safely(() => this.#tasks.availability(request.actor,projectId,chapterId,chosen,"episodePlan"));
  }
  list(request: { actor: Actor }, p: string, c: string, query: Record<string,unknown>) {
    if (Object.keys(query).some(key => !["limit","cursor"].includes(key))) throw new BadRequestException("分页参数无效");
    const limit = query.limit === undefined ? 20 : typeof query.limit === "string" && /^[1-9]\d?$/.test(query.limit) ? Number(query.limit) : NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new BadRequestException("分页参数无效");
    const cursor = query.cursor === undefined ? null : identifier(query.cursor),projectId = identifier(p),chapterId = identifier(c);
    return safely(() => this.#tasks.listEpisodePlans(request.actor,projectId,chapterId,{ limit,cursor }));
  }
  get(request: { actor: Actor }, id: string) {
    const taskId = identifier(id);
    return safely(async () => {
      const task = await this.#tasks.get(request.actor,taskId);
      if (task.input.stage !== "script" || task.input.resultType !== "episodePlan") throw new ModelTaskError("TASK_NOT_FOUND");
      return task;
    });
  }
}
class EpisodeTaskFilter implements ExceptionFilter<ModelTaskError | ModelSettingsError> {
  catch(error: ModelTaskError | ModelSettingsError, host: ArgumentsHost) {
    const status = ["TASK_QUEUE_FULL","TASK_EXECUTION_FULL"].includes(error.code) ? 429 : error.code === "TASK_NOT_FOUND" ? 404
      : ["FORBIDDEN","POLICY_RESTRICTED","WORKSPACE_TASK_DISABLED","TASK_PROVIDER_UNSUPPORTED"].includes(error.code) ? 403
      : ["STATE_CONFLICT","UPSTREAM_CHANGED","VERSION_CONFLICT"].includes(error.code) ? 409
      : ["INVALID_CONTEXT","INVALID_CONFIGURATION"].includes(error.code) ? 400 : 503;
    host.switchToHttp().getResponse().status(status).json({ code: error.code,message: error.code });
  }
}
Catch(ModelTaskError,ModelSettingsError)(EpisodeTaskFilter);
Controller()(EpisodePlanTaskController); UseGuards(SessionGuard)(EpisodePlanTaskController); Inject(TASKS)(EpisodePlanTaskController,undefined,0);
for (const [method,decorator] of [["submit",Post("projects/:projectId/chapters/:chapterId/episode-plan-tasks")], ["list",Get("projects/:projectId/chapters/:chapterId/episode-plan-tasks")], ["availability",Get("projects/:projectId/chapters/:chapterId/episode-plan-tasks/availability")], ["get",Get("episode-plan-tasks/:id")]] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(EpisodePlanTaskController.prototype,method)!;
  decorator(EpisodePlanTaskController.prototype,method,descriptor); Header("Cache-Control","no-store")(EpisodePlanTaskController.prototype,method,descriptor); Req()(EpisodePlanTaskController.prototype,method,0);
  if (method === "get") Param("id")(EpisodePlanTaskController.prototype,method,1);
  else {
    Param("projectId")(EpisodePlanTaskController.prototype,method,1); Param("chapterId")(EpisodePlanTaskController.prototype,method,2);
    if (method === "submit") Body()(EpisodePlanTaskController.prototype,method,3); else Query()(EpisodePlanTaskController.prototype,method,3);
  }
}
/** Optional authenticated boundary only; requires EpisodePlanTaskContext and never exposes a run endpoint. */
export class EpisodePlanTaskApiModule {
  static register(services: { sessionVerifier: SessionVerifier; tasks: ModelTaskService }): DynamicModule {
    return { module: EpisodePlanTaskApiModule,providers: [{ provide: SESSION_VERIFIER,useValue: services.sessionVerifier },{ provide: TASKS,useValue: services.tasks }] };
  }
}
Module({ controllers: [EpisodePlanTaskController],providers: [SessionGuard,{ provide: APP_FILTER,useClass: EpisodeTaskFilter }] })(EpisodePlanTaskApiModule);
