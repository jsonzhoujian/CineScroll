import { BadRequestException, Body, Catch, Controller, Get, Header, Inject, Module, Post, Req, UseGuards } from "@nestjs/common";
import type { ArgumentsHost, DynamicModule, ExceptionFilter } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import type { Actor, SessionVerifier } from "@novel-adaptation/identity";
import { ModelSettingsError, type WorkspaceModelSettings } from "@novel-adaptation/script/model-settings";
import { SESSION_VERIFIER, SessionGuard } from "./index.ts";

const MODEL_SETTINGS = Symbol("MODEL_SETTINGS");
type SessionRequest = { actor: Actor };
class ModelSettingsController {
  private readonly settings: WorkspaceModelSettings;
  constructor(settings: WorkspaceModelSettings) { this.settings = settings; }
  async get(request: SessionRequest) { return { configuration: await safely(() => this.settings.get(request.actor)) }; }
  async configure(request: SessionRequest, body: unknown) {
    const value = object(body, ["expectedVersionId", "providerId", "apiKey"]);
    const { expectedVersionId, providerId, apiKey } = value;
    if (!(expectedVersionId === null || validString(expectedVersionId, 256)) || !validString(providerId, 64) || !validString(apiKey, 8192)) throw new BadRequestException("模型设置参数无效");
    return safely(() => this.settings.configure(request.actor, { expectedVersionId, providerId, apiKey }));
  }
  async testConnection(request: SessionRequest, body: unknown) {
    const value = object(body, ["expectedVersionId", "allowNonMainland"]);
    const { expectedVersionId, allowNonMainland } = value;
    if (!validString(expectedVersionId, 256) || typeof allowNonMainland !== "boolean") throw new BadRequestException("模型测试参数无效");
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
class ModelSettingsFilter implements ExceptionFilter<ModelSettingsError> {
  catch(error: ModelSettingsError, host: ArgumentsHost) {
    const status = error.code === "FORBIDDEN" ? 403 : error.code === "VERSION_CONFLICT" ? 409 : error.code === "INVALID_CONFIGURATION" ? 400 : 503;
    host.switchToHttp().getResponse().status(status).json({ code: error.code, message: error.code });
  }
}
Catch(ModelSettingsError)(ModelSettingsFilter);
Controller("workspace/model-settings")(ModelSettingsController);
UseGuards(SessionGuard)(ModelSettingsController);
Inject(MODEL_SETTINGS)(ModelSettingsController, undefined, 0);
for (const [method, decorator] of [["get", Get()], ["configure", Post()], ["testConnection", Post("test")]] as const) {
  decorator(ModelSettingsController.prototype, method, Object.getOwnPropertyDescriptor(ModelSettingsController.prototype, method)!);
  Header("Cache-Control", "no-store")(ModelSettingsController.prototype, method, Object.getOwnPropertyDescriptor(ModelSettingsController.prototype, method)!);
  Req()(ModelSettingsController.prototype, method, 0);
  if (method !== "get") Body()(ModelSettingsController.prototype, method, 1);
}
/** Opt-in module: production must supply authoritative workspace membership and entitlement access. */
export class ModelSettingsApiModule {
  static register(services: { sessionVerifier: SessionVerifier; settings: WorkspaceModelSettings }): DynamicModule {
    return { module: ModelSettingsApiModule, providers: [{ provide: SESSION_VERIFIER, useValue: services.sessionVerifier }, { provide: MODEL_SETTINGS, useValue: services.settings }] };
  }
}
Module({ controllers: [ModelSettingsController], providers: [SessionGuard, { provide: APP_FILTER, useClass: ModelSettingsFilter }] })(ModelSettingsApiModule);
