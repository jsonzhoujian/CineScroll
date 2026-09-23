import assert from "node:assert/strict";
import test from "node:test";

import {
  IdentityService,
  InMemoryIdentityRepository,
  InMemoryLoginChallengeStore,
  InMemoryLoginRateLimiter,
} from "../src/index.ts";

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
    ...overrides,
  });
}
