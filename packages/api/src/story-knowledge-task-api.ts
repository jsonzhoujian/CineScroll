import { BadRequestException, Body, Catch, Controller, Get, Header, Inject, Module, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { ArgumentsHost, DynamicModule, ExceptionFilter } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import type { Actor, SessionVerifier } from "@novel-adaptation/identity";
import { ModelSettingsError } from "@novel-adaptation/script/model-settings";
import { ModelTaskError, type ModelTaskService } from "@novel-adaptation/script/model-tasks";
import { SESSION_VERIFIER, SessionGuard } from "./index.ts";

const TASKS = Symbol("STORY_KNOWLEDGE_TASKS");
type SessionRequest = { actor: Actor };
function identifier(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\r\n]/.test(value)) throw new BadRequestException("任务参数无效");
  return value;
}
function selection(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["configurationVersionId", "modelId"].includes(key))) throw new BadRequestException("任务参数无效");
  const value = body as Record<string, unknown>;
  return { configurationVersionId: identifier(value.configurationVersionId), modelId: identifier(value.modelId) };
}
async function safely<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) {
    if (error instanceof ModelTaskError || error instanceof ModelSettingsError) throw error;
    throw new ModelTaskError("STORAGE_UNAVAILABLE");
  }
}
class StoryKnowledgeTaskController {
  private readonly tasks: ModelTaskService;
  constructor(tasks: ModelTaskService) { this.tasks = tasks; }
  async submit(request: SessionRequest, projectId: string, chapterId: string, body: unknown) {
    const chosen = selection(body);
    const input = { projectId: identifier(projectId), chapterId: identifier(chapterId), ...chosen };
    return safely(() => this.tasks.submit(request.actor, input));
  }
  async get(request: SessionRequest, id: string) {
    const taskId = identifier(id);
    return safely(async () => {
      const task = await this.tasks.get(request.actor, taskId);
      if (task.input.stage !== "story_knowledge") throw new ModelTaskError("TASK_NOT_FOUND");
      return task;
    });
  }
  async resubmit(request: SessionRequest, id: string, body: unknown) {
    const chosen = selection(body);
    await this.get(request, id);
    return safely(() => this.tasks.resubmit(request.actor, id, chosen));
  }
}
class TaskFilter implements ExceptionFilter<ModelTaskError | ModelSettingsError> {
  catch(error: ModelTaskError | ModelSettingsError, host: ArgumentsHost) {
    const status = error.code === "TASK_NOT_FOUND" ? 404 : error.code === "FORBIDDEN" ? 403 :
      ["STATE_CONFLICT", "UPSTREAM_CHANGED", "VERSION_CONFLICT"].includes(error.code) ? 409 :
      ["INVALID_CONTEXT", "INVALID_CONFIGURATION"].includes(error.code) ? 400 : 503;
    host.switchToHttp().getResponse().status(status).json({ code: error.code, message: error.code });
  }
}
Catch(ModelTaskError, ModelSettingsError)(TaskFilter);
Controller()(StoryKnowledgeTaskController);
UseGuards(SessionGuard)(StoryKnowledgeTaskController);
Inject(TASKS)(StoryKnowledgeTaskController, undefined, 0);
for (const [method, decorator] of [["submit", Post("projects/:projectId/chapters/:chapterId/story-knowledge-tasks")], ["get", Get("story-knowledge-tasks/:id")], ["resubmit", Post("story-knowledge-tasks/:id/resubmit")]] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(StoryKnowledgeTaskController.prototype, method)!;
  decorator(StoryKnowledgeTaskController.prototype, method, descriptor);
  Header("Cache-Control", "no-store")(StoryKnowledgeTaskController.prototype, method, descriptor);
  Req()(StoryKnowledgeTaskController.prototype, method, 0);
  if (method === "submit") {
    Param("projectId")(StoryKnowledgeTaskController.prototype, method, 1);
    Param("chapterId")(StoryKnowledgeTaskController.prototype, method, 2);
    Body()(StoryKnowledgeTaskController.prototype, method, 3);
  } else {
    Param("id")(StoryKnowledgeTaskController.prototype, method, 1);
    if (method === "resubmit") Body()(StoryKnowledgeTaskController.prototype, method, 2);
  }
}
/** Opt-in only. Supply a service using StoryKnowledgeTaskContext; no dispatcher or public run route. */
export class StoryKnowledgeTaskApiModule {
  static register(services: { sessionVerifier: SessionVerifier; tasks: ModelTaskService }): DynamicModule {
    return { module: StoryKnowledgeTaskApiModule, providers: [{ provide: SESSION_VERIFIER, useValue: services.sessionVerifier }, { provide: TASKS, useValue: services.tasks }] };
  }
}
Module({ controllers: [StoryKnowledgeTaskController], providers: [SessionGuard, { provide: APP_FILTER, useClass: TaskFilter }] })(StoryKnowledgeTaskApiModule);
