import { BadRequestException, Body, Controller, Get, Header, HttpException, Inject, Module, Param, Post, Req, UseGuards, type DynamicModule } from "@nestjs/common";
import type { Actor, SessionVerifier } from "@novel-adaptation/identity";
import type { PostgresProjectImportRepository } from "@novel-adaptation/project-import/postgres-repository";
import { SESSION_VERIFIER, SessionGuard } from "./index.ts";

const INVITATIONS = Symbol("PROJECT_INVITATIONS");
type Invitations = Pick<PostgresProjectImportRepository,"issueInvitation" | "acceptInvitation" | "listProjectChapters" | "listMemberProjects">;

function identifier(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\r\n\0]/.test(value)) throw new BadRequestException();
  return value;
}

async function respond<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HttpException) throw error;
    const sqlstate = typeof error === "object" && error !== null && "code" in error ? error.code : null;
    if (sqlstate === "42501") throw new HttpException({ code: "FORBIDDEN" },403);
    if (sqlstate === "P7101") throw new HttpException({ code: "NOT_FOUND" },404);
    if (sqlstate === "P7102") throw new HttpException({ code: "STATE_CONFLICT" },409);
    throw new HttpException({ code: "STORAGE_UNAVAILABLE" },503);
  }
}

class ProjectInvitationsController {
  private readonly invitations: Invitations;
  constructor(invitations: Invitations) { this.invitations = invitations; }

  issue(req: { actor: Actor }, project: string, input: unknown) {
    const projectId = identifier(project);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 2) throw new BadRequestException();
    const { recipientUserId,role } = input as Record<string,unknown>;
    if (role !== "editor" && role !== "reviewer") throw new BadRequestException();
    const recipient = identifier(recipientUserId);
    return respond(() => this.invitations.issueInvitation(req.actor,projectId,recipient,role));
  }

  projects(req: { actor: Actor }) {
    return respond(async () => ({ projects: await this.invitations.listMemberProjects(req.actor) }));
  }

  chapters(req: { actor: Actor },project: string) {
    const projectId = identifier(project);
    return respond(async () => {
      const chapters = await this.invitations.listProjectChapters(req.actor,projectId);
      if (!chapters) throw new HttpException({ code: "NOT_FOUND" },404);
      return { projectId,chapters };
    });
  }

  accept(req: { actor: Actor }, invitationId: string) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(invitationId)) throw new BadRequestException();
    return respond(() => this.invitations.acceptInvitation(req.actor,invitationId));
  }
}
Controller()(ProjectInvitationsController);
UseGuards(SessionGuard)(ProjectInvitationsController);
Inject(INVITATIONS)(ProjectInvitationsController,undefined,0);
for (const [method,path,param,route] of [
  ["projects","projects",null,Get],
  ["chapters","projects/:projectId/chapter-directory","projectId",Get],
  ["issue","projects/:projectId/invitations","projectId",Post],
  ["accept","project-invitations/:invitationId/accept","invitationId",Post],
] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(ProjectInvitationsController.prototype,method)!;
  route(path)(ProjectInvitationsController.prototype,method,descriptor);
  Header("Cache-Control","no-store")(ProjectInvitationsController.prototype,method,descriptor);
  Req()(ProjectInvitationsController.prototype,method,0);
  if (param) Param(param)(ProjectInvitationsController.prototype,method,1);
  if (method === "issue") Body()(ProjectInvitationsController.prototype,method,2);
}

export class ProjectInvitationsApiModule {
  static register(sessionVerifier: SessionVerifier,invitations: Invitations): DynamicModule {
    return { module: ProjectInvitationsApiModule,providers: [
      { provide: SESSION_VERIFIER,useValue: sessionVerifier },{ provide: INVITATIONS,useValue: invitations },
    ] };
  }
}
Module({ controllers: [ProjectInvitationsController],providers: [SessionGuard] })(ProjectInvitationsApiModule);
