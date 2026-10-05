import { BadRequestException, Body, Catch, Controller, Get, Header, Inject, Module, Post, Req, UseGuards } from "@nestjs/common";
import type { ArgumentsHost, DynamicModule, ExceptionFilter } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import type { Actor, SessionVerifier } from "@novel-adaptation/identity";
import { ModelSettingsError, type WorkspaceModelSettings } from "@novel-adaptation/script/model-settings";
import { SESSION_VERIFIER, SessionGuard } from "./index.ts";
import type { ModelRateLimiter } from "./model-rate-limit.ts";

const MODEL_SETTINGS = Symbol("MODEL_SETTINGS");
const MODEL_RATE_LIMITER = Symbol("MODEL_RATE_LIMITER");
type SessionRequest = { actor: Actor };
class ModelRateLimitError extends Error {
  readonly retryAfterSeconds: number;
  constructor(seconds: number) { super("RATE_LIMITED"); this.retryAfterSeconds = seconds; }
}
class ModelSettingsController {
  private readonly settings: WorkspaceModelSettings;
  private readonly limiter: ModelRateLimiter | null;
  constructor(settings: WorkspaceModelSettings, limiter: ModelRateLimiter | null) { this.settings = settings; this.limiter = limiter; }
  async consume(request: SessionRequest, action: "configure" | "test") {
    if (!this.limiter) throw new ModelSettingsError("STORAGE_UNAVAILABLE");
    const result = await safely(() => this.limiter!.consume(request.actor.workspaceId, action));
    if (!result.allowed) throw new ModelRateLimitError(result.retryAfterSeconds);
  }
  async get(request: SessionRequest) { return { configuration: await safely(() => this.settings.get(request.actor)) }; }
  async capabilities(request: SessionRequest) { return safely(() => this.settings.capabilities(request.actor)); }
  async configure(request: SessionRequest, body: unknown) {
    const value = object(body, ["expectedVersionId", "providerId", "apiKey"]);
    const { expectedVersionId, providerId, apiKey } = value;
    if (!(expectedVersionId === null || validString(expectedVersionId, 256)) || !validString(providerId, 64) || !validString(apiKey, 8192)) throw new BadRequestException("模型设置参数无效");
    await this.consume(request, "configure");
    return safely(() => this.settings.configure(request.actor, { expectedVersionId, providerId, apiKey }));
  }
  async testConnection(request: SessionRequest, body: unknown) {
    const value = object(body, ["expectedVersionId", "allowNonMainland"]);
    const { expectedVersionId, allowNonMainland } = value;
    if (!validString(expectedVersionId, 256) || typeof allowNonMainland !== "boolean") throw new BadRequestException("模型测试参数无效");
    await this.consume(request, "test");
    return safely(() => this.settings.testConnection(request.actor, expectedVersionId, allowNonMainland));
  }
}
function object(body: unknown, fields: string[]): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).some((key) => !fields.includes(key))) throw new BadRequestException("模型设置参数无效");
  return body as Record<string, unknown>;
}
function validString(value: unknown, limit: number): value is string { return typeof value === "string" && !!value.trim() && value.length <= limit && !/[\r\n]/.test(value); }
async function safely<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) { if (error instanceof ModelSettingsError) throw error; throw new ModelSettingsError("STORAGE_UNAVAILABLE"); }
}
class ModelSettingsFilter implements ExceptionFilter<ModelSettingsError | ModelRateLimitError> {
  catch(error: ModelSettingsError | ModelRateLimitError, host: ArgumentsHost) {
    if (error instanceof ModelRateLimitError) {
      host.switchToHttp().getResponse().setHeader("Retry-After", String(error.retryAfterSeconds));
      host.switchToHttp().getResponse().status(429).json({ code: "RATE_LIMITED", message: "RATE_LIMITED", retryAfterSeconds: error.retryAfterSeconds });
      return;
    }
    const status = error.code === "FORBIDDEN" ? 403 : error.code === "VERSION_CONFLICT" ? 409 : error.code === "INVALID_CONFIGURATION" ? 400 : 503;
    host.switchToHttp().getResponse().status(status).json({ code: error.code, message: error.code });
  }
}
Catch(ModelSettingsError, ModelRateLimitError)(ModelSettingsFilter);
Controller("workspace/model-settings")(ModelSettingsController);
UseGuards(SessionGuard)(ModelSettingsController);
Inject(MODEL_SETTINGS)(ModelSettingsController, undefined, 0);
Inject(MODEL_RATE_LIMITER)(ModelSettingsController, undefined, 1);
for (const [method, decorator] of [["get", Get()], ["capabilities", Get("capabilities")], ["configure", Post()], ["testConnection", Post("test")]] as const) {
  decorator(ModelSettingsController.prototype, method, Object.getOwnPropertyDescriptor(ModelSettingsController.prototype, method)!);
  Header("Cache-Control", "no-store")(ModelSettingsController.prototype, method, Object.getOwnPropertyDescriptor(ModelSettingsController.prototype, method)!);
  Req()(ModelSettingsController.prototype, method, 0);
  if (method === "configure" || method === "testConnection") Body()(ModelSettingsController.prototype, method, 1);
}
/** Opt-in module: production must supply authoritative workspace membership and entitlement access. */
export class ModelSettingsApiModule {
  static register(services: { sessionVerifier: SessionVerifier; settings: WorkspaceModelSettings; rateLimiter?: ModelRateLimiter }): DynamicModule {
    return { module: ModelSettingsApiModule, providers: [{ provide: SESSION_VERIFIER, useValue: services.sessionVerifier }, { provide: MODEL_SETTINGS, useValue: services.settings }, { provide: MODEL_RATE_LIMITER, useValue: services.rateLimiter ?? null }] };
  }
}
Module({ controllers: [ModelSettingsController], providers: [SessionGuard, { provide: APP_FILTER, useClass: ModelSettingsFilter }] })(ModelSettingsApiModule);
