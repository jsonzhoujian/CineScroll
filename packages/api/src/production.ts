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
  const projectImport = new ProjectImportService({
    repository: new PostgresProjectImportRepository(pool),
    complianceScanner: new HttpComplianceScanner({
      endpoint: config.complianceEndpoint,
      apiKey: config.complianceApiKey,
    }),
    documentTextExtractor: new MammothDocxTextExtractor(),
    idGenerator: (prefix) => `${prefix}_${randomUUID()}`,
    clock: () => new Date(),
  });
  return {
    module: ProjectImportApiModule.register({
      identity,
      sessionVerifier: sessions,
      projectImport,
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
