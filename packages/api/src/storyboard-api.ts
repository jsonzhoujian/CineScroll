import { BadRequestException, Body, Controller, Get, Header, HttpException, Inject, Module, Param, Post, Query, Req, UseGuards, type DynamicModule } from "@nestjs/common";
import type { Actor, SessionVerifier } from "@novel-adaptation/identity";
import type { ProjectImportRepository } from "@novel-adaptation/project-import";
import { ModelSettingsError } from "@novel-adaptation/script/model-settings";
import { ModelTaskError, type ModelTaskContextReader, type ModelTaskService } from "@novel-adaptation/script/model-tasks";
import type { ScriptContentRepository } from "@novel-adaptation/script/script-content";
import { StoryboardUpstreamError } from "@novel-adaptation/script/storyboard-handoff";
import { StoryboardStorageError, type StoryboardReviewCommand, type PostgresStoryboardCandidateRepository } from "@novel-adaptation/script/postgres-storyboard-candidates";
import type { StoryboardCandidate } from "@novel-adaptation/script/storyboard-runner";
import { SESSION_VERIFIER, SessionGuard } from "./index.ts";
import type { ModelRateLimiter } from "./model-rate-limit.ts";
import { enforceTaskSubmissionRate, type TaskSubmissionRequest } from "./task-submission-rate.ts";

const SERVICES = Symbol("STORYBOARD_API");
type Services = {
  sessionVerifier: SessionVerifier;
  tasks: ModelTaskService;
  rateLimiter: ModelRateLimiter;
  context: ModelTaskContextReader;
  candidates: Pick<PostgresStoryboardCandidateRepository, "findGeneration" | "submitReview" | "listReviews" | "listPublications" | "findReview" | "saveReviewOperation">;
  scripts: Pick<ScriptContentRepository, "findVersion">;
  projects: Pick<ProjectImportRepository, "findChapter" | "findProjectAccess">;
};
function id(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\r\n]/.test(value)) throw new BadRequestException();
  return value;
}
function reviewId(value: unknown) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)) throw new BadRequestException();
  return value;
}
function parsePublicationId(value: unknown) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) throw new BadRequestException();
  return value;
}
function submission(body: unknown, retry: boolean) {
  const keys = ["configurationVersionId","modelId","requestId",...(retry ? ["expectedActiveVersionId","scopeKeys"] : [])];
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key))) throw new BadRequestException();
  const value = body as Record<string,unknown>;
  return { configurationVersionId: id(value.configurationVersionId), modelId: id(value.modelId), requestId: id(value.requestId), value };
}
async function respond<T>(action: () => Promise<T>) {
  try { return await action(); }
  catch (error) {
    const code = error instanceof StoryboardUpstreamError ? "UPSTREAM_CHANGED" : error instanceof ModelTaskError || error instanceof ModelSettingsError || error instanceof StoryboardStorageError ? error.code : "STORAGE_UNAVAILABLE";
    const status = code === "TASK_NOT_FOUND" ? 404 : ["TASK_QUEUE_FULL","TASK_EXECUTION_FULL"].includes(code) ? 429
      : ["INVALID_CONTEXT","INVALID_CONFIGURATION","INVALID_CANDIDATE"].includes(code) ? 400 : ["STATE_CONFLICT","UPSTREAM_CHANGED","VERSION_CONFLICT","REVIEW_INCOMPLETE","DURATION_OUT_OF_RANGE"].includes(code) ? 409
      : ["FORBIDDEN","POLICY_RESTRICTED","WORKSPACE_TASK_DISABLED","TASK_PROVIDER_UNSUPPORTED"].includes(code) ? 403 : 503;
    throw new HttpException({ code, message: code },status);
  }
}
class StoryboardController {
  private readonly services: Services;
  constructor(services: Services) { this.services = services; }

  async submit(req: TaskSubmissionRequest,p: string,c: string,body: unknown) {
    const { configurationVersionId,modelId,requestId } = submission(body,false);
    const projectId = id(p), chapterId = id(c);
    await enforceTaskSubmissionRate(this.services.rateLimiter,req);
    return respond(() => this.services.tasks.submitStoryboard(req.actor,{ projectId,chapterId,configurationVersionId,modelId,requestId }));
  }

  async retry(req: TaskSubmissionRequest,p: string,c: string,body: unknown) {
    const { configurationVersionId,modelId,requestId,value } = submission(body,true);
    const projectId = id(p), chapterId = id(c), expectedActiveVersionId = id(value.expectedActiveVersionId);
    if (!Array.isArray(value.scopeKeys) || !value.scopeKeys.length || value.scopeKeys.length > 100) throw new BadRequestException();
    const scopeKeys = value.scopeKeys.map(id);
    if (new Set(scopeKeys).size !== scopeKeys.length) throw new BadRequestException();
    await enforceTaskSubmissionRate(this.services.rateLimiter,req);
    return respond(() => this.services.tasks.submitStoryboardRetry(req.actor,{ projectId,chapterId,configurationVersionId,modelId,requestId,expectedActiveVersionId,scopeKeys }));
  }

  list(req: { actor: Actor },p: string,c: string,query: Record<string,unknown>) {
    const projectId = id(p), chapterId = id(c);
    if (Object.keys(query).some(key => key !== "cursor")) throw new BadRequestException();
    const cursor = query.cursor === undefined ? null : id(query.cursor);
    return respond(() => this.services.tasks.listStoryboard(req.actor,projectId,chapterId,{ limit: 20,cursor }));
  }

  private async task(actor: Actor,p: string,c: string,jobId: string) {
    const task = await this.services.tasks.get(actor,jobId);
    if (task.projectId !== p || task.chapterId !== c || task.input.stage !== "storyboard" || task.input.resultType !== "storyboardContent") throw new ModelTaskError("TASK_NOT_FOUND");
    return task;
  }

  readiness(req: { actor: Actor },p: string,c: string) {
    const projectId = id(p), chapterId = id(c);
    return respond(async () => {
      const { context } = this.services, actor = req.actor;
      if (!await context.canRead?.(actor,projectId,chapterId)) throw new ModelTaskError("TASK_NOT_FOUND");
      return { ready: !!await this.current(actor,projectId,chapterId), userId: actor.userId };
    });
  }

  reviews(req: { actor: Actor },p: string,c: string,query: Record<string,unknown>) {
    const projectId = id(p), chapterId = id(c);
    if (Object.keys(query).some(key => key !== "cursor")) throw new BadRequestException();
    const cursor = query.cursor === undefined ? null : reviewId(query.cursor);
    return respond(async () => {
      if (!await this.services.context.canRead?.(req.actor,projectId,chapterId)) throw new ModelTaskError("TASK_NOT_FOUND");
      return this.services.candidates.listReviews(req.actor,projectId,chapterId,cursor);
    });
  }

  confirmed(req: { actor: Actor },p: string,c: string) {
    const projectId = id(p), chapterId = id(c);
    return respond(() => this.reviewView(req.actor,projectId,chapterId,null));
  }

  publications(req: { actor: Actor },p: string,c: string,query: Record<string,unknown>) {
    const projectId = id(p), chapterId = id(c);
    if (Object.keys(query).some(key => key !== "cursor")) throw new BadRequestException();
    const cursor = query.cursor === undefined ? null : parsePublicationId(query.cursor);
    return respond(async () => {
      if (!await this.services.context.canRead?.(req.actor,projectId,chapterId)) throw new ModelTaskError("TASK_NOT_FOUND");
      return this.services.candidates.listPublications(req.actor,projectId,chapterId,cursor);
    });
  }

  publication(req: { actor: Actor },p: string,c: string,publicationId: string) {
    const projectId = id(p), chapterId = id(c);
    const selected = parsePublicationId(publicationId);
    return respond(() => this.reviewView(req.actor,projectId,chapterId,null,selected));
  }

  review(req: { actor: Actor },p: string,c: string,review: string) {
    const projectId = id(p), chapterId = id(c), selected = reviewId(review);
    return respond(() => this.reviewView(req.actor,projectId,chapterId,selected));
  }

  operate(req: { actor: Actor },p: string,c: string,review: string,body: unknown) {
    const projectId = id(p), chapterId = id(c), selected = reviewId(review);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequestException();
    return respond(async () => {
      await this.services.candidates.saveReviewOperation(req.actor,projectId,chapterId,selected,body as StoryboardReviewCommand);
      return this.reviewView(req.actor,projectId,chapterId,selected);
    });
  }

  private async reviewView(actor: Actor,projectId: string,chapterId: string,selected: string | null, publicationIdFilter: string | null = null) {
    const [review,access] = await Promise.all([
      this.services.candidates.findReview(actor,projectId,chapterId,selected,publicationIdFilter),
      this.services.projects.findProjectAccess(actor,projectId),
    ]);
    if (!review || !access) throw new ModelTaskError("TASK_NOT_FOUND");
    const { candidate,revision,suggestions,lockedShotIds,publicationId,confirmed,isFormalReview,episodeDurations } = review;
    const { version, ...view } = await this.view(actor,projectId,chapterId,candidate);
    const reviewer = selected !== null && (access.role === "owner" || access.role === "reviewer");
    const canReview = reviewer && view.current;
    return { ...view, reviewId: review.reviewId, revision, suggestions,lockedShotIds,publicationId,confirmed,
      formalRead: selected === null,episodeDurations,
      permissions: { canSuggest: selected !== null && view.current,canEdit: canReview,canDecide: canReview,
        canConfirm: canReview && !confirmed,canLock: canReview && confirmed,canUnlock: reviewer && isFormalReview },
      version: { projectId, chapterId, sourceVersionId: version.sourceVersionId, upstreamConfirmedVersionIds: version.upstreamConfirmedVersionIds,
        shots: version.shots, failures: version.failures } };
  }

  submitReview(req: { actor: Actor },p: string,c: string,job: string) {
    const projectId = id(p), chapterId = id(c), jobId = id(job), actor = req.actor;
    return respond(async () => {
      const task = await this.task(actor,projectId,chapterId,jobId);
      if (task.state !== "succeeded" || task.result?.candidateVersionId !== jobId) throw new ModelTaskError("TASK_NOT_FOUND");
      return this.services.candidates.submitReview(actor,projectId,chapterId,jobId);
    });
  }

  get(req: { actor: Actor },p: string,c: string,jobId: string) {
    const identity = [id(p),id(c),id(jobId)] as const;
    return respond(() => this.task(req.actor,...identity));
  }

  private async current(actor: Actor,p: string,c: string) {
    try { return await this.services.context.read(actor,p,c); }
    catch (error) {
      if (error instanceof ModelTaskError && error.code === "UPSTREAM_CHANGED") return null;
      throw error;
    }
  }

  candidate(req: { actor: Actor },p: string,c: string,job: string) {
    const projectId = id(p), chapterId = id(c), jobId = id(job), actor = req.actor;
    return respond(async () => {
      const task = await this.task(actor,projectId,chapterId,jobId);
      if (task.state !== "succeeded" || task.result?.candidateVersionId !== jobId) throw new ModelTaskError("TASK_NOT_FOUND");
      const { sourceVersionId, upstreamConfirmedVersionIds } = task.input;
      const version = await this.services.candidates.findGeneration(actor,{ projectId,chapterId,jobId,sourceVersionId,upstreamConfirmedVersionIds });
      if (!version || version.generationStatus !== task.result.extractionStatus) throw new ModelTaskError("TASK_NOT_FOUND");
      return this.view(actor,projectId,chapterId,version);
    });
  }

  private async view(actor: Actor,projectId: string,chapterId: string,version: StoryboardCandidate) {
    const { sourceVersionId, upstreamConfirmedVersionIds } = version;
    const [chapter, script, formal] = await Promise.all([
      this.services.projects.findChapter(actor,projectId,chapterId),
      this.services.scripts.findVersion?.(actor,projectId,chapterId,upstreamConfirmedVersionIds[0]!),
      this.current(actor,projectId,chapterId),
    ]);
    const source = chapter?.versions.find(item => item.id === sourceVersionId);
    if (!source || !script || script.status !== "confirmed" || script.sourceVersionId !== sourceVersionId
      || script.id !== upstreamConfirmedVersionIds[0] || script.projectId !== projectId || script.chapterId !== chapterId) throw new ModelTaskError("STORAGE_UNAVAILABLE");
    const current = formal?.sourceVersionId === sourceVersionId && formal.upstreamConfirmedVersionIds.length === upstreamConfirmedVersionIds.length
      && upstreamConfirmedVersionIds.every((value,i) => formal.upstreamConfirmedVersionIds[i] === value);
    const elementIds = new Set(version.shots.flatMap(shot => shot.scriptElementIds));
    const fragmentIds = new Set(version.shots.flatMap(shot => shot.provenance.flatMap(evidence => evidence.type === "source_fragment" ? [evidence.fragmentId] : [])));
    return { version, current, scriptElements: script.elements.filter(element => elementIds.has(element.id)).map(({ id,text,sceneId,provenance }) => ({ id,text,sceneId,provenance })),
      sourceFragments: source.fragments.filter(fragment => fragmentIds.has(fragment.id)).map(({ id,text }) => ({ id,text })) };
  }
}

Controller("projects/:projectId/chapters/:chapterId/storyboard-tasks")(StoryboardController);
UseGuards(SessionGuard)(StoryboardController);
Inject(SERVICES)(StoryboardController,undefined,0);
for (const [method,route,parameter] of [
  ["submit",Post(""),Body()],["retry",Post("retries"),Body()],["list",Get(""),Query()],
  ["readiness",Get("readiness"),null],["reviews",Get("reviews"),Query()],["publications",Get("publications"),Query()],["publication",Get("publications/:id"),Param("id")],["confirmed",Get("reviews/confirmed"),null],["review",Get("reviews/:id"),Param("id")],
  ["operate",Post("reviews/:id/operations"),Param("id")],
  ["submitReview",Post(":id/review"),Param("id")],["get",Get(":id"),Param("id")],["candidate",Get(":id/candidate"),Param("id")],
] as const) {
  const d = Object.getOwnPropertyDescriptor(StoryboardController.prototype,method)!;
  route(StoryboardController.prototype,method,d);
  Header("Cache-Control","no-store")(StoryboardController.prototype,method,d);
  Req()(StoryboardController.prototype,method,0);
  Param("projectId")(StoryboardController.prototype,method,1);
  Param("chapterId")(StoryboardController.prototype,method,2);
  parameter?.(StoryboardController.prototype,method,3);
  if (method === "operate") Body()(StoryboardController.prototype,method,4);
}
export class StoryboardApiModule {
  static register(services: Services): DynamicModule {
    return { module: StoryboardApiModule,providers: [{ provide: SESSION_VERIFIER,useValue: services.sessionVerifier },{ provide: SERVICES,useValue: services }] };
  }
}
Module({ controllers: [StoryboardController],providers: [SessionGuard] })(StoryboardApiModule);
