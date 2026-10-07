import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { Module, type DynamicModule } from "@nestjs/common";
import { WorkspaceModelSettings, type ModelConfiguration } from "@novel-adaptation/script/model-settings";
import { PostgresModelSettingsRepository } from "@novel-adaptation/script/postgres-model-settings";
import { PostgresWorkspaceModelAccess } from "@novel-adaptation/script/workspace-model-access";
import { NativeModelDirectoryProbe } from "@novel-adaptation/script/provider-probe";
import { ModelSettingsApiModule } from "./model-settings-api.ts";
import { PostgresModelRateLimiter } from "./model-rate-limit.ts";
import { ModelTaskService } from "@novel-adaptation/script/model-tasks";
import { PostgresModelTaskRepository } from "@novel-adaptation/script/postgres-model-tasks";
import { PostgresGenerationPolicyReader } from "@novel-adaptation/story-knowledge/generation-policy";
import { StoryKnowledgeTaskContext } from "./story-knowledge-task-context.ts";
import { StoryKnowledgeRetryPlanner } from "./story-knowledge-retry-planner.ts";
import { StoryKnowledgeTaskExecutor } from "./story-knowledge-task-executor.ts";
import { StoryKnowledgeTaskDispatcher } from "./story-knowledge-task-dispatcher.ts";
import { StoryKnowledgeTaskWorker } from "./story-knowledge-task-worker.ts";
import { StoryKnowledgeWorkerModule } from "./story-knowledge-worker-module.ts";
import { StoryKnowledgeTaskApiModule } from "./story-knowledge-task-api.ts";
import { DeepSeekStoryKnowledgeModel } from "./deepseek-story-model.ts";
import { assertStoryTaskDatabase } from "./story-task-database-readiness.ts";
import { ScriptService } from "@novel-adaptation/script";
import { PostgresScriptRepository } from "@novel-adaptation/script/postgres-episode-plan";
import { EpisodePlanApiModule, EpisodePlanUpstreamReader } from "./episode-plan-api.ts";
import { EpisodePlanTaskApiModule } from "./episode-plan-task-api.ts";
import { EpisodePlanTaskContext, EpisodePlanTaskExecutor } from "./episode-plan-task-executor.ts";
import { EpisodePlanTaskDispatcher } from "./episode-plan-task-dispatcher.ts";
import { EpisodePlanWorkerModule } from "./episode-plan-worker-module.ts";
import { DeepSeekEpisodePlanModel } from "./deepseek-episode-model.ts";
import { assertEpisodeTaskDatabase } from "./episode-task-database-readiness.ts";

import { HmacSessionManager, IdentityService } from "@novel-adaptation/identity";
import {
  PostgresIdentityRepository,
  PostgresLoginChallengeStore,
  PostgresLoginRateLimiter,
} from "@novel-adaptation/identity/postgres-adapters";
import { HttpPhoneVerificationProvider, WechatWebsiteLoginProvider } from "@novel-adaptation/identity/providers";
import { ProjectImportService } from "@novel-adaptation/project-import";
import { HttpComplianceScanner } from "@novel-adaptation/project-import/http-compliance-scanner";
import { MammothDocxTextExtractor } from "@novel-adaptation/project-import/mammoth-docx-extractor";
import { PostgresProjectImportRepository } from "@novel-adaptation/project-import/postgres-repository";
import { StoryKnowledgeService } from "@novel-adaptation/story-knowledge";
import { PostgresStoryKnowledgeRepository } from "@novel-adaptation/story-knowledge/postgres-repository";

import { ForwardedClientIpResolver, HmacDeviceTokenService, ProjectImportApiModule } from "./index.ts";

export interface ProductionApiConfig {
  modelSettings?: ProductionModelSettingsConfig;
  storyTasks?: { enabled: false } | { enabled: true; workspaceIds: readonly string[]; intervalMs?: number };
  episodeTasks?: { enabled: false } | { enabled: true; workspaceIds: readonly string[]; intervalMs?: number };
  databaseUrl: string;
  databaseTlsCa: string;
  sessionSecret: string;
  deviceTokenSecret: string;
  trustedProxyHops: number;
  smsEndpoint: string;
  smsApiKey: string;
  wechatAppId: string;
  wechatAppSecret: string;
  wechatRedirectUri: string;
  complianceEndpoint: string;
  complianceApiKey: string;
}

export type ProductionModelSettingsConfig = { enabled: false } | {
  enabled: true;
  encryptionKeyBase64: string;
  databaseUrl: string;
  databaseTlsCa: string;
  routes: Readonly<Record<string, ModelConfiguration["processingRegion"]>>;
};
class ProductionApiModule {}
Module({})(ProductionApiModule);

function validateModelConfig(config: ProductionApiConfig): Uint8Array | null {
  const value = config.modelSettings;
  if (value === undefined || value.enabled === false) return null;
  try {
    if (value.enabled !== true || !value.databaseTlsCa.trim()) throw new Error();
    assertDatabaseUrl(value.databaseUrl);
    const key = Buffer.from(value.encryptionKeyBase64, "base64");
    if (key.length !== 32 || key.toString("base64") !== value.encryptionKeyBase64
      || key.equals(Buffer.from(config.sessionSecret)) || key.equals(Buffer.from(config.deviceTokenSecret))) throw new Error();
    if (!value.routes || Array.isArray(value.routes) || typeof value.routes !== "object" || !Object.keys(value.routes).length) throw new Error();
    if (Object.values(value.routes).some(route => route !== "mainland" && route !== "overseas")) throw new Error();
    new NativeModelDirectoryProbe({ routes: value.routes });
    return key;
  } catch { throw new Error("INVALID_MODEL_SETTINGS_CONFIG"); }
}

export function createProductionApi(config: ProductionApiConfig, ports: { modelFetch?: typeof globalThis.fetch } = {}) {
  config = structuredClone(config);
  assertProductionConfig(config);
  const modelKey = validateModelConfig(config);
  if (config.episodeTasks !== undefined && config.episodeTasks.enabled !== false) {
    try {
      const tasks = config.episodeTasks, models = config.modelSettings;
      if (tasks.enabled !== true || models?.enabled !== true || models.routes.deepseek !== "mainland" ||
          !Array.isArray(tasks.workspaceIds) || tasks.workspaceIds.length === 0 || tasks.workspaceIds.length > 100 ||
          tasks.workspaceIds.some(id => typeof id !== "string" || !id.trim() || id.length > 256 || /[\r\n]/.test(id)) ||
          new Set(tasks.workspaceIds).size !== tasks.workspaceIds.length ||
          (tasks.intervalMs !== undefined && (!Number.isInteger(tasks.intervalMs) || tasks.intervalMs < 100 || tasks.intervalMs > 60000))) throw new Error();
      const main = new URL(config.databaseUrl), model = new URL(models.databaseUrl);
      if (main.hostname !== model.hostname || (main.port || "5432") !== (model.port || "5432") || main.pathname !== model.pathname || config.databaseTlsCa !== models.databaseTlsCa) throw new Error();
    } catch { throw new Error("INVALID_EPISODE_TASK_CONFIG"); }
  }
  if (config.storyTasks !== undefined && config.storyTasks.enabled !== false) {
    try {
      const tasks = config.storyTasks, models = config.modelSettings;
      if (tasks.enabled !== true || models?.enabled !== true || models.routes.deepseek !== "mainland" ||
          !Array.isArray(tasks.workspaceIds) || tasks.workspaceIds.length === 0 || tasks.workspaceIds.length > 100 ||
          tasks.workspaceIds.some(id => typeof id !== "string" || !id.trim() || id.length > 256 || /[\r\n]/.test(id)) ||
          new Set(tasks.workspaceIds).size !== tasks.workspaceIds.length ||
          (tasks.intervalMs !== undefined && (!Number.isInteger(tasks.intervalMs) || tasks.intervalMs < 100 || tasks.intervalMs > 60000))) throw new Error();
      const main = new URL(config.databaseUrl), model = new URL(models.databaseUrl);
      if (main.hostname !== model.hostname || (main.port || "5432") !== (model.port || "5432") || main.pathname !== model.pathname || config.databaseTlsCa !== models.databaseTlsCa) throw new Error();
    } catch { throw new Error("INVALID_STORY_TASK_CONFIG"); }
  }
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 20,
    ssl: { ca: config.databaseTlsCa, rejectUnauthorized: true },
  });
  const identityRepository = new PostgresIdentityRepository(pool);
  const sessions = new HmacSessionManager({
    secret: config.sessionSecret,
    resolveActor: (userId) => identityRepository.findActorByUserId(userId),
  });
  const identity = new IdentityService({
    repository: identityRepository,
    challengeStore: new PostgresLoginChallengeStore(pool),
    rateLimiter: new PostgresLoginRateLimiter(pool),
    phoneProvider: new HttpPhoneVerificationProvider({ endpoint: config.smsEndpoint, apiKey: config.smsApiKey }),
    wechatProvider: new WechatWebsiteLoginProvider({
      appId: config.wechatAppId,
      appSecret: config.wechatAppSecret,
      redirectUri: config.wechatRedirectUri,
    }),
    sessionIssuer: sessions,
    idGenerator: (prefix) => `${prefix}_${randomUUID()}`,
    clock: () => new Date(),
    wechatRedirectUri: config.wechatRedirectUri,
  });
  const projectRepository = new PostgresProjectImportRepository(pool);
  const projectImport = new ProjectImportService({
    repository: projectRepository,
    complianceScanner: new HttpComplianceScanner({
      endpoint: config.complianceEndpoint,
      apiKey: config.complianceApiKey,
    }),
    documentTextExtractor: new MammothDocxTextExtractor(),
    idGenerator: (prefix) => `${prefix}_${randomUUID()}`,
    clock: () => new Date(),
  });
  const storyKnowledge = new StoryKnowledgeService({
    repository: new PostgresStoryKnowledgeRepository(pool),
    sourceReader: {
      async findSourceVersion(actor, projectId, chapterId, sourceVersionId) {
        const chapter = await projectRepository.findChapter(actor, projectId, chapterId);
        const version = chapter?.versions.find(({ id }) => id === sourceVersionId);
        return version ? { id: version.id, fragmentIds: version.fragments.map(({ id }) => id) } : null;
      },
    },
    projectAccessReader: projectRepository,
    idGenerator: () => `skv_${randomUUID()}`,
    clock: () => new Date(),
  });
  const projectModule = ProjectImportApiModule.register({
      identity,
      sessionVerifier: sessions,
      projectImport,
      storyKnowledge,
      wechatRedirectUri: config.wechatRedirectUri,
      deviceTokens: new HmacDeviceTokenService(config.deviceTokenSecret),
      clientIpResolver: new ForwardedClientIpResolver(config.trustedProxyHops),
    });
  let modelPool: Pool | undefined;
  let worker: StoryKnowledgeTaskWorker | undefined;
  let episodeWorker: StoryKnowledgeTaskWorker | undefined;
  let apiModule: DynamicModule = projectModule;
  if (modelKey && config.modelSettings?.enabled === true) {
    const value = config.modelSettings;
    modelPool = new Pool({ connectionString: value.databaseUrl, max: 10,
      ssl: { ca: value.databaseTlsCa, rejectUnauthorized: true }, options: "-c role=novel_app", connectionTimeoutMillis: 5000 });
    const settings = new WorkspaceModelSettings({
      repository: new PostgresModelSettingsRepository(modelPool), access: new PostgresWorkspaceModelAccess(modelPool),
      encryptionKey: modelKey, idGenerator: () => `mc_${randomUUID()}`,
      probe: new NativeModelDirectoryProbe({ routes: value.routes, ...(ports.modelFetch ? { fetch: ports.modelFetch } : {}) }),
    });
    const restrictedPool = modelPool;
    apiModule = { module: ProductionApiModule, imports: [projectModule, ModelSettingsApiModule.register({
      sessionVerifier: sessions, settings, rateLimiter: new PostgresModelRateLimiter(modelPool),
    })], providers: [{ provide: "MODEL_DATABASE_STARTUP_CHECK", useValue: {
      async onModuleInit() {
        try {
          const result = await restrictedPool.query(`select current_user='novel_app' as restricted,
            not r.rolsuper and not r.rolcreaterole and not r.rolcreatedb and not r.rolbypassrls
            and not exists(select 1 from pg_roles inherited where inherited.rolname not in (session_user,'novel_app')
              and pg_has_role(session_user,inherited.oid,'MEMBER')) as safe_login
            from pg_roles r where r.rolname=session_user`);
          if (!result.rows[0]?.restricted || !result.rows[0]?.safe_login) throw new Error();
          const tables = await restrictedPool.query(`select bool_and(
            not exists(select 1 from unnest(string_to_array(privileges,',')) required(privilege)
              where not has_table_privilege(current_user,name,privilege))
            and not pg_has_role(session_user,c.relowner,'MEMBER')) as ready
            from (values ('public.model_settings_heads','SELECT,INSERT,UPDATE'),
              ('public.model_settings_versions','SELECT,INSERT'),('public.model_settings_audit','SELECT,INSERT'),
              ('public.workspace_model_members','SELECT'),('public.workspace_model_entitlements','SELECT')) prerequisites(name,privileges)
            join pg_class c on c.oid=to_regclass(name)
            having count(*)=5`);
          if (!tables.rows[0]?.ready) throw new Error();
          const privilege = await restrictedPool.query("select has_function_privilege(current_user,'public.consume_model_rate(text,text)','EXECUTE') as allowed");
          if (!privilege.rows[0]?.allowed) throw new Error();
        } catch { throw new Error("MODEL_DATABASE_NOT_READY"); }
      },
    } }] };
    if (config.storyTasks?.enabled === true) {
      const taskConfig = config.storyTasks;
      const taskProjects = new PostgresProjectImportRepository(restrictedPool);
      const policy = new PostgresGenerationPolicyReader(restrictedPool);
      const taskKnowledge = new StoryKnowledgeService({ repository: new PostgresStoryKnowledgeRepository(restrictedPool), projectAccessReader: taskProjects,
        sourceReader: { async findSourceVersion(actor, projectId, chapterId, sourceVersionId) {
          const chapter = await taskProjects.findChapter(actor, projectId, chapterId);
          const source = chapter?.versions.find(version => version.id === sourceVersionId);
          return source ? { id: source.id, fragmentIds: source.fragments.map(fragment => fragment.id) } : null;
        } }, idGenerator: () => `skv_${randomUUID()}`, clock: () => new Date() });
      const repository = new PostgresModelTaskRepository(restrictedPool);
      const retryPlanning = { projects: taskProjects, storyKnowledge: taskKnowledge };
      const tasks = new ModelTaskService({ settings, repository, contextReader: new StoryKnowledgeTaskContext(taskProjects, new StoryKnowledgeRetryPlanner(retryPlanning)),
        storyAdmission: { workspaceIds: taskConfig.workspaceIds, providerIds: ["deepseek"] },
        generationPolicy: policy,
        idGenerator: () => `job_${randomUUID()}` });
      const executor = new StoryKnowledgeTaskExecutor({ tasks, projects: taskProjects, storyKnowledge: taskKnowledge,
        model: new DeepSeekStoryKnowledgeModel(ports.modelFetch ? { fetch: ports.modelFetch } : {}) });
      worker = new StoryKnowledgeTaskWorker({ dispatcher: new StoryKnowledgeTaskDispatcher({ repository, executor }),
        enabled: true, workspaceIds: taskConfig.workspaceIds, ...(taskConfig.intervalMs ? { intervalMs: taskConfig.intervalMs } : {}) });
      apiModule.imports!.push(StoryKnowledgeTaskApiModule.register({ sessionVerifier: sessions, tasks, retryPlanning,rateLimiter: new PostgresModelRateLimiter(restrictedPool) }), StoryKnowledgeWorkerModule.forWorker(worker));
      apiModule.providers!.push({ provide: "STORY_TASK_DATABASE_STARTUP_CHECK", useValue: {
        onModuleInit: () => assertStoryTaskDatabase(restrictedPool, taskConfig.workspaceIds),
      } });
    }
    if (config.episodeTasks?.enabled === true) {
      const taskConfig = config.episodeTasks;
      const projects = new PostgresProjectImportRepository(restrictedPool);
      const knowledge = new StoryKnowledgeService({ repository: new PostgresStoryKnowledgeRepository(restrictedPool), projectAccessReader: projects,
        sourceReader: { async findSourceVersion(actor, projectId, chapterId, sourceVersionId) {
          const chapter = await projects.findChapter(actor,projectId,chapterId);
          const source = chapter?.versions.find(version => version.id === sourceVersionId);
          return source ? { id: source.id,fragmentIds: source.fragments.map(fragment => fragment.id) } : null;
        } },idGenerator: () => `skv_${randomUUID()}`,clock: () => new Date() });
      const script = new ScriptService({ repository: new PostgresScriptRepository(restrictedPool),
        upstreamReader: new EpisodePlanUpstreamReader(projects,knowledge),accessReader: projects,
        idGenerator: () => `epv_${randomUUID()}`,clock: () => new Date() });
      const repository = new PostgresModelTaskRepository(restrictedPool);
      const tasks = new ModelTaskService({ settings,repository,contextReader: new EpisodePlanTaskContext(projects,knowledge),
        episodeAdmission: { workspaceIds: taskConfig.workspaceIds,providerIds: ["deepseek"] },
        generationPolicy: new PostgresGenerationPolicyReader(restrictedPool),idGenerator: () => `job_${randomUUID()}` });
      const executor = new EpisodePlanTaskExecutor({ tasks,projects,knowledge,script,
        model: new DeepSeekEpisodePlanModel(ports.modelFetch ? { fetch: ports.modelFetch } : {}) });
      episodeWorker = new StoryKnowledgeTaskWorker({ dispatcher: new EpisodePlanTaskDispatcher({ repository,executor }),
        enabled: true,workspaceIds: taskConfig.workspaceIds,...(taskConfig.intervalMs ? { intervalMs: taskConfig.intervalMs } : {}) });
      apiModule.imports!.push(EpisodePlanTaskApiModule.register({ sessionVerifier: sessions,tasks,rateLimiter: new PostgresModelRateLimiter(restrictedPool) }),
        EpisodePlanApiModule.register({ sessionVerifier: sessions,script,projects,knowledge }),EpisodePlanWorkerModule.forWorker(episodeWorker));
      apiModule.providers!.push({ provide: "EPISODE_TASK_DATABASE_STARTUP_CHECK",useValue: {
        onModuleInit: () => assertEpisodeTaskDatabase(restrictedPool,taskConfig.workspaceIds),
      } });
    }
  }
  let closing: Promise<void> | undefined;
  return {
    module: apiModule,
    close: () => closing ??= (async () => {
      try { await Promise.allSettled([worker?.stop(),episodeWorker?.stop()]); }
      finally { await Promise.all([pool.end(), modelPool?.end()]); }
    })(),
  };
}

function assertProductionConfig(config: ProductionApiConfig): void {
  const strings = Object.entries(config).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  for (const [name, value] of strings) {
    if (!value.trim()) throw new Error(`${name} is required`);
  }
  assertDatabaseUrl(config.databaseUrl);
  new ForwardedClientIpResolver(config.trustedProxyHops);
}

function assertDatabaseUrl(value: string): void {
  const databaseUrl = new URL(value);
  if (databaseUrl.protocol !== "postgres:" && databaseUrl.protocol !== "postgresql:") {
    throw new Error("databaseUrl must use PostgreSQL");
  }
  for (const parameter of ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert", "options"]) {
    if (databaseUrl.searchParams.has(parameter)) {
      throw new Error(`databaseUrl must not override managed TLS option ${parameter}`);
    }
  }
}
