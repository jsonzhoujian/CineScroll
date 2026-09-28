import assert from "node:assert/strict";
import test from "node:test";
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import request from "supertest";

import {
  HmacSessionManager,
  IdentityService,
  InMemoryIdentityRepository,
  InMemoryLoginChallengeStore,
  InMemoryLoginRateLimiter,
} from "@novel-adaptation/identity";
import { IdentityProviderError } from "@novel-adaptation/identity/providers";
import { InMemoryProjectImportRepository, ProjectImportService } from "@novel-adaptation/project-import";
import {
  ForwardedClientIpResolver,
  HmacDeviceTokenService,
  ProjectImportApiModule,
} from "../src/index.ts";

test("客户端 IP 只信任配置跳数内的代理链", () => {
  const resolver = new ForwardedClientIpResolver(1);
  assert.equal(resolver.resolve({
    headers: { "x-forwarded-for": "198.51.100.99, 203.0.113.8" },
    socket: { remoteAddress: "192.0.2.10" },
  }), "203.0.113.8");
  assert.equal(new ForwardedClientIpResolver(0).resolve({
    headers: { "x-forwarded-for": "198.51.100.99" },
    socket: { remoteAddress: "192.0.2.10" },
  }), "192.0.2.10");
});

test("手机号验证码登录签发的 Session 可直接创建项目", async () => {
  const fixture = await createAuthApi();
  try {
    const deviceToken = await issueDeviceToken(fixture.server);
    await request(fixture.server).post("/auth/phone/challenges")
      .set("x-device-token", `${deviceToken}x`).send({ phone: "13800138000" }).expect(400);
    const challenge = await request(fixture.server).post("/auth/phone/challenges")
      .set("x-device-token", deviceToken).send({ phone: "13800138000", ipAddress: "198.51.100.99" }).expect(201);
    assert.match(challenge.body.challengeId, /^chlg_/);

    const login = await request(fixture.server).post("/auth/phone/verify")
      .set("x-device-token", deviceToken)
      .send({ challengeId: challenge.body.challengeId, phone: "13800138000", code: "123456" }).expect(201);
    assert.match(login.body.sessionToken, /^v1\./);

    const project = await request(fixture.server).post("/projects")
      .set("authorization", `Bearer ${login.body.sessionToken}`)
      .send({ title: "人间剑令", rightsDeclared: true, aspectRatio: "9:16", targetDurationSeconds: 180, narrativeMode: "narration" })
      .expect(201);
    assert.equal(project.body.ownerUserId, login.body.actor.userId);
  } finally { await fixture.close(); }
});

test("微信扫码 state 只能使用一次，且绑定后登录回到原手机号账号", async () => {
  const fixture = await createAuthApi();
  try {
    const deviceToken = await issueDeviceToken(fixture.server);
    const phone = await request(fixture.server).post("/auth/phone/challenges")
      .set("x-device-token", deviceToken).send({ phone: "13800138000" }).expect(201);
    const phoneLogin = await request(fixture.server).post("/auth/phone/verify")
      .set("x-device-token", deviceToken)
      .send({ challengeId: phone.body.challengeId, phone: "13800138000", code: "123456" }).expect(201);

    const binding = await request(fixture.server).post("/auth/wechat/bind/start")
      .set("authorization", `Bearer ${phoneLogin.body.sessionToken}`).expect(201);
    const bound = await request(fixture.server).get("/auth/wechat/callback")
      .query({ code: "wechat-code", state: binding.body.state }).expect(200);
    assert.deepEqual(bound.body, { kind: "binding", bound: true });

    const started = await request(fixture.server).post("/auth/wechat/start").expect(201);
    const wechatLogin = await request(fixture.server).get("/auth/wechat/callback")
      .query({ code: "wechat-code", state: started.body.state }).expect(200);
    assert.deepEqual(wechatLogin.body.actor, phoneLogin.body.actor);
    await request(fixture.server).get("/auth/wechat/callback")
      .query({ code: "wechat-code", state: started.body.state }).expect(401);
  } finally { await fixture.close(); }
});

test("认证供应商故障返回稳定可重试错误且不泄露内部信息", async () => {
  const fixture = await createAuthApi({ providerUnavailable: true });
  try {
    const deviceToken = await issueDeviceToken(fixture.server);
    const response = await request(fixture.server).post("/auth/phone/challenges")
      .set("x-device-token", deviceToken).send({ phone: "13800138000" }).expect(503);
    assert.equal(response.body.code, "IDENTITY_PROVIDER_UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(response.body), /upstream-secret/);
  } finally { await fixture.close(); }
});

async function createAuthApi(options: { providerUnavailable?: boolean } = {}) {
  let id = 0;
  const repository = new InMemoryIdentityRepository();
  const sessions = new HmacSessionManager({
    secret: "0123456789abcdef0123456789abcdef",
    resolveActor: (userId) => repository.findActorByUserId(userId),
  });
  const identity = new IdentityService({
    repository,
    challengeStore: new InMemoryLoginChallengeStore(),
    rateLimiter: new InMemoryLoginRateLimiter(),
    phoneProvider: {
      async sendCode() {
        if (options.providerUnavailable) throw new IdentityProviderError();
        return { providerRequestId: "sms-1" };
      },
      async verifyCode(_phone, code) { return code === "123456"; },
    },
    wechatProvider: {
      authorizationUrl({ state }) { return `https://open.weixin.qq.com/connect/qrconnect?state=${state}`; },
      async exchangeCode() { return { openId: "wechat-open-1", unionId: "wechat-union-1" }; },
    },
    sessionIssuer: sessions,
    idGenerator: (prefix) => `${prefix}_${++id}`,
    clock: () => new Date("2026-09-28T00:00:00.000Z"),
    wechatRedirectUri: "https://app.example.cn/auth/wechat/callback",
  });
  const projects = new ProjectImportService({
    repository: new InMemoryProjectImportRepository(),
    complianceScanner: { async scan() { return { allowed: true }; } },
    idGenerator: (prefix) => `${prefix}_${++id}`,
    clock: () => new Date("2026-09-28T00:00:00.000Z"),
  });
  const moduleRef = await Test.createTestingModule({ imports: [ProjectImportApiModule.register({
    identity,
    sessionVerifier: sessions,
    projectImport: projects,
    wechatRedirectUri: "https://app.example.cn/auth/wechat/callback",
    deviceTokens: new HmacDeviceTokenService("abcdef0123456789abcdef0123456789"),
    clientIpResolver: new ForwardedClientIpResolver(0),
  })] }).compile();
  const app = moduleRef.createNestApplication();
  await app.listen(0, "127.0.0.1");
  return { server: app.getHttpServer(), close: () => app.close() };
}

async function issueDeviceToken(server: Parameters<typeof request>[0]): Promise<string> {
  const response = await request(server).post("/auth/device").expect(201);
  assert.match(response.body.deviceToken, /^v1\./);
  return response.body.deviceToken as string;
}
