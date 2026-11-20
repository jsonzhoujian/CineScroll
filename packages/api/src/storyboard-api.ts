import { BadRequestException, Body, Controller, Get, Header, HttpException, Inject, Module, Param, Post, Query, Req, UseGuards, type DynamicModule } from "@nestjs/common";
import type { Actor, SessionVerifier } from "@novel-adaptation/identity";
import type { ProjectImportRepository } from "@novel-adaptation/project-import";
import { ModelSettingsError } from "@novel-adaptation/script/model-settings";
import { ModelTaskError, type ModelTaskContextReader, type ModelTaskService } from "@novel-adaptation/script/model-tasks";
import type { ScriptContentRepository } from "@novel-adaptation/script/script-content";
import { validateStoryboardShot } from "@novel-adaptation/script/storyboard-content";
import { StoryboardUpstreamError, type ConfirmedStoryboardHandoff } from "@novel-adaptation/script/storyboard-handoff";
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
  handoff: Pick<ConfirmedStoryboardHandoff, "read">;
  candidates: Pick<PostgresStoryboardCandidateRepository, "findGeneration" | "submitReview" | "listReviews" | "listAudit" | "listPublications" | "adoptReconciliationShot" | "beginReconciliation" | "confirmReconciliation" | "previewReconciliationRegeneration" | "retainReconciliationShot" | "findReview" | "saveReviewOperation">;
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
function auditCursor(query: Record<string,unknown>, chapterId: string | null) {
  if (Object.keys(query).some(key => !["recordedAt","eventId","chapterId"].includes(key))) throw new BadRequestException();
  const { recordedAt,eventId } = query;
  if (!Object.keys(query).length) return null;
  const scope = query.chapterId ?? chapterId;
  if (typeof recordedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(recordedAt)
    || !Number.isFinite(Date.parse(recordedAt)) || typeof eventId !== "string" || !eventId || eventId.length > 1024
    || typeof scope !== "string" || !scope.length || scope.length > 256 || (chapterId !== null && scope !== chapterId)) throw new BadRequestException();
  return { recordedAt,eventId,chapterId: scope };
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

  audit(req: { actor: Actor },p: string,c: string,query: Record<string,unknown>) {
    const projectId = id(p), chapterId = id(c);
    const cursor = auditCursor(query,chapterId);
    return respond(async () => {
      if (!await this.services.context.canRead?.(req.actor,projectId,chapterId)) throw new ModelTaskError("TASK_NOT_FOUND");
      const access = await this.services.projects.findProjectAccess(req.actor,projectId);
      if (!access) throw new ModelTaskError("TASK_NOT_FOUND");
      if (access.role === "editor") throw new StoryboardStorageError("FORBIDDEN");
      return this.services.candidates.listAudit(req.actor,projectId,chapterId,cursor);
    });
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

  reconciliation(req: { actor: Actor },p: string,c: string,publication: string) {
    const projectId = id(p), chapterId = id(c), selected = parsePublicationId(publication), actor = req.actor;
    return respond(async () => {
      const access = await this.services.projects.findProjectAccess(actor,projectId);
      if (!access || !await this.services.context.canRead?.(actor,projectId,chapterId)) throw new ModelTaskError("TASK_NOT_FOUND");
      if (access.role !== "owner" && access.role !== "reviewer") throw new StoryboardStorageError("FORBIDDEN");
      const baseline = await this.services.candidates.findReview(actor,projectId,chapterId,null);
      if (!baseline) throw new ModelTaskError("TASK_NOT_FOUND");
      if (baseline.publicationId !== selected) throw new ModelTaskError("STATE_CONFLICT");
      const current = await this.current(actor,projectId,chapterId);
      const { candidate,lockedShotIds } = baseline;
      const upstreamChanged = !!current && (current.sourceVersionId !== candidate.sourceVersionId ||
        current.upstreamConfirmedVersionIds.length !== candidate.upstreamConfirmedVersionIds.length ||
        current.upstreamConfirmedVersionIds.some((value,i) => value !== candidate.upstreamConfirmedVersionIds[i]));
      const formal = upstreamChanged ? await this.services.handoff.read(actor,projectId,chapterId) : null;
      if (formal && current && (formal.sourceVersionId !== current.sourceVersionId ||
        formal.upstreamConfirmedVersionIds.length !== current.upstreamConfirmedVersionIds.length ||
        formal.upstreamConfirmedVersionIds.some((value,i) => value !== current.upstreamConfirmedVersionIds[i]))) throw new ModelTaskError("UPSTREAM_CHANGED");
      return { publicationId: selected,upstreamChanged,currentUpstream: current && {
        sourceVersionId: current.sourceVersionId,upstreamConfirmedVersionIds: current.upstreamConfirmedVersionIds,
      },shots: candidate.shots.map(shot => ({
        id: shot.id,visual: shot.visual,locked: lockedShotIds.includes(shot.id),
        referencesMatch: formal ? !!validateStoryboardShot(shot,formal.context) : null,
      })) };
    });
  }

  beginReconciliation(req: { actor: Actor },p: string,c: string,publication: string,body: unknown) {
    const projectId = id(p),chapterId = id(c),selected = parsePublicationId(publication),actor = req.actor;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequestException();
    const command = body as Record<string,unknown>;
    if (Object.keys(command).length !== 2 || !Array.isArray(command.upstreamConfirmedVersionIds) || command.upstreamConfirmedVersionIds.length !== 4) throw new BadRequestException();
    const sourceVersionId = id(command.sourceVersionId), ids = command.upstreamConfirmedVersionIds.map(id);
    return respond(async () => {
      const access = await this.services.projects.findProjectAccess(actor,projectId);
      if (!access || !await this.services.context.canRead?.(actor,projectId,chapterId)) throw new ModelTaskError("TASK_NOT_FOUND");
      if (access.role !== "owner" && access.role !== "reviewer") throw new StoryboardStorageError("FORBIDDEN");
      const current = await this.current(actor,projectId,chapterId);
      if (!current || current.sourceVersionId !== sourceVersionId || current.upstreamConfirmedVersionIds.length !== ids.length
        || ids.some((value,i) => value !== current.upstreamConfirmedVersionIds[i])) throw new ModelTaskError("UPSTREAM_CHANGED");
      return this.services.candidates.beginReconciliation(actor,projectId,chapterId,selected,sourceVersionId,ids);
    });
  }

  retainReconciliationShot(req: { actor: Actor },p: string,c: string,publication: string,body: unknown,draft: string) {
    const projectId = id(p), chapterId = id(c), selected = parsePublicationId(publication), draftId = reviewId(draft), actor = req.actor;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1) throw new BadRequestException();
    const shotId = id((body as Record<string,unknown>).shotId);
    return this.saveReconciliationShot(actor,projectId,chapterId,selected,draftId,shotId);
  }

  reviseReconciliationShot(req: { actor: Actor },p: string,c: string,publication: string,body: unknown,draft: string) {
    const projectId = id(p), chapterId = id(c), selected = parsePublicationId(publication), draftId = reviewId(draft);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 4) throw new BadRequestException();
    const { shotId,visual,durationSeconds,reason } = body as Record<string,unknown>;
    if (typeof visual !== "string" || !visual.trim() || visual.length > 4000 ||
      typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds <= 0 ||
      typeof reason !== "string" || !reason.trim() || reason.length > 1000) throw new BadRequestException();
    return this.saveReconciliationShot(req.actor,projectId,chapterId,selected,draftId,id(shotId),{
      value: { visual: visual.trim(),durationSeconds },reason: reason.trim(),
    });
  }

  previewReconciliationRegeneration(req: { actor: Actor },p: string,c: string,publication: string,body: unknown,draft: string) {
    const projectId = id(p), chapterId = id(c), selected = parsePublicationId(publication), draftId = reviewId(draft), actor = req.actor;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1) throw new BadRequestException();
    const { shotIds } = body as Record<string,unknown>;
    if (!Array.isArray(shotIds) || !shotIds.length || shotIds.length > 100) throw new BadRequestException();
    const ids = shotIds.map(id);
    if (new Set(ids).size !== ids.length) throw new BadRequestException();
    return respond(async () => {
      const access = await this.services.projects.findProjectAccess(actor,projectId);
      if (!access || !await this.services.context.canRead?.(actor,projectId,chapterId)) throw new ModelTaskError("TASK_NOT_FOUND");
      if (access.role !== "owner" && access.role !== "reviewer") throw new StoryboardStorageError("FORBIDDEN");
      return this.services.candidates.previewReconciliationRegeneration(actor,projectId,chapterId,selected,draftId,ids);
    });
  }

  async submitReconciliationRegeneration(req: TaskSubmissionRequest,p: string,c: string,publication: string,body: unknown,draft: string) {
    const projectId = id(p), chapterId = id(c), publicationId = parsePublicationId(publication), reconciliationId = reviewId(draft);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 4) throw new BadRequestException();
    const { shotIds,configurationVersionId,modelId,requestId } = body as Record<string,unknown>;
    if (!Array.isArray(shotIds) || !shotIds.length || shotIds.length > 100) throw new BadRequestException();
    const scopeKeys = shotIds.map(id).sort();
    if (new Set(scopeKeys).size !== scopeKeys.length) throw new BadRequestException();
    const input = { projectId,chapterId,configurationVersionId: id(configurationVersionId),modelId: id(modelId),requestId: id(requestId) };
    await enforceTaskSubmissionRate(this.services.rateLimiter,req);
    return respond(async () => {
      const access = await this.services.projects.findProjectAccess(req.actor,projectId);
      if (!access) throw new ModelTaskError("TASK_NOT_FOUND");
      if (access.role !== "owner" && access.role !== "reviewer") throw new StoryboardStorageError("FORBIDDEN");
      return this.services.tasks.submitStoryboardRegeneration(req.actor,input,{ publicationId,reconciliationId,scopeKeys },
        () => this.services.candidates.previewReconciliationRegeneration(req.actor,projectId,chapterId,publicationId,reconciliationId,scopeKeys));
    });
  }

  confirmReconciliation(req: { actor: Actor },p: string,c: string,publication: string,body: unknown,draft: string) {
    const projectId = id(p), chapterId = id(c), publicationId = parsePublicationId(publication), draftId = reviewId(draft);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 2) throw new BadRequestException();
    const { requestId,reason } = body as Record<string,unknown>;
    if (typeof reason !== "string" || !reason.trim() || reason.length > 2000) throw new BadRequestException();
    return respond(async () => {
      const access = await this.services.projects.findProjectAccess(req.actor,projectId);
      if (!access || !await this.services.context.canRead?.(req.actor,projectId,chapterId)) throw new ModelTaskError("TASK_NOT_FOUND");
      if (access.role !== "owner" && access.role !== "reviewer") throw new StoryboardStorageError("FORBIDDEN");
      return this.services.candidates.confirmReconciliation(req.actor,projectId,chapterId,publicationId,draftId,id(requestId),reason.trim());
    });
  }

  private saveReconciliationShot(actor: Actor,projectId: string,chapterId: string,selected: string,draftId: string,shotId: string,
    revision?: Parameters<PostgresStoryboardCandidateRepository["retainReconciliationShot"]>[6]) {
    return respond(async () => {
      const access = await this.services.projects.findProjectAccess(actor,projectId);
      if (!access || !await this.services.context.canRead?.(actor,projectId,chapterId)) throw new ModelTaskError("TASK_NOT_FOUND");
      if (access.role !== "owner" && access.role !== "reviewer") throw new StoryboardStorageError("FORBIDDEN");
      return this.services.candidates.retainReconciliationShot(actor,projectId,chapterId,selected,draftId,shotId,revision);
    });
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
      canPreviewReconciliation: selected === null && (access.role === "owner" || access.role === "reviewer"),
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

  adoptReconciliationShot(req: { actor: Actor },p: string,c: string,job: string,body: unknown) {
    const projectId = id(p), chapterId = id(c), jobId = id(job);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1) throw new BadRequestException();
    const shotId = id((body as Record<string,unknown>).shotId);
    return respond(async () => {
      const task = await this.task(req.actor,projectId,chapterId,jobId);
      const binding = task.input.storyboardRegeneration;
      if (!binding || !binding.scopeKeys.includes(shotId) || task.state !== "succeeded" ||
        task.result?.candidateVersionId !== jobId) throw new ModelTaskError("TASK_NOT_FOUND");
      return this.services.candidates.adoptReconciliationShot(req.actor,projectId,chapterId,binding.reconciliationId,jobId,shotId);
    });
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
  ["readiness",Get("readiness"),null],["reviews",Get("reviews"),Query()],["audit",Get("audit"),Query()],["publications",Get("publications"),Query()],["publication",Get("publications/:id"),Param("id")],["reconciliation",Get("publications/:id/reconciliation"),Param("id")],["beginReconciliation",Post("publications/:id/reconciliation"),Param("id")],["confirmed",Get("reviews/confirmed"),null],["review",Get("reviews/:id"),Param("id")],
  ["confirmReconciliation",Post("publications/:id/reconciliation/:draftId/confirm"),Param("id")],
  ["submitReconciliationRegeneration",Post("publications/:id/reconciliation/:draftId/regeneration-tasks"),Param("id")],
  ["previewReconciliationRegeneration",Post("publications/:id/reconciliation/:draftId/regeneration-preview"),Param("id")],
  ["reviseReconciliationShot",Post("publications/:id/reconciliation/:draftId/revisions"),Param("id")],
  ["retainReconciliationShot",Post("publications/:id/reconciliation/:draftId/retains"),Param("id")],
  ["operate",Post("reviews/:id/operations"),Param("id")],
  ["adoptReconciliationShot",Post(":id/adopt-regenerated-shot"),Param("id")],
  ["submitReview",Post(":id/review"),Param("id")],["get",Get(":id"),Param("id")],["candidate",Get(":id/candidate"),Param("id")],
] as const) {
  const d = Object.getOwnPropertyDescriptor(StoryboardController.prototype,method)!;
  route(StoryboardController.prototype,method,d);
  Header("Cache-Control","no-store")(StoryboardController.prototype,method,d);
  Req()(StoryboardController.prototype,method,0);
  Param("projectId")(StoryboardController.prototype,method,1);
  Param("chapterId")(StoryboardController.prototype,method,2);
  parameter?.(StoryboardController.prototype,method,3);
  if (method === "adoptReconciliationShot" || method === "operate" || method === "beginReconciliation" || method === "retainReconciliationShot" || method === "reviseReconciliationShot" || method === "previewReconciliationRegeneration" || method === "submitReconciliationRegeneration" || method === "confirmReconciliation") Body()(StoryboardController.prototype,method,4);
  if (method === "retainReconciliationShot" || method === "reviseReconciliationShot" || method === "previewReconciliationRegeneration" || method === "submitReconciliationRegeneration" || method === "confirmReconciliation") Param("draftId")(StoryboardController.prototype,method,5);
}
class ProjectStoryboardAuditController {
  private readonly services: Services;
  constructor(services: Services) { this.services = services; }

  audit(req: { actor: Actor },p: string,query: Record<string,unknown>) {
    const projectId = id(p), cursor = auditCursor(query,null);
    return respond(async () => {
      const access = await this.services.projects.findProjectAccess(req.actor,projectId);
      if (!access) throw new ModelTaskError("TASK_NOT_FOUND");
      if (access.role === "editor") throw new StoryboardStorageError("FORBIDDEN");
      return this.services.candidates.listAudit(req.actor,projectId,null,cursor);
    });
  }
}
Controller("projects/:projectId/storyboard-audit")(ProjectStoryboardAuditController);
UseGuards(SessionGuard)(ProjectStoryboardAuditController);
Inject(SERVICES)(ProjectStoryboardAuditController,undefined,0);
const projectAudit = Object.getOwnPropertyDescriptor(ProjectStoryboardAuditController.prototype,"audit")!;
Get()(ProjectStoryboardAuditController.prototype,"audit",projectAudit);
Header("Cache-Control","no-store")(ProjectStoryboardAuditController.prototype,"audit",projectAudit);
Req()(ProjectStoryboardAuditController.prototype,"audit",0);
Param("projectId")(ProjectStoryboardAuditController.prototype,"audit",1);
Query()(ProjectStoryboardAuditController.prototype,"audit",2);

class StoryboardNotificationsController {
  private readonly services: Services;
  constructor(services: Services) { this.services = services; }

  list(req: { actor: Actor },query: Record<string,unknown>) {
    if (Object.keys(query).some(key => key !== "limit" && key !== "cursor")) throw new BadRequestException();
    const limit = query.limit === undefined ? 20
      : typeof query.limit === "string" && /^[1-9]\d?$/.test(query.limit) ? Number(query.limit) : NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new BadRequestException();
    const cursor = query.cursor === undefined ? null : id(query.cursor);
    return respond(() => this.services.tasks.listTaskNotifications(req.actor,{ limit,cursor },"storyboardContent"));
  }
}
Controller("storyboard-notifications")(StoryboardNotificationsController);
UseGuards(SessionGuard)(StoryboardNotificationsController);
Inject(SERVICES)(StoryboardNotificationsController,undefined,0);
const storyboardNotifications = Object.getOwnPropertyDescriptor(StoryboardNotificationsController.prototype,"list")!;
Get()(StoryboardNotificationsController.prototype,"list",storyboardNotifications);
Header("Cache-Control","no-store")(StoryboardNotificationsController.prototype,"list",storyboardNotifications);
Req()(StoryboardNotificationsController.prototype,"list",0);
Query()(StoryboardNotificationsController.prototype,"list",1);

export class StoryboardApiModule {
  static register(services: Services): DynamicModule {
    return { module: StoryboardApiModule,providers: [{ provide: SESSION_VERIFIER,useValue: services.sessionVerifier },{ provide: SERVICES,useValue: services }] };
  }
}
Module({ controllers: [StoryboardController,ProjectStoryboardAuditController,StoryboardNotificationsController],providers: [SessionGuard] })(StoryboardApiModule);
