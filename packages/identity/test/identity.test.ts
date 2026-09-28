import assert from "node:assert/strict";
import test from "node:test";

import {
  HmacSessionManager,
  IdentityService,
  InMemoryIdentityRepository,
  InMemoryLoginChallengeStore,
  InMemoryLoginRateLimiter,
} from "../src/index.ts";

test("签名 Session 可还原 Actor，并拒绝篡改或过期 token", async () => {
  let now = new Date("2026-09-28T00:00:00.000Z");
  let resolvedActor: { userId: string; workspaceId: string } | null = { userId: "usr_1", workspaceId: "wsp_1" };
  const sessions = new HmacSessionManager({
    secret: "0123456789abcdef0123456789abcdef",
    clock: () => now,
    ttlMs: 60_000,
    resolveActor: async () => resolvedActor,
  });
  const actor = { userId: "usr_1", workspaceId: "wsp_1" };
  const token = await sessions.issue(actor.userId, actor.workspaceId);
  assert.deepEqual(await sessions.verify(token), actor);

  await assert.rejects(() => sessions.verify(`${token}x`), { code: "UNAUTHENTICATED" });
  resolvedActor = null;
  await assert.rejects(() => sessions.verify(token), { code: "UNAUTHENTICATED" });
  resolvedActor = actor;
  now = new Date("2026-09-28T00:01:01.000Z");
  await assert.rejects(() => sessions.verify(token), { code: "UNAUTHENTICATED" });
});

test("大陆手机号验证码核验成功后创建账号并签发会话", async () => {
  const sent: string[] = [];
  const service = createService({
    phoneProvider: {
      async sendCode(phone: string) { sent.push(phone); return { providerRequestId: "sms_req_1" }; },
      async verifyCode(phone: string, code: string) { return phone === "+8613800138000" && code === "123456"; },
    },
  });

  const challenge = await service.requestPhoneCode({
    phone: "13800138000", ipAddress: "203.0.113.8", deviceId: "device-1",
  });
  assert.deepEqual(sent, ["+8613800138000"]);
  assert.equal(challenge.providerRequestId, "sms_req_1");

  const login = await service.verifyPhoneCode({
    challengeId: challenge.challengeId,
    phone: "13800138000",
    code: "123456",
    ipAddress: "203.0.113.8",
    deviceId: "device-1",
  });
  assert.match(login.actor.userId, /^usr_/);
  assert.match(login.actor.workspaceId, /^wsp_/);
  assert.equal(login.sessionToken, `session_${login.actor.userId}`);
});

test("微信扫码回调校验一次性 state 后绑定账号并签发会话", async () => {
  const exchanged: Array<{ code: string; redirectUri: string }> = [];
  const service = createService({
    wechatProvider: {
      authorizationUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
        return `https://open.weixin.qq.com/connect/qrconnect?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;
      },
      async exchangeCode(input: { code: string; redirectUri: string }) {
        exchanged.push(input);
        return { openId: "openid-studio", unionId: "unionid-studio" };
      },
    },
  });
  const redirectUri = "https://app.example.cn/auth/wechat/callback";
  const started = await service.beginWechatLogin({ redirectUri });
  assert.match(started.authorizationUrl, /^https:\/\/open\.weixin\.qq\.com\/connect\/qrconnect/);

  const login = await service.completeWechatLogin({ code: "oauth-code", state: started.state, redirectUri });
  assert.deepEqual(exchanged, [{ code: "oauth-code", redirectUri }]);
  assert.match(login.actor.userId, /^usr_/);
  await assert.rejects(
    () => service.completeWechatLogin({ code: "replay", state: started.state, redirectUri }),
    { code: "INVALID_OAUTH_STATE" },
  );
});

test("已登录手机号账号可以绑定微信而不创建第二个账号", async () => {
  const repository = new InMemoryIdentityRepository();
  const service = createService({ repository });
  const phone = await service.requestPhoneCode({ phone: "13800138000", ipAddress: "203.0.113.8", deviceId: "d1" });
  const login = await service.verifyPhoneCode({
    challengeId: phone.challengeId, phone: "13800138000", code: "123456",
    ipAddress: "203.0.113.8", deviceId: "d1",
  });
  const binding = await service.beginWechatBinding(login.actor);
  await assert.rejects(
    () => service.completeWechatLogin({
      code: "oauth-code", state: binding.state, redirectUri: "https://app.example.cn/auth/wechat/callback",
    }),
    { code: "INVALID_OAUTH_STATE" },
  );
  await service.completeWechatBinding({ code: "oauth-code", state: binding.state });
  const wechat = await service.beginWechatLogin({ redirectUri: "https://app.example.cn/auth/wechat/callback" });
  const wechatLogin = await service.completeWechatLogin({
    code: "oauth-code", state: wechat.state, redirectUri: "https://app.example.cn/auth/wechat/callback",
  });
  assert.deepEqual(wechatLogin.actor, login.actor);
});

test("微信 openId 与 unionId 分属不同账号时拒绝登录", async () => {
  const repository = new InMemoryIdentityRepository();
  const first = await repository.findOrCreateByPhone("+8613800138000", () => ({
    userId: "usr_1", workspaceId: "wsp_1", phone: "+8613800138000",
  }));
  const second = await repository.findOrCreateByPhone("+8613900139000", () => ({
    userId: "usr_2", workspaceId: "wsp_2", phone: "+8613900139000",
  }));
  await repository.bindWechat(first, { openId: "open-1", unionId: "union-1" });
  await repository.bindWechat(second, { openId: "open-2", unionId: "union-2" });
  await assert.rejects(
    () => repository.findOrCreateByWechat({ openId: "open-1", unionId: "union-2" }, () => ({
      userId: "usr_3", workspaceId: "wsp_3", wechatOpenId: "open-1", wechatUnionId: "union-2",
    })),
    { code: "IDENTITY_ALREADY_BOUND" },
  );
});

test("OAuth state 默认使用独立高熵随机值", async () => {
  const service = createService();
  const first = await service.beginWechatLogin({ redirectUri: "https://app.example.cn/auth/wechat/callback" });
  const second = await service.beginWechatLogin({ redirectUri: "https://app.example.cn/auth/wechat/callback" });
  assert.notEqual(first.state, second.state);
  assert.ok(first.state.length >= 43);
});

test("手机号验证码按手机号、IP 和设备限流且被拒请求不发送短信", async () => {
  let deliveries = 0;
  const service = createService({
    rateLimiter: new InMemoryLoginRateLimiter({ phoneLimit: 2, ipLimit: 10, deviceLimit: 10 }),
    phoneProvider: {
      async sendCode() { deliveries += 1; return {}; },
      async verifyCode() { return true; },
    },
  });
  const input = { phone: "13800138000", ipAddress: "203.0.113.8", deviceId: "device-1" };
  await service.requestPhoneCode(input);
  await service.requestPhoneCode(input);
  await assert.rejects(() => service.requestPhoneCode(input), { code: "RATE_LIMITED" });
  assert.equal(deliveries, 2);
});

test("限流器分别约束 IP、设备并在窗口结束后恢复", async () => {
  const now = new Date("2026-09-23T00:00:00.000Z");
  const byIp = new InMemoryLoginRateLimiter({ phoneLimit: 10, ipLimit: 1, deviceLimit: 10, windowMs: 1_000 });
  assert.equal((await byIp.consume({ phone: "+8613800138000", ipAddress: "203.0.113.8", deviceId: "d1", action: "send", now })).allowed, true);
  assert.equal((await byIp.consume({ phone: "+8613900139000", ipAddress: "203.0.113.8", deviceId: "d2", action: "send", now })).allowed, false);

  const byDevice = new InMemoryLoginRateLimiter({ phoneLimit: 10, ipLimit: 10, deviceLimit: 1, windowMs: 1_000 });
  assert.equal((await byDevice.consume({ phone: "+8613800138000", ipAddress: "203.0.113.8", deviceId: "shared", action: "send", now })).allowed, true);
  assert.equal((await byDevice.consume({ phone: "+8613900139000", ipAddress: "203.0.113.9", deviceId: "shared", action: "send", now })).allowed, false);
  assert.equal((await byDevice.consume({ phone: "+8613900139000", ipAddress: "203.0.113.9", deviceId: "shared", action: "send", now: new Date(now.getTime() + 1_001) })).allowed, true);
});

function createService(overrides: Record<string, unknown> = {}) {
  let id = 0;
  return new IdentityService({
    repository: new InMemoryIdentityRepository(),
    challengeStore: new InMemoryLoginChallengeStore(),
    rateLimiter: new InMemoryLoginRateLimiter(),
    phoneProvider: {
      async sendCode() { return {}; },
      async verifyCode() { return true; },
    },
    wechatProvider: {
      authorizationUrl() { return "https://open.weixin.qq.com/connect/qrconnect"; },
      async exchangeCode() { return { openId: "openid-1" }; },
    },
    sessionIssuer: { async issue(userId: string) { return `session_${userId}`; } },
    idGenerator: (prefix: string) => `${prefix}_${++id}`,
    clock: () => new Date("2026-09-23T00:00:00.000Z"),
    wechatRedirectUri: "https://app.example.cn/auth/wechat/callback",
    ...overrides,
  });
}
