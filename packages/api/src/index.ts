import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import {
  BadRequestException,
  Body,
  Catch,
  Controller,
  Get,
  Header,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { ArgumentsHost, CanActivate, DynamicModule, ExceptionFilter, ExecutionContext } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";

import { IdentityError } from "@novel-adaptation/identity";
import type { Actor, IdentityService, SessionVerifier } from "@novel-adaptation/identity";
import { IdentityProviderError } from "@novel-adaptation/identity/providers";
import { ProjectImportError } from "@novel-adaptation/project-import";
import type { CreateProjectInput, DocumentInput, ProjectImportService, TextImportInput } from "@novel-adaptation/project-import";
import { StoryKnowledgeError } from "@novel-adaptation/story-knowledge";
import type { StoryKnowledgeService } from "@novel-adaptation/story-knowledge";

export const SESSION_VERIFIER = Symbol("SESSION_VERIFIER");
export const PROJECT_IMPORT = Symbol("PROJECT_IMPORT");
export const IDENTITY_SERVICE = Symbol("IDENTITY_SERVICE");
export const WECHAT_REDIRECT_URI = Symbol("WECHAT_REDIRECT_URI");
export const DEVICE_TOKENS = Symbol("DEVICE_TOKENS");
export const CLIENT_IP_RESOLVER = Symbol("CLIENT_IP_RESOLVER");
export const STORY_KNOWLEDGE = Symbol("STORY_KNOWLEDGE");

export interface DeviceTokenService {
  issue(): string;
  verify(token: string): string | null;
}

export class HmacDeviceTokenService implements DeviceTokenService {
  readonly #secret: string;

  constructor(secret: string) {
    if (Buffer.byteLength(secret) < 32) throw new Error("Device token secret must be at least 32 bytes");
    this.#secret = secret;
  }

  issue(): string {
    const id = randomBytes(24).toString("base64url");
    return `v1.${id}.${this.sign(id)}`;
  }

  verify(token: string): string | null {
    const [version, id, signature, extra] = token.split(".");
    if (version !== "v1" || !id || !signature || extra) return null;
    const expected = Buffer.from(this.sign(id));
    const actual = Buffer.from(signature);
    return actual.length === expected.length && timingSafeEqual(actual, expected) ? id : null;
  }

  private sign(id: string): string {
    return createHmac("sha256", this.#secret).update(`v1.${id}`).digest("base64url");
  }
}

export interface ClientIpResolver {
  resolve(request: AuthenticatedRequest): string;
}

export class ForwardedClientIpResolver implements ClientIpResolver {
  readonly #trustedProxyHops: number;

  constructor(trustedProxyHops: number) {
    if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 0 || trustedProxyHops > 10) {
      throw new Error("Trusted proxy hops must be an integer between 0 and 10");
    }
    this.#trustedProxyHops = trustedProxyHops;
  }

  resolve(request: AuthenticatedRequest): string {
    const remote = normalizeIp(request.socket?.remoteAddress ?? request.ip);
    if (this.#trustedProxyHops === 0) return remote;
    const forwarded = request.headers["x-forwarded-for"];
    const values = typeof forwarded === "string" ? forwarded.split(",").map((value) => normalizeIp(value.trim())) : [];
    return values[Math.max(0, values.length - this.#trustedProxyHops)] ?? remote;
  }
}

type AuthenticatedRequest = {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
  actor?: Actor;
};

type DocumentRequest =
  | { kind: "paste"; fileName: string; text: string }
  | { kind: "txt"; fileName: string; contentBase64: string; encoding?: string }
  | { kind: "docx"; fileName: string; contentBase64: string };

export class SessionGuard implements CanActivate {
  private readonly sessions: SessionVerifier;

  constructor(sessions: SessionVerifier) { this.sessions = sessions; }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const match = typeof authorization === "string" ? /^Bearer ([^\s]+)$/.exec(authorization) : null;
    if (!match) throw new UnauthorizedException("登录状态无效或已过期");
    try {
      request.actor = await this.sessions.verify(match[1]!);
      return true;
    } catch {
      throw new UnauthorizedException("登录状态无效或已过期");
    }
  }
}

export class ProjectImportExceptionFilter implements ExceptionFilter<ProjectImportError> {
  catch(error: ProjectImportError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{ status(code: number): { json(body: object): void } }>();
    response.status(statusFor(error.code)).json({
      code: error.code,
      message: error.message,
      ...(error.providerRequestId ? { providerRequestId: error.providerRequestId } : {}),
    });
  }
}

Catch(ProjectImportError)(ProjectImportExceptionFilter);

export class StoryKnowledgeExceptionFilter implements ExceptionFilter<StoryKnowledgeError> {
  catch(error: StoryKnowledgeError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{ status(code: number): { json(body: object): void } }>();
    response.status(storyKnowledgeStatusFor(error.code)).json({ code: error.code, message: error.message });
  }
}

Catch(StoryKnowledgeError)(StoryKnowledgeExceptionFilter);

export class IdentityExceptionFilter implements ExceptionFilter<IdentityError> {
  catch(error: IdentityError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status(code: number): { json(body: object): void };
      setHeader(name: string, value: string): void;
    }>();
    if (error.retryAfterSeconds !== undefined) response.setHeader("retry-after", String(error.retryAfterSeconds));
    response.status(identityStatusFor(error.code)).json({ code: error.code, message: error.message });
  }
}

Catch(IdentityError)(IdentityExceptionFilter);

export class IdentityProviderExceptionFilter implements ExceptionFilter<IdentityProviderError> {
  catch(_error: IdentityProviderError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{ status(code: number): { json(body: object): void } }>();
    response.status(503).json({
      code: "IDENTITY_PROVIDER_UNAVAILABLE",
      message: "登录服务暂不可用，请稍后重试",
    });
  }
}

Catch(IdentityProviderError)(IdentityProviderExceptionFilter);

function identityStatusFor(code: IdentityError["code"]): number {
  if (code === "RATE_LIMITED") return 429;
  if (code === "INVALID_OR_EXPIRED_CODE" || code === "INVALID_OAUTH_STATE") return 401;
  if (code === "ACCOUNT_NOT_FOUND") return 404;
  if (code === "IDENTITY_ALREADY_BOUND") return 409;
  return 422;
}

function statusFor(code: ProjectImportError["code"]): number {
  if (code === "PROJECT_NOT_FOUND" || code === "CHAPTER_NOT_FOUND" || code === "IMPORTED_DOCUMENT_NOT_FOUND") return 404;
  if (code === "PROJECT_WRITE_FORBIDDEN") return 403;
  if (code === "CHAPTER_TOO_LARGE") return 413;
  if (code === "COMPLIANCE_UNAVAILABLE" || code === "DOCX_EXTRACTOR_UNAVAILABLE") return 503;
  return 422;
}

function storyKnowledgeStatusFor(code: StoryKnowledgeError["code"]): number {
  if (code === "STAGE_RESULT_NOT_FOUND" || code === "SOURCE_VERSION_NOT_FOUND" || code === "FACT_NOT_FOUND") return 404;
  if (code === "FORBIDDEN") return 403;
  if (code === "VERSION_CONFLICT") return 409;
  return 422;
}

export class ProjectController {
  private readonly projects: ProjectImportService;

  constructor(projects: ProjectImportService) { this.projects = projects; }

  create(request: AuthenticatedRequest, body: CreateProjectInput) {
    return this.projects.createProject(request.actor!, projectInputFrom(body));
  }

  inspect(request: AuthenticatedRequest, projectId: string, body: DocumentRequest) {
    return this.projects.inspectDocument(request.actor!, projectId, documentFrom(body));
  }

  importChapter(
    request: AuthenticatedRequest,
    projectId: string,
    body: { document: DocumentRequest; selectedChapterIndex: number },
  ) {
    if (!isRecord(body) || !Number.isInteger(body.selectedChapterIndex) || (body.selectedChapterIndex as number) < 0) {
      throw new BadRequestException("章节导入请求格式无效");
    }
    return this.projects.importDocument(
      request.actor!, projectId, documentFrom(body.document), body.selectedChapterIndex as number,
    );
  }

  getChapter(request: AuthenticatedRequest, projectId: string, chapterId: string) {
    return this.projects.getChapter(request.actor!, projectId, chapterId);
  }
  getChapterContext(request: AuthenticatedRequest, projectId: string, chapterId: string) {
    return this.projects.getChapterContext(request.actor!, projectId, chapterId);
  }

  getImportedDocument(request: AuthenticatedRequest, projectId: string, documentId: string) {
    return this.projects.getImportedDocument(request.actor!, projectId, documentId);
  }

  importPendingChapter(
    request: AuthenticatedRequest,
    projectId: string,
    documentId: string,
    body: unknown,
  ) {
    if (!isRecord(body) || !Number.isInteger(body.chapterIndex) || (body.chapterIndex as number) < 0) {
      throw new BadRequestException("待处理章节请求格式无效");
    }
    return this.projects.importPendingChapter(request.actor!, projectId, documentId, body.chapterIndex as number);
  }

  reimportChapter(
    request: AuthenticatedRequest,
    projectId: string,
    chapterId: string,
    body: TextImportInput,
  ) {
    return this.projects.reimportText(request.actor!, projectId, chapterId, textImportFrom(body));
  }
}

export class AuthController {
  private readonly identity: IdentityService;
  private readonly wechatRedirectUri: string;
  private readonly deviceTokens: DeviceTokenService;
  private readonly clientIps: ClientIpResolver;

  constructor(identity: IdentityService, wechatRedirectUri: string, deviceTokens: DeviceTokenService, clientIps: ClientIpResolver) {
    this.identity = identity;
    this.wechatRedirectUri = wechatRedirectUri;
    this.deviceTokens = deviceTokens;
    this.clientIps = clientIps;
  }

  issueDeviceToken() {
    return { deviceToken: this.deviceTokens.issue() };
  }

  requestPhoneCode(request: AuthenticatedRequest, body: unknown) {
    const input = phoneChallengeFrom(this.deviceTokens, this.clientIps, request, body);
    return this.identity.requestPhoneCode(input);
  }

  verifyPhoneCode(request: AuthenticatedRequest, body: unknown) {
    const input = phoneVerificationFrom(this.deviceTokens, this.clientIps, request, body);
    return this.identity.verifyPhoneCode(input);
  }

  startWechatLogin() {
    return this.identity.beginWechatLogin({ redirectUri: this.wechatRedirectUri });
  }

  completeWechatLogin(query: unknown) {
    const input = oauthCallbackFrom(query);
    return this.identity.completeWechatCallback({ ...input, redirectUri: this.wechatRedirectUri });
  }

  startWechatBinding(request: AuthenticatedRequest) {
    return this.identity.beginWechatBinding(request.actor!);
  }

}

export class StoryKnowledgeController {
  private readonly storyKnowledge: StoryKnowledgeService;

  constructor(storyKnowledge: StoryKnowledgeService) {
    this.storyKnowledge = storyKnowledge;
  }

  getActive(request: AuthenticatedRequest, projectId: string, chapterId: string) {
    return this.service().getActive(request.actor!, projectId, chapterId);
  }

  getVersion(request: AuthenticatedRequest, projectId: string, chapterId: string, versionId: string) {
    return this.service().getVersion(request.actor!, projectId, chapterId, versionId);
  }

  async getRetryableScopes(request: AuthenticatedRequest, projectId: string, chapterId: string) {
    return { scopeKeys: await this.service().getRetryableScopes(request.actor!, projectId, chapterId) };
  }

  getConfirmedStoryBible(request: AuthenticatedRequest, projectId: string, chapterId: string) {
    return this.service().getConfirmedStoryBible(request.actor!, projectId, chapterId);
  }

  resolveFact(request: AuthenticatedRequest, projectId: string, chapterId: string, factId: string, body: unknown) {
    return this.service().resolveFact(request.actor!, projectId, chapterId, factCommand(body, factId));
  }

  editFact(request: AuthenticatedRequest, projectId: string, chapterId: string, factId: string, body: unknown) {
    return this.service().editFact(request.actor!, projectId, chapterId, factCommand(body, factId));
  }

  reviewFact(request: AuthenticatedRequest, projectId: string, chapterId: string, factId: string, body: unknown) {
    return this.service().reviewFact(request.actor!, projectId, chapterId, factCommand(body, factId));
  }

  retry(request: AuthenticatedRequest, projectId: string, chapterId: string, body: unknown) {
    return this.service().recordRetry(request.actor!, projectId, chapterId, body);
  }

  confirm(request: AuthenticatedRequest, projectId: string, chapterId: string, body: unknown) {
    return this.service().confirmStage(request.actor!, projectId, chapterId, body);
  }

  setFactLock(request: AuthenticatedRequest, projectId: string, chapterId: string, factId: string, body: unknown) {
    return this.service().setFactLock(request.actor!, projectId, chapterId, factCommand(body, factId));
  }

  private service(): StoryKnowledgeService {
    return this.storyKnowledge;
  }
}

function factCommand(body: unknown, factId: string): Record<string, unknown> {
  return { ...(isRecord(body) ? body : {}), factId };
}

function phoneChallengeFrom(deviceTokens: DeviceTokenService, clientIps: ClientIpResolver, request: AuthenticatedRequest, value: unknown) {
  if (!isRecord(value) || typeof value.phone !== "string") throw new BadRequestException("手机号请求格式无效");
  return { phone: value.phone, ipAddress: clientIps.resolve(request), deviceId: deviceId(deviceTokens, request) };
}

function phoneVerificationFrom(deviceTokens: DeviceTokenService, clientIps: ClientIpResolver, request: AuthenticatedRequest, value: unknown) {
  if (!isRecord(value) || typeof value.challengeId !== "string" || typeof value.phone !== "string"
    || typeof value.code !== "string") throw new BadRequestException("验证码请求格式无效");
  return {
    challengeId: value.challengeId,
    phone: value.phone,
    code: value.code,
    ipAddress: clientIps.resolve(request),
    deviceId: deviceId(deviceTokens, request),
  };
}

function oauthCallbackFrom(value: unknown): { code: string; state: string } {
  if (!isRecord(value) || typeof value.code !== "string" || typeof value.state !== "string"
    || !value.code || !value.state) throw new BadRequestException("微信回调参数无效");
  return { code: value.code, state: value.state };
}

function deviceId(deviceTokens: DeviceTokenService, request: AuthenticatedRequest): string {
  const value = request.headers["x-device-token"];
  const id = typeof value === "string" && value.length <= 300 ? deviceTokens.verify(value) : null;
  if (!id) {
    throw new BadRequestException("缺少有效的设备标识");
  }
  return id;
}

function normalizeIp(value: string | undefined): string {
  const normalized = value?.startsWith("::ffff:") ? value.slice(7) : value;
  if (!normalized || isIP(normalized) === 0) throw new BadRequestException("客户端 IP 地址无效");
  return normalized;
}

function projectInputFrom(value: unknown): CreateProjectInput {
  if (!isRecord(value) || typeof value.title !== "string" || typeof value.rightsDeclared !== "boolean"
    || (value.aspectRatio !== "9:16" && value.aspectRatio !== "16:9")
    || (value.targetDurationSeconds !== 60 && value.targetDurationSeconds !== 180 && value.targetDurationSeconds !== 300)
    || (value.narrativeMode !== "narration" && value.narrativeMode !== "dialogue")) {
    throw new BadRequestException("项目创建请求格式无效");
  }
  return {
    title: value.title,
    rightsDeclared: value.rightsDeclared,
    aspectRatio: value.aspectRatio,
    targetDurationSeconds: value.targetDurationSeconds,
    narrativeMode: value.narrativeMode,
  };
}

function documentFrom(input: DocumentRequest): DocumentInput {
  if (!isRecord(input) || typeof input.kind !== "string" || typeof input.fileName !== "string") {
    throw new BadRequestException("文档请求格式无效");
  }
  if (input.kind === "paste") {
    if (typeof input.text !== "string") throw new BadRequestException("文档请求格式无效");
    return { kind: "paste", fileName: input.fileName, text: input.text };
  }
  if ((input.kind !== "txt" && input.kind !== "docx") || !isStrictBase64(input.contentBase64)) {
    throw new ProjectImportError("MALFORMED_DOCUMENT", "文件内容不是有效的 Base64 数据");
  }
  const bytes = Uint8Array.from(Buffer.from(input.contentBase64, "base64"));
  return input.kind === "txt"
    ? { kind: "txt", fileName: input.fileName, bytes, ...(typeof input.encoding === "string" ? { encoding: input.encoding } : {}) }
    : { kind: "docx", fileName: input.fileName, bytes };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStrictBase64(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

function textImportFrom(value: unknown): TextImportInput {
  if (!isRecord(value) || typeof value.fileName !== "string" || typeof value.text !== "string"
    || !Number.isInteger(value.selectedChapterIndex) || (value.selectedChapterIndex as number) < 0) {
    throw new BadRequestException("重新导入请求格式无效");
  }
  return {
    fileName: value.fileName,
    text: value.text,
    selectedChapterIndex: value.selectedChapterIndex as number,
  };
}

Injectable()(SessionGuard);
Inject(SESSION_VERIFIER)(SessionGuard, undefined, 0);
Controller("projects")(ProjectController);
UseGuards(SessionGuard)(ProjectController);
Inject(PROJECT_IMPORT)(ProjectController, undefined, 0);
Post()(ProjectController.prototype, "create", Object.getOwnPropertyDescriptor(ProjectController.prototype, "create")!);
Req()(ProjectController.prototype, "create", 0);
Body()(ProjectController.prototype, "create", 1);
Post(":projectId/imports/inspect")(ProjectController.prototype, "inspect", Object.getOwnPropertyDescriptor(ProjectController.prototype, "inspect")!);
Req()(ProjectController.prototype, "inspect", 0);
Param("projectId")(ProjectController.prototype, "inspect", 1);
Body()(ProjectController.prototype, "inspect", 2);
Post(":projectId/chapters/import")(ProjectController.prototype, "importChapter", Object.getOwnPropertyDescriptor(ProjectController.prototype, "importChapter")!);
Req()(ProjectController.prototype, "importChapter", 0);
Param("projectId")(ProjectController.prototype, "importChapter", 1);
Body()(ProjectController.prototype, "importChapter", 2);
Get(":projectId/chapters/:chapterId")(ProjectController.prototype, "getChapter", Object.getOwnPropertyDescriptor(ProjectController.prototype, "getChapter")!);
Get(":projectId/chapters/:chapterId/context")(ProjectController.prototype, "getChapterContext", Object.getOwnPropertyDescriptor(ProjectController.prototype, "getChapterContext")!);
Header("Cache-Control", "no-store")(ProjectController.prototype, "getChapterContext", Object.getOwnPropertyDescriptor(ProjectController.prototype, "getChapterContext")!);
Req()(ProjectController.prototype, "getChapterContext", 0);
Param("projectId")(ProjectController.prototype, "getChapterContext", 1);
Param("chapterId")(ProjectController.prototype, "getChapterContext", 2);
Req()(ProjectController.prototype, "getChapter", 0);
Param("projectId")(ProjectController.prototype, "getChapter", 1);
Param("chapterId")(ProjectController.prototype, "getChapter", 2);
Get(":projectId/imported-documents/:documentId")(ProjectController.prototype, "getImportedDocument", Object.getOwnPropertyDescriptor(ProjectController.prototype, "getImportedDocument")!);
Req()(ProjectController.prototype, "getImportedDocument", 0);
Param("projectId")(ProjectController.prototype, "getImportedDocument", 1);
Param("documentId")(ProjectController.prototype, "getImportedDocument", 2);
Post(":projectId/imported-documents/:documentId/chapters/import")(ProjectController.prototype, "importPendingChapter", Object.getOwnPropertyDescriptor(ProjectController.prototype, "importPendingChapter")!);
Req()(ProjectController.prototype, "importPendingChapter", 0);
Param("projectId")(ProjectController.prototype, "importPendingChapter", 1);
Param("documentId")(ProjectController.prototype, "importPendingChapter", 2);
Body()(ProjectController.prototype, "importPendingChapter", 3);
Post(":projectId/chapters/:chapterId/reimport")(ProjectController.prototype, "reimportChapter", Object.getOwnPropertyDescriptor(ProjectController.prototype, "reimportChapter")!);
Req()(ProjectController.prototype, "reimportChapter", 0);
Param("projectId")(ProjectController.prototype, "reimportChapter", 1);
Param("chapterId")(ProjectController.prototype, "reimportChapter", 2);
Body()(ProjectController.prototype, "reimportChapter", 3);
Controller("projects/:projectId/chapters/:chapterId/story-knowledge")(StoryKnowledgeController);
UseGuards(SessionGuard)(StoryKnowledgeController);
Inject(STORY_KNOWLEDGE)(StoryKnowledgeController, undefined, 0);
Get()(StoryKnowledgeController.prototype, "getActive", Object.getOwnPropertyDescriptor(StoryKnowledgeController.prototype, "getActive")!);
Req()(StoryKnowledgeController.prototype, "getActive", 0);
Param("projectId")(StoryKnowledgeController.prototype, "getActive", 1);
Param("chapterId")(StoryKnowledgeController.prototype, "getActive", 2);
Get("versions/:versionId")(StoryKnowledgeController.prototype, "getVersion", Object.getOwnPropertyDescriptor(StoryKnowledgeController.prototype, "getVersion")!);
Req()(StoryKnowledgeController.prototype, "getVersion", 0);
Param("projectId")(StoryKnowledgeController.prototype, "getVersion", 1);
Param("chapterId")(StoryKnowledgeController.prototype, "getVersion", 2);
Param("versionId")(StoryKnowledgeController.prototype, "getVersion", 3);
Get("retryable-scopes")(StoryKnowledgeController.prototype, "getRetryableScopes", Object.getOwnPropertyDescriptor(StoryKnowledgeController.prototype, "getRetryableScopes")!);
Req()(StoryKnowledgeController.prototype, "getRetryableScopes", 0);
Param("projectId")(StoryKnowledgeController.prototype, "getRetryableScopes", 1);
Param("chapterId")(StoryKnowledgeController.prototype, "getRetryableScopes", 2);
Get("story-bible")(StoryKnowledgeController.prototype, "getConfirmedStoryBible", Object.getOwnPropertyDescriptor(StoryKnowledgeController.prototype, "getConfirmedStoryBible")!);
Req()(StoryKnowledgeController.prototype, "getConfirmedStoryBible", 0);
Param("projectId")(StoryKnowledgeController.prototype, "getConfirmedStoryBible", 1);
Param("chapterId")(StoryKnowledgeController.prototype, "getConfirmedStoryBible", 2);
Post("facts/:factId/resolve")(StoryKnowledgeController.prototype, "resolveFact", Object.getOwnPropertyDescriptor(StoryKnowledgeController.prototype, "resolveFact")!);
Req()(StoryKnowledgeController.prototype, "resolveFact", 0);
Param("projectId")(StoryKnowledgeController.prototype, "resolveFact", 1);
Param("chapterId")(StoryKnowledgeController.prototype, "resolveFact", 2);
Param("factId")(StoryKnowledgeController.prototype, "resolveFact", 3);
Body()(StoryKnowledgeController.prototype, "resolveFact", 4);
Post("facts/:factId/edit")(StoryKnowledgeController.prototype, "editFact", Object.getOwnPropertyDescriptor(StoryKnowledgeController.prototype, "editFact")!);
Req()(StoryKnowledgeController.prototype, "editFact", 0);
Param("projectId")(StoryKnowledgeController.prototype, "editFact", 1);
Param("chapterId")(StoryKnowledgeController.prototype, "editFact", 2);
Param("factId")(StoryKnowledgeController.prototype, "editFact", 3);
Body()(StoryKnowledgeController.prototype, "editFact", 4);
Post("facts/:factId/review")(StoryKnowledgeController.prototype, "reviewFact", Object.getOwnPropertyDescriptor(StoryKnowledgeController.prototype, "reviewFact")!);
Req()(StoryKnowledgeController.prototype, "reviewFact", 0);
Param("projectId")(StoryKnowledgeController.prototype, "reviewFact", 1);
Param("chapterId")(StoryKnowledgeController.prototype, "reviewFact", 2);
Param("factId")(StoryKnowledgeController.prototype, "reviewFact", 3);
Body()(StoryKnowledgeController.prototype, "reviewFact", 4);
Post("retries")(StoryKnowledgeController.prototype, "retry", Object.getOwnPropertyDescriptor(StoryKnowledgeController.prototype, "retry")!);
Req()(StoryKnowledgeController.prototype, "retry", 0);
Param("projectId")(StoryKnowledgeController.prototype, "retry", 1);
Param("chapterId")(StoryKnowledgeController.prototype, "retry", 2);
Body()(StoryKnowledgeController.prototype, "retry", 3);
Post("confirm")(StoryKnowledgeController.prototype, "confirm", Object.getOwnPropertyDescriptor(StoryKnowledgeController.prototype, "confirm")!);
Req()(StoryKnowledgeController.prototype, "confirm", 0);
Param("projectId")(StoryKnowledgeController.prototype, "confirm", 1);
Param("chapterId")(StoryKnowledgeController.prototype, "confirm", 2);
Body()(StoryKnowledgeController.prototype, "confirm", 3);
Post("facts/:factId/lock")(StoryKnowledgeController.prototype, "setFactLock", Object.getOwnPropertyDescriptor(StoryKnowledgeController.prototype, "setFactLock")!);
Req()(StoryKnowledgeController.prototype, "setFactLock", 0);
Param("projectId")(StoryKnowledgeController.prototype, "setFactLock", 1);
Param("chapterId")(StoryKnowledgeController.prototype, "setFactLock", 2);
Param("factId")(StoryKnowledgeController.prototype, "setFactLock", 3);
Body()(StoryKnowledgeController.prototype, "setFactLock", 4);
Controller("auth")(AuthController);
Inject(IDENTITY_SERVICE)(AuthController, undefined, 0);
Inject(WECHAT_REDIRECT_URI)(AuthController, undefined, 1);
Inject(DEVICE_TOKENS)(AuthController, undefined, 2);
Inject(CLIENT_IP_RESOLVER)(AuthController, undefined, 3);
Post("device")(AuthController.prototype, "issueDeviceToken", Object.getOwnPropertyDescriptor(AuthController.prototype, "issueDeviceToken")!);
Post("phone/challenges")(AuthController.prototype, "requestPhoneCode", Object.getOwnPropertyDescriptor(AuthController.prototype, "requestPhoneCode")!);
Req()(AuthController.prototype, "requestPhoneCode", 0);
Body()(AuthController.prototype, "requestPhoneCode", 1);
Post("phone/verify")(AuthController.prototype, "verifyPhoneCode", Object.getOwnPropertyDescriptor(AuthController.prototype, "verifyPhoneCode")!);
Req()(AuthController.prototype, "verifyPhoneCode", 0);
Body()(AuthController.prototype, "verifyPhoneCode", 1);
Post("wechat/start")(AuthController.prototype, "startWechatLogin", Object.getOwnPropertyDescriptor(AuthController.prototype, "startWechatLogin")!);
Get("wechat/callback")(AuthController.prototype, "completeWechatLogin", Object.getOwnPropertyDescriptor(AuthController.prototype, "completeWechatLogin")!);
Query()(AuthController.prototype, "completeWechatLogin", 0);
Post("wechat/bind/start")(AuthController.prototype, "startWechatBinding", Object.getOwnPropertyDescriptor(AuthController.prototype, "startWechatBinding")!);
UseGuards(SessionGuard)(AuthController.prototype, "startWechatBinding", Object.getOwnPropertyDescriptor(AuthController.prototype, "startWechatBinding")!);
Req()(AuthController.prototype, "startWechatBinding", 0);

export interface ProjectImportApiServices {
  identity: IdentityService;
  sessionVerifier: SessionVerifier;
  projectImport: ProjectImportService;
  storyKnowledge: StoryKnowledgeService;
  wechatRedirectUri: string;
  deviceTokens: DeviceTokenService;
  clientIpResolver: ClientIpResolver;
}

export class ProjectImportApiModule {
  static register(services: ProjectImportApiServices): DynamicModule {
    return {
      module: ProjectImportApiModule,
      providers: [
        { provide: SESSION_VERIFIER, useValue: services.sessionVerifier },
        { provide: PROJECT_IMPORT, useValue: services.projectImport },
        { provide: STORY_KNOWLEDGE, useValue: services.storyKnowledge },
        { provide: IDENTITY_SERVICE, useValue: services.identity },
        { provide: WECHAT_REDIRECT_URI, useValue: services.wechatRedirectUri },
        { provide: DEVICE_TOKENS, useValue: services.deviceTokens },
        { provide: CLIENT_IP_RESOLVER, useValue: services.clientIpResolver },
      ],
    };
  }
}

Module({
  controllers: [ProjectController, StoryKnowledgeController, AuthController],
  providers: [
    SessionGuard,
    { provide: APP_FILTER, useClass: ProjectImportExceptionFilter },
    { provide: APP_FILTER, useClass: StoryKnowledgeExceptionFilter },
    { provide: APP_FILTER, useClass: IdentityExceptionFilter },
    { provide: APP_FILTER, useClass: IdentityProviderExceptionFilter },
  ],
})(ProjectImportApiModule);
