import { randomUUID } from "node:crypto";
import { Pool } from "pg";

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

export function createProductionApi(config: ProductionApiConfig) {
  assertProductionConfig(config);
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
  return {
    module: ProjectImportApiModule.register({
      identity,
      sessionVerifier: sessions,
      projectImport,
      storyKnowledge,
      wechatRedirectUri: config.wechatRedirectUri,
      deviceTokens: new HmacDeviceTokenService(config.deviceTokenSecret),
      clientIpResolver: new ForwardedClientIpResolver(config.trustedProxyHops),
    }),
    close: () => pool.end(),
  };
}

function assertProductionConfig(config: ProductionApiConfig): void {
  const strings = Object.entries(config).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  for (const [name, value] of strings) {
    if (!value.trim()) throw new Error(`${name} is required`);
  }
  const databaseUrl = new URL(config.databaseUrl);
  if (databaseUrl.protocol !== "postgres:" && databaseUrl.protocol !== "postgresql:") {
    throw new Error("databaseUrl must use PostgreSQL");
  }
  for (const parameter of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) {
    if (databaseUrl.searchParams.has(parameter)) {
      throw new Error(`databaseUrl must not override managed TLS option ${parameter}`);
    }
  }
  new ForwardedClientIpResolver(config.trustedProxyHops);
}
