import { BadRequestException, Body, Catch, Controller, Get, Header, Inject, Module, Param, Post, Query, Req, UseGuards, type ArgumentsHost, type DynamicModule, type ExceptionFilter } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import type { Actor, SessionVerifier } from "@novel-adaptation/identity";
import { ModelSettingsError } from "@novel-adaptation/script/model-settings";
import { ModelTaskError, type ModelTaskService } from "@novel-adaptation/script/model-tasks";
import { SESSION_VERIFIER, SessionGuard } from "./index.ts";
import type { ModelRateLimiter } from "./model-rate-limit.ts";
import { enforceTaskSubmissionRate, type TaskSubmissionRequest } from "./task-submission-rate.ts";

const TASKS = Symbol("SETTINGS_TASKS");
const RATE = Symbol("SETTINGS_TASK_RATE");
function identifier(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\r\n]/.test(value)) throw new BadRequestException("设定任务参数无效");
  return value;
}
function selection(body: unknown, submission = false) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !(submission ? ["configurationVersionId","modelId","requestId"] : ["configurationVersionId","modelId"]).includes(key))) throw new BadRequestException("设定任务参数无效");
  const value = body as Record<string,unknown>;
  return { configurationVersionId: identifier(value.configurationVersionId),modelId: identifier(value.modelId),...(submission ? { requestId: identifier(value.requestId) } : {}) };
}
async function safely<T>(action: () => Promise<T>) {
  try { return await action(); } catch (error) {
    if (error instanceof ModelTaskError || error instanceof ModelSettingsError) throw error;
    throw new ModelTaskError("STORAGE_UNAVAILABLE");
  }
}
class SettingsTaskController {
  readonly #tasks: ModelTaskService;
  readonly #rate: ModelRateLimiter | null;
  constructor(tasks: ModelTaskService, rate: ModelRateLimiter | null) { this.#tasks = tasks; this.#rate = rate; }
  async submit(request: TaskSubmissionRequest, p: string, c: string, body: unknown) {
    const chosen = selection(body,true), projectId = identifier(p),chapterId = identifier(c);
    await enforceTaskSubmissionRate(this.#rate,request);
    return safely(() => this.#tasks.submitSettings(request.actor,{ projectId,chapterId,configurationVersionId: chosen.configurationVersionId,modelId: chosen.modelId,requestId: chosen.requestId! }));
  }
  availability(request: { actor: Actor }, p: string, c: string, query: unknown) {
    const chosen = selection(query),projectId = identifier(p),chapterId = identifier(c);
    return safely(() => this.#tasks.availability(request.actor,projectId,chapterId,chosen,"settingsContent"));
  }
  list(request: { actor: Actor }, p: string, c: string, query: Record<string,unknown>) {
    if (Object.keys(query).some(key => !["limit","cursor"].includes(key))) throw new BadRequestException("分页参数无效");
    const limit = query.limit === undefined ? 20 : typeof query.limit === "string" && /^[1-9]\d?$/.test(query.limit) ? Number(query.limit) : NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new BadRequestException("分页参数无效");
    const cursor = query.cursor === undefined ? null : identifier(query.cursor),projectId = identifier(p),chapterId = identifier(c);
    return safely(() => this.#tasks.listSettings(request.actor,projectId,chapterId,{ limit,cursor }));
  }
  get(request: { actor: Actor }, id: string) {
    const taskId = identifier(id);
    return safely(async () => {
      const task = await this.#tasks.get(request.actor,taskId);
      if (task.input.stage !== "settings" || task.input.resultType !== "settingsContent") throw new ModelTaskError("TASK_NOT_FOUND");
      return task;
    });
  }
}
class SettingsTaskFilter implements ExceptionFilter<ModelTaskError | ModelSettingsError> {
  catch(error: ModelTaskError | ModelSettingsError, host: ArgumentsHost) {
    const status = ["TASK_QUEUE_FULL","TASK_EXECUTION_FULL"].includes(error.code) ? 429 : error.code === "TASK_NOT_FOUND" ? 404
      : ["FORBIDDEN","POLICY_RESTRICTED","WORKSPACE_TASK_DISABLED","TASK_PROVIDER_UNSUPPORTED"].includes(error.code) ? 403
      : ["STATE_CONFLICT","UPSTREAM_CHANGED","VERSION_CONFLICT"].includes(error.code) ? 409
      : ["INVALID_CONTEXT","INVALID_CONFIGURATION"].includes(error.code) ? 400 : 503;
    host.switchToHttp().getResponse().status(status).json({ code: error.code,message: error.code });
  }
}
Catch(ModelTaskError,ModelSettingsError)(SettingsTaskFilter);
Controller()(SettingsTaskController); UseGuards(SessionGuard)(SettingsTaskController); Inject(TASKS)(SettingsTaskController,undefined,0);
Inject(RATE)(SettingsTaskController,undefined,1);
for (const [method,decorator] of [["submit",Post("projects/:projectId/chapters/:chapterId/settings-tasks")], ["list",Get("projects/:projectId/chapters/:chapterId/settings-tasks")], ["availability",Get("projects/:projectId/chapters/:chapterId/settings-tasks/availability")], ["get",Get("settings-tasks/:id")]] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(SettingsTaskController.prototype,method)!;
  decorator(SettingsTaskController.prototype,method,descriptor); Header("Cache-Control","no-store")(SettingsTaskController.prototype,method,descriptor); Req()(SettingsTaskController.prototype,method,0);
  if (method === "get") Param("id")(SettingsTaskController.prototype,method,1);
  else {
    Param("projectId")(SettingsTaskController.prototype,method,1); Param("chapterId")(SettingsTaskController.prototype,method,2);
    if (method === "submit") Body()(SettingsTaskController.prototype,method,3); else Query()(SettingsTaskController.prototype,method,3);
  }
}
/** Optional authenticated boundary only; requires SettingsTaskContext and never exposes a run endpoint. */
export class SettingsTaskApiModule {
  static register(services: { sessionVerifier: SessionVerifier; tasks: ModelTaskService; rateLimiter?: ModelRateLimiter }): DynamicModule {
    return { module: SettingsTaskApiModule,providers: [{ provide: SESSION_VERIFIER,useValue: services.sessionVerifier },{ provide: TASKS,useValue: services.tasks },{ provide: RATE,useValue: services.rateLimiter ?? null }] };
  }
}
Module({ controllers: [SettingsTaskController],providers: [SessionGuard,{ provide: APP_FILTER,useClass: SettingsTaskFilter }] })(SettingsTaskApiModule);
