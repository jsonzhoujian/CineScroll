import { BadRequestException, Body, Controller, Get, Header, HttpException, Inject, Module, Param, Post, Req, UseGuards, type DynamicModule } from "@nestjs/common";
import type { Actor, SessionIssuer, SessionVerifier } from "@novel-adaptation/identity";
import type { PostgresProjectImportRepository } from "@novel-adaptation/project-import/postgres-repository";
import { SESSION_VERIFIER, SessionGuard } from "./index.ts";

const INVITATIONS = Symbol("PROJECT_INVITATIONS");
type Invitations = Pick<PostgresProjectImportRepository,"issueInvitation" | "acceptInvitation" | "listProjectChapters" | "listMemberProjects" | "listAccountWorkspaces" | "listProjectMembers" | "changeProjectMember" | "listPendingInvitations" | "revokePendingInvitation" | "listReceivedInvitations">;

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

const SESSION_ISSUER = Symbol("WORKSPACE_SESSION_ISSUER");

class ProjectInvitationsController {
  private readonly invitations: Invitations;
  private readonly sessions: SessionIssuer;
  constructor(invitations: Invitations,sessions: SessionIssuer) {
    this.invitations = invitations;
    this.sessions = sessions;
  }

  workspaces(req: { actor: Actor }) {
    return respond(async () => ({
      activeWorkspaceId: req.actor.workspaceId,workspaces: await this.invitations.listAccountWorkspaces(req.actor.userId),
    }));
  }

  switchWorkspace(req: { actor: Actor },workspace: string) {
    const workspaceId = identifier(workspace);
    return respond(async () => {
      const membership = (await this.invitations.listAccountWorkspaces(req.actor.userId)).find(item => item.workspaceId === workspaceId);
      if (!membership) throw new HttpException({ code: "NOT_FOUND" },404);
      const actor = { userId: req.actor.userId,workspaceId };
      return { actor,home: membership.home,sessionToken: await this.sessions.issue(actor.userId,workspaceId) };
    });
  }

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

  received(req: { actor: Actor }) {
    return respond(async () => ({ invitations: await this.invitations.listReceivedInvitations(req.actor) }));
  }

  pending(req: { actor: Actor },project: string) {
    const projectId = identifier(project);
    return respond(async () => ({ projectId,invitations: await this.invitations.listPendingInvitations(req.actor,projectId) }));
  }

  revoke(req: { actor: Actor },project: string,input: unknown) {
    const projectId = identifier(project);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1) throw new BadRequestException();
    const { invitationId } = input as Record<string,unknown>;
    if (typeof invitationId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(invitationId)) throw new BadRequestException();
    return respond(() => this.invitations.revokePendingInvitation(req.actor,projectId,invitationId));
  }

  members(req: { actor: Actor },project: string) {
    const projectId = identifier(project);
    return respond(async () => {
      const members = await this.invitations.listProjectMembers(req.actor,projectId);
      if (!members.length) throw new HttpException({ code: "FORBIDDEN" },403);
      return { projectId,members };
    });
  }

  changeMember(req: { actor: Actor },project: string,input: unknown) {
    const projectId = identifier(project);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 3) throw new BadRequestException();
    const { userId,expectedRole,role } = input as Record<string,unknown>;
    if ((expectedRole !== "editor" && expectedRole !== "reviewer") ||
      (role !== null && role !== "editor" && role !== "reviewer")) throw new BadRequestException();
    const recipient = identifier(userId);
    return respond(() => this.invitations.changeProjectMember(req.actor,projectId,recipient,expectedRole,role));
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
Inject(SESSION_ISSUER)(ProjectInvitationsController,undefined,1);
for (const [method,path,param,route] of [
  ["workspaces","workspaces",null,Get],
  ["switchWorkspace","workspaces/:workspaceId/switch","workspaceId",Post],
  ["projects","projects",null,Get],
  ["received","project-invitations/received",null,Get],
  ["pending","projects/:projectId/invitations","projectId",Get],
  ["revoke","projects/:projectId/invitations/revoke","projectId",Post],
  ["members","projects/:projectId/members","projectId",Get],
  ["changeMember","projects/:projectId/members/change","projectId",Post],
  ["chapters","projects/:projectId/chapter-directory","projectId",Get],
  ["issue","projects/:projectId/invitations","projectId",Post],
  ["accept","project-invitations/:invitationId/accept","invitationId",Post],
] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(ProjectInvitationsController.prototype,method)!;
  route(path)(ProjectInvitationsController.prototype,method,descriptor);
  Header("Cache-Control","no-store")(ProjectInvitationsController.prototype,method,descriptor);
  Req()(ProjectInvitationsController.prototype,method,0);
  if (param) Param(param)(ProjectInvitationsController.prototype,method,1);
  if (method === "issue" || method === "changeMember" || method === "revoke") Body()(ProjectInvitationsController.prototype,method,2);
}

export class ProjectInvitationsApiModule {
  static register(sessionVerifier: SessionVerifier & SessionIssuer,invitations: Invitations): DynamicModule {
    return { module: ProjectInvitationsApiModule,providers: [
      { provide: SESSION_VERIFIER,useValue: sessionVerifier },{ provide: SESSION_ISSUER,useValue: sessionVerifier },{ provide: INVITATIONS,useValue: invitations },
    ] };
  }
}
Module({ controllers: [ProjectInvitationsController],providers: [SessionGuard] })(ProjectInvitationsApiModule);
