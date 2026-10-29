import { BadRequestException, Catch, Controller, Get, Header, Inject, Module, Param, Req, UseGuards, type ArgumentsHost, type DynamicModule, type ExceptionFilter } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import type { Actor, SessionVerifier } from "@novel-adaptation/identity";
import { ScriptContentError, type ScriptContentRepository } from "@novel-adaptation/script/script-content";
import type { ScriptContentContext } from "./script-content-context.ts";
import { SESSION_VERIFIER, SessionGuard } from "./index.ts";
const SERVICES = Symbol("SCRIPT_CONTENT_READ");
type Services = { sessionVerifier: SessionVerifier;repository: ScriptContentRepository;context: ScriptContentContext };
class ScriptContentController {
  private readonly services: Services;
  constructor(services: Services) { this.services = services; }
  async view(request: { actor: Actor },p: string,c: string) {
    if (![p,c].every(v => typeof v === "string" && !!v.trim() && v.length <= 256 && !/[\r\n]/.test(v))) throw new BadRequestException();
    try {
      if (!await this.services.context.canRead(request.actor,p,c)) throw new ScriptContentError("CONTEXT_NOT_FOUND","不可读取剧本");
      const version = await this.services.repository.findActive(request.actor,p,c);
      if (!version) throw new ScriptContentError("CONTEXT_NOT_FOUND","尚无剧本候选");
      const context = await this.services.context.findGenerationContext(request.actor,p,c);
      const current = context?.sourceVersionId === version.sourceVersionId && context?.planVersionId === version.planVersionId;
      return { version,current,sourceFragments: current ? context!.fragments : [] };
    } catch (error) { if (error instanceof ScriptContentError) throw error; throw new ScriptContentError("STORAGE_UNAVAILABLE","剧本读取失败"); }
  }
}
class ScriptContentFilter implements ExceptionFilter<ScriptContentError> {
  catch(error: ScriptContentError,host: ArgumentsHost) { host.switchToHttp().getResponse().status(error.code === "CONTEXT_NOT_FOUND" ? 404 : error.code === "FORBIDDEN" ? 403 : 503).json({ code: error.code,message: error.code }); }
}
Catch(ScriptContentError)(ScriptContentFilter);
Controller("projects/:projectId/chapters/:chapterId/script-content")(ScriptContentController); UseGuards(SessionGuard)(ScriptContentController); Inject(SERVICES)(ScriptContentController,undefined,0);
const descriptor = Object.getOwnPropertyDescriptor(ScriptContentController.prototype,"view")!;
Get()(ScriptContentController.prototype,"view",descriptor); Header("Cache-Control","no-store")(ScriptContentController.prototype,"view",descriptor);
Req()(ScriptContentController.prototype,"view",0); Param("projectId")(ScriptContentController.prototype,"view",1); Param("chapterId")(ScriptContentController.prototype,"view",2);
export class ScriptContentApiModule {
  static register(services: Services): DynamicModule { return { module: ScriptContentApiModule,providers: [{ provide: SERVICES,useValue: services },{ provide: SESSION_VERIFIER,useValue: services.sessionVerifier }] }; }
}
Module({ controllers: [ScriptContentController],providers: [SessionGuard,{ provide: APP_FILTER,useClass: ScriptContentFilter }] })(ScriptContentApiModule);
