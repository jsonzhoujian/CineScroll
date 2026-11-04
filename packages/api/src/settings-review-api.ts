import { BadRequestException,Body,Controller,Get,Header,HttpException,Inject,Module,Param,Post,Req,UseGuards,type DynamicModule } from "@nestjs/common";
import type { Actor,SessionVerifier } from "@novel-adaptation/identity";
import { SettingsReviewError,type SettingsReviewCommand,type SettingsReviewRepository,type SettingsReviewService } from "@novel-adaptation/script/settings-review";
import { ScriptContentError } from "@novel-adaptation/script/script-content";
import type { SettingsTaskContext } from "./settings-task-executor.ts";
import { SESSION_VERIFIER,SessionGuard } from "./index.ts";
const SERVICES = Symbol("SETTINGS_REVIEW_API");
type Services = { sessionVerifier: SessionVerifier;review: SettingsReviewService;repository: SettingsReviewRepository;context: Pick<SettingsTaskContext,"canRead"> };
function identifier(v: unknown) { return typeof v === "string" && !!v.trim() && v.length <= 256 && !/[\r\n]/.test(v); }
class SettingsReviewController {
  private readonly services: Services;
  constructor(services: Services) { this.services = services; }
  async execute(request: { actor: Actor },p: string,c: string,body: unknown) {
    return this.authorized(request.actor,p,c,() => this.services.review.execute(request.actor,p,c,body as SettingsReviewCommand));
  }
  async version(request: { actor: Actor },p: string,c: string,id: string) {
    if (!identifier(id)) throw new BadRequestException();
    return this.authorized(request.actor,p,c,async () => {
      const version = id === "confirmed" ? await this.services.repository.findConfirmed(request.actor,p,c) : await this.services.repository.findVersion(request.actor,p,c,id);
      if (!version) throw new SettingsReviewError("NOT_FOUND");return { version };
    });
  }
  async operation(request: { actor: Actor },p: string,c: string,id: string) {
    if (!identifier(id)) throw new BadRequestException();
    return this.authorized(request.actor,p,c,async () => {
      const version = await this.services.repository.findOperation(request.actor,p,c,id);
      if (!version) throw new SettingsReviewError("NOT_FOUND");return { version };
    });
  }
  private async authorized<T>(a: Actor,p: string,c: string,action: () => Promise<T>) {
    if (![p,c].every(identifier)) throw new BadRequestException();
    try {
      if (!await this.services.context.canRead(a,p,c)) throw new SettingsReviewError("NOT_FOUND");
      return await action();
    } catch (error) {
      const code = error instanceof SettingsReviewError ? error.code : error instanceof ScriptContentError && ["CONTEXT_NOT_FOUND","INVALID_STATE"].includes(error.code) ? "UPSTREAM_CHANGED" : "STORAGE_UNAVAILABLE";
      const status = code === "NOT_FOUND" ? 404 : code === "FORBIDDEN" ? 403 : code === "INVALID_COMMAND" ? 400 : code === "STORAGE_UNAVAILABLE" ? 503 : 409;
      throw new HttpException({ code,message: code },status);
    }
  }
}
Controller("projects/:projectId/chapters/:chapterId/settings")(SettingsReviewController);UseGuards(SessionGuard)(SettingsReviewController);Inject(SERVICES)(SettingsReviewController,undefined,0);
for (const [method,decorator] of [["execute",Post("review")],["version",Get("versions/:id")],["operation",Get("operations/:id")]] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(SettingsReviewController.prototype,method)!;
  decorator(SettingsReviewController.prototype,method,descriptor);Header("Cache-Control","no-store")(SettingsReviewController.prototype,method,descriptor);
  Req()(SettingsReviewController.prototype,method,0);Param("projectId")(SettingsReviewController.prototype,method,1);Param("chapterId")(SettingsReviewController.prototype,method,2);
  if (method === "execute") Body()(SettingsReviewController.prototype,method,3);else Param("id")(SettingsReviewController.prototype,method,3);
}
export class SettingsReviewApiModule {
  static register(services: Services): DynamicModule { return { module: SettingsReviewApiModule,providers: [{ provide: SESSION_VERIFIER,useValue: services.sessionVerifier },{ provide: SERVICES,useValue: services }] }; }
}
Module({ controllers: [SettingsReviewController],providers: [SessionGuard] })(SettingsReviewApiModule);
