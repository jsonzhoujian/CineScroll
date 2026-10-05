import assert from "node:assert/strict";
import test from "node:test";
import { createProductionApi } from "../src/production.ts";
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import request from "supertest";

const base = {
  databaseUrl: "postgresql://app@localhost/fixture", databaseTlsCa: "fixture-ca",
  sessionSecret: "0123456789abcdef0123456789abcdef", deviceTokenSecret: "abcdef0123456789abcdef0123456789",
  trustedProxyHops: 0, smsEndpoint: "https://sms.example/verify", smsApiKey: "fixture",
  wechatAppId: "fixture", wechatAppSecret: "fixture", wechatRedirectUri: "https://app.example/callback",
  complianceEndpoint: "https://compliance.example/scan", complianceApiKey: "fixture",
};

test("生产BYOK默认关闭；显式启用必须校验独立密钥、受限连接及区域", async () => {
  const disabled = createProductionApi(base);
  await disabled.close();
  const valid = { enabled: true as const, encryptionKeyBase64: Buffer.alloc(32, 7).toString("base64"), databaseUrl: "postgresql://model_app@localhost/fixture", databaseTlsCa: "fixture-ca", routes: { deepseek: "mainland" as const } };
  for (const modelSettings of [
    { ...valid, encryptionKeyBase64: "private-invalid-key" },
    { ...valid, encryptionKeyBase64: Buffer.from(base.sessionSecret).toString("base64") },
    { ...valid, databaseUrl: "https://private.example" },
    { ...valid, databaseUrl: "postgresql://model_app@localhost/fixture?sslmode=disable" },
    { ...valid, databaseTlsCa: "" },
    { ...valid, routes: { openai: "mainland" as const } },
    { ...valid, routes: { deepseek: "unknown" as const } },
    { ...valid, databaseUrl: "postgresql://model_app@localhost/fixture?options=-c%20role%3Dpostgres" },
  ]) {
    assert.throws(() => createProductionApi({ ...base, modelSettings }), { message: "INVALID_MODEL_SETTINGS_CONFIG" });
  }
  const enabled = createProductionApi({ ...base, modelSettings: valid });
  await enabled.close();
});

test("关闭BYOK不挂载路由；开启但数据库未就绪阻止应用初始化", async () => {
  const disabled = createProductionApi({ ...base, modelSettings: { enabled: false } });
  const ref = await Test.createTestingModule({ imports: [disabled.module] }).compile();
  const app = ref.createNestApplication();
  try {
    await app.listen(0, "127.0.0.1");
    await request(app.getHttpServer()).get("/workspace/model-settings").expect(404);
  } finally { await app.close(); await disabled.close(); }
  const enabled = createProductionApi({ ...base, modelSettings: {
    enabled: true, encryptionKeyBase64: Buffer.alloc(32, 7).toString("base64"),
    databaseUrl: "postgresql://model_app@127.0.0.1:1/fixture", databaseTlsCa: "fixture-ca", routes: { deepseek: "mainland" },
  } });
  const enabledRef = await Test.createTestingModule({ imports: [enabled.module] }).compile();
  const enabledApp = enabledRef.createNestApplication();
  try { await assert.rejects(() => enabledApp.init(), { message: "MODEL_DATABASE_NOT_READY" }); }
  finally { await enabledApp.close(); await enabled.close(); }
});
