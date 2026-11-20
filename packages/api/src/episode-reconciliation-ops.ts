import { createHash,timingSafeEqual } from "node:crypto";
import { BadRequestException,Controller,ForbiddenException,Get,Header,Headers,Inject,Module,Param,Query,
  ServiceUnavailableException,UnauthorizedException,type DynamicModule } from "@nestjs/common";
import type { Pool } from "pg";
import { isEpisodeReconciliationAlertCode,createEpisodeReconciliationAlertReader } from "./episode-reconciliation-alerts.ts";

type Reader=ReturnType<typeof createEpisodeReconciliationAlertReader>;
type Policy={serviceId:string;workspaceIds:readonly string[]};
type Service=Policy & {tokenSha256:string};
type Entry={policy:Policy;digest:Buffer;read:Reader};
const SERVICES=Symbol("EPISODE_RECONCILIATION_OPS_SERVICES");

const id=(value:unknown):value is string=>typeof value==="string" && value.trim()===value
  && value.length>0 && value.length<=256 && !/[\r\n\0]/.test(value);

class EpisodeReconciliationOpsController {
  readonly #entries:readonly Entry[];
  constructor(entries:readonly Entry[]) { this.#entries=entries; }

  async list(authorization:unknown,workspaceId:string,query:Record<string,unknown>) {
    const token=typeof authorization==="string" ? /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization)?.[1] : undefined;
    if (!token) throw new UnauthorizedException();
    const digest=createHash("sha256").update(token).digest();
    let authenticated:Entry | undefined;
    for (const entry of this.#entries) {
      if (timingSafeEqual(digest,entry.digest)) authenticated=entry;
    }
    if (!authenticated) throw new UnauthorizedException();
    if (!authenticated.policy.workspaceIds.includes(workspaceId)) throw new ForbiddenException();

    const {limit:rawLimit,cursorTaskId,cursorCode}=query;
    const limit=rawLimit===undefined ? 20
      : typeof rawLimit==="string" && /^[1-9][0-9]?$/.test(rawLimit) ? Number(rawLimit) : 0;
    if (Object.keys(query).some(key=>!["limit","cursorTaskId","cursorCode"].includes(key)) || limit<1 || limit>50) {
      throw new BadRequestException();
    }
    let cursor:Parameters<Reader>[1]["cursor"]=null;
    if (cursorTaskId!==undefined || cursorCode!==undefined) {
      if (!id(cursorTaskId) || !isEpisodeReconciliationAlertCode(cursorCode)) throw new BadRequestException();
      cursor={taskId:cursorTaskId,code:cursorCode};
    }
    try {
      return await authenticated.read({serviceId:authenticated.policy.serviceId,workspaceId},{limit,cursor});
    } catch {
      throw new ServiceUnavailableException();
    }
  }
}
Controller("internal/workspaces/:workspaceId/episode-reconciliation-alerts")(EpisodeReconciliationOpsController);
Inject(SERVICES)(EpisodeReconciliationOpsController,undefined,0);
const method=Object.getOwnPropertyDescriptor(EpisodeReconciliationOpsController.prototype,"list")!;
Get()(EpisodeReconciliationOpsController.prototype,"list",method);
Header("Cache-Control","no-store")(EpisodeReconciliationOpsController.prototype,"list",method);
Headers("authorization")(EpisodeReconciliationOpsController.prototype,"list",0);
Param("workspaceId")(EpisodeReconciliationOpsController.prototype,"list",1);
Query()(EpisodeReconciliationOpsController.prototype,"list",2);

/** Opt-in module for a private operations host. Never imported by the public API. */
export class EpisodeReconciliationOpsModule {
  static forDatabase(pool:Pool,services:readonly Service[]):DynamicModule {
    return this.register({services,reader:policy=>createEpisodeReconciliationAlertReader(pool,policy)});
  }

  static register(options:{services:readonly Service[];reader:(policy:Policy)=>Reader}):DynamicModule {
    const services=structuredClone(options.services);
    if (!services.length || new Set(services.map(service=>service.serviceId)).size!==services.length
      || new Set(services.map(service=>service.tokenSha256)).size!==services.length
      || services.some(service=>!id(service.serviceId) || typeof service.tokenSha256!=="string"
        || !/^[a-f0-9]{64}$/.test(service.tokenSha256)
        || !Array.isArray(service.workspaceIds) || !service.workspaceIds.length || !service.workspaceIds.every(id))) {
      throw new Error("INVALID_EPISODE_OPS_CONFIG");
    }
    const entries=services.map(({serviceId,workspaceIds,tokenSha256})=>{
      const policy={serviceId,workspaceIds:Object.freeze(workspaceIds)};
      return {policy,digest:Buffer.from(tokenSha256,"hex"),read:options.reader(policy)};
    });
    return {module:EpisodeReconciliationOpsModule,controllers:[EpisodeReconciliationOpsController],
      providers:[{provide:SERVICES,useValue:entries}]};
  }
}
Module({})(EpisodeReconciliationOpsModule);
