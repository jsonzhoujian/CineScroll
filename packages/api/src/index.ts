import {
  BadRequestException,
  Body,
  Catch,
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { ArgumentsHost, CanActivate, ExceptionFilter, ExecutionContext } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";

import type { Actor, SessionVerifier } from "@novel-adaptation/identity";
import { ProjectImportError } from "@novel-adaptation/project-import";
import type { CreateProjectInput, DocumentInput, ProjectImportService, TextImportInput } from "@novel-adaptation/project-import";

export const SESSION_VERIFIER = Symbol("SESSION_VERIFIER");
export const PROJECT_IMPORT = Symbol("PROJECT_IMPORT");

type AuthenticatedRequest = {
  headers: Record<string, string | string[] | undefined>;
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

function statusFor(code: ProjectImportError["code"]): number {
  if (code === "PROJECT_NOT_FOUND" || code === "CHAPTER_NOT_FOUND") return 404;
  if (code === "PROJECT_WRITE_FORBIDDEN") return 403;
  if (code === "CHAPTER_TOO_LARGE") return 413;
  if (code === "COMPLIANCE_UNAVAILABLE" || code === "DOCX_EXTRACTOR_UNAVAILABLE") return 503;
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

  reimportChapter(
    request: AuthenticatedRequest,
    projectId: string,
    chapterId: string,
    body: TextImportInput,
  ) {
    return this.projects.reimportText(request.actor!, projectId, chapterId, textImportFrom(body));
  }
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
Req()(ProjectController.prototype, "getChapter", 0);
Param("projectId")(ProjectController.prototype, "getChapter", 1);
Param("chapterId")(ProjectController.prototype, "getChapter", 2);
Post(":projectId/chapters/:chapterId/reimport")(ProjectController.prototype, "reimportChapter", Object.getOwnPropertyDescriptor(ProjectController.prototype, "reimportChapter")!);
Req()(ProjectController.prototype, "reimportChapter", 0);
Param("projectId")(ProjectController.prototype, "reimportChapter", 1);
Param("chapterId")(ProjectController.prototype, "reimportChapter", 2);
Body()(ProjectController.prototype, "reimportChapter", 3);

export class ProjectImportApiModule {}

Module({
  controllers: [ProjectController],
  providers: [
    SessionGuard,
    { provide: APP_FILTER, useClass: ProjectImportExceptionFilter },
    { provide: SESSION_VERIFIER, useValue: null },
    { provide: PROJECT_IMPORT, useValue: null },
  ],
})(ProjectImportApiModule);
