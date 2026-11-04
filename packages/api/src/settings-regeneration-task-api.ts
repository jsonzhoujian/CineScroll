import { BadRequestException, Body, Catch, Controller, Get, Header, Inject, Module, Param, Post, Query, Req, UseGuards, type ArgumentsHost, type DynamicModule, type ExceptionFilter } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import type { Actor, SessionVerifier } from "@novel-adaptation/identity";
import { ModelSettingsError } from "@novel-adaptation/script/model-settings";
import { ModelTaskError, type ModelTaskService } from "@novel-adaptation/script/model-tasks";
import { normalizeSettingsRegenerationSelection,type SettingsRegenerationSelection } from "@novel-adaptation/script/settings-regeneration";
import { SESSION_VERIFIER, SessionGuard } from "./index.ts";
import type { ModelRateLimiter } from "./model-rate-limit.ts";
import { enforceTaskSubmissionRate, type TaskSubmissionRequest } from "./task-submission-rate.ts";

const TASKS = Symbol("SETTINGS_REGENERATION_TASKS");
const RATE = Symbol("SETTINGS_REGENERATION_TASK_RATE");
function identifier(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\r\n]/.test(value)) throw new BadRequestException("局部重生任务参数无效");
  return value;
}
function selection(body: unknown, submission = false) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !(submission ? ["configurationVersionId","modelId","requestId","selection"] : ["configurationVersionId","modelId","selection"]).includes(key))) throw new BadRequestException("局部重生任务参数无效");
  const value = body as Record<string,unknown>;
  let selected: SettingsRegenerationSelection;
  try { selected = normalizeSettingsRegenerationSelection(value.selection as SettingsRegenerationSelection); } catch { throw new BadRequestException("局部重生选择无效"); }
  return { selection: selected,configurationVersionId: identifier(value.configurationVersionId),modelId: identifier(value.modelId),...(submission ? { requestId: identifier(value.requestId) } : {}) };
}
async function safely<T>(action: () => Promise<T>) {
  try { return await action(); } catch (error) {
    if (error instanceof ModelTaskError || error instanceof ModelSettingsError) throw error;
    throw new ModelTaskError("STORAGE_UNAVAILABLE");
  }
}
class SettingsRegenerationTaskController {
  readonly #tasks: ModelTaskService;
  readonly #rate: ModelRateLimiter | null;
  constructor(tasks: ModelTaskService, rate: ModelRateLimiter | null) { this.#tasks = tasks; this.#rate = rate; }
  async submit(request: TaskSubmissionRequest, p: string, c: string, body: unknown) {
    const chosen = selection(body,true), projectId = identifier(p),chapterId = identifier(c);
    await enforceTaskSubmissionRate(this.#rate,request);
    return safely(() => this.#tasks.submitSettingsRegeneration(request.actor,{ projectId,chapterId,configurationVersionId: chosen.configurationVersionId,modelId: chosen.modelId,requestId: chosen.requestId!,selection: chosen.selection }));
  }
  availability(request: { actor: Actor }, p: string, c: string, query: unknown) {
    const chosen = selection(query),projectId = identifier(p),chapterId = identifier(c);
    return safely(() => this.#tasks.settingsRegenerationAvailability(request.actor,projectId,chapterId,chosen));
  }
  list(request: { actor: Actor }, p: string, c: string, query: Record<string,unknown>) {
    if (Object.keys(query).some(key => !["limit","cursor"].includes(key))) throw new BadRequestException("分页参数无效");
    const limit = query.limit === undefined ? 20 : typeof query.limit === "string" && /^[1-9]\d?$/.test(query.limit) ? Number(query.limit) : NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new BadRequestException("分页参数无效");
    const cursor = query.cursor === undefined ? null : identifier(query.cursor),projectId = identifier(p),chapterId = identifier(c);
    return safely(() => this.#tasks.listSettingsRegeneration(request.actor,projectId,chapterId,{ limit,cursor }));
  }
  submission(request: { actor: Actor },p: string,c: string,id: string) {
    const projectId = identifier(p),chapterId = identifier(c),requestId = identifier(id);
    return safely(() => this.#tasks.findSettingsRegenerationSubmission(request.actor,projectId,chapterId,requestId));
  }
  get(request: { actor: Actor }, id: string) {
    const taskId = identifier(id);
    return safely(async () => {
      const task = await this.#tasks.get(request.actor,taskId);
      if (task.input.stage !== "settings" || task.input.resultType !== "settingsRegeneration") throw new ModelTaskError("TASK_NOT_FOUND");
      return task;
    });
  }
}
class SettingsRegenerationTaskFilter implements ExceptionFilter<ModelTaskError | ModelSettingsError> {
  catch(error: ModelTaskError | ModelSettingsError, host: ArgumentsHost) {
    const status = ["TASK_QUEUE_FULL","TASK_EXECUTION_FULL"].includes(error.code) ? 429 : error.code === "TASK_NOT_FOUND" ? 404
      : ["FORBIDDEN","POLICY_RESTRICTED","WORKSPACE_TASK_DISABLED","TASK_PROVIDER_UNSUPPORTED"].includes(error.code) ? 403
      : ["STATE_CONFLICT","UPSTREAM_CHANGED","VERSION_CONFLICT"].includes(error.code) ? 409
      : ["INVALID_CONTEXT","INVALID_CONFIGURATION"].includes(error.code) ? 400 : 503;
    host.switchToHttp().getResponse().status(status).json({ code: error.code,message: error.code });
  }
}
Catch(ModelTaskError,ModelSettingsError)(SettingsRegenerationTaskFilter);
Controller()(SettingsRegenerationTaskController); UseGuards(SessionGuard)(SettingsRegenerationTaskController); Inject(TASKS)(SettingsRegenerationTaskController,undefined,0);
Inject(RATE)(SettingsRegenerationTaskController,undefined,1);
for (const [method,decorator] of [["submit",Post("projects/:projectId/chapters/:chapterId/settings-regeneration-tasks")], ["list",Get("projects/:projectId/chapters/:chapterId/settings-regeneration-tasks")], ["availability",Post("projects/:projectId/chapters/:chapterId/settings-regeneration-tasks/availability")], ["submission",Get("projects/:projectId/chapters/:chapterId/settings-regeneration-tasks/submissions/:requestId")], ["get",Get("settings-regeneration-tasks/:id")]] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(SettingsRegenerationTaskController.prototype,method)!;
  decorator(SettingsRegenerationTaskController.prototype,method,descriptor); Header("Cache-Control","no-store")(SettingsRegenerationTaskController.prototype,method,descriptor); Req()(SettingsRegenerationTaskController.prototype,method,0);
  if (method === "get") Param("id")(SettingsRegenerationTaskController.prototype,method,1);
  else {
    Param("projectId")(SettingsRegenerationTaskController.prototype,method,1); Param("chapterId")(SettingsRegenerationTaskController.prototype,method,2);
    if (method === "submission") Param("requestId")(SettingsRegenerationTaskController.prototype,method,3);
    else if (method === "submit" || method === "availability") Body()(SettingsRegenerationTaskController.prototype,method,3); else Query()(SettingsRegenerationTaskController.prototype,method,3);
  }
}
/** Optional authenticated boundary only; requires SettingsRegenerationTaskContext and never exposes a run endpoint. */
export class SettingsRegenerationTaskApiModule {
  static register(services: { sessionVerifier: SessionVerifier; tasks: ModelTaskService; rateLimiter?: ModelRateLimiter }): DynamicModule {
    return { module: SettingsRegenerationTaskApiModule,providers: [{ provide: SESSION_VERIFIER,useValue: services.sessionVerifier },{ provide: TASKS,useValue: services.tasks },{ provide: RATE,useValue: services.rateLimiter ?? null }] };
  }
}
Module({ controllers: [SettingsRegenerationTaskController],providers: [SessionGuard,{ provide: APP_FILTER,useClass: SettingsRegenerationTaskFilter }] })(SettingsRegenerationTaskApiModule);
