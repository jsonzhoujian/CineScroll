import assert from "node:assert/strict";
import test from "node:test";

import { HttpPhoneVerificationProvider, WechatWebsiteLoginProvider } from "../src/providers.ts";

test("短信验证码网关发送和核验结果使用统一契约", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const responses = [
    new Response(JSON.stringify({ requestId: "sms-1" }), { status: 200 }),
    new Response(JSON.stringify({ valid: true }), { status: 200 }),
  ];
  const provider = new HttpPhoneVerificationProvider({
    endpoint: "https://sms.internal/v1",
    apiKey: "secret",
    fetch: async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return responses.shift()!;
    },
  });

  assert.deepEqual(await provider.sendCode("+8613800138000"), { providerRequestId: "sms-1" });
  assert.equal(await provider.verifyCode("+8613800138000", "123456"), true);
  assert.deepEqual(requests, [
    { url: "https://sms.internal/v1/send", body: { phone: "+8613800138000" } },
    { url: "https://sms.internal/v1/verify", body: { phone: "+8613800138000", code: "123456" } },
  ]);
});

test("微信网站扫码适配器生成授权地址并在服务端交换身份", async () => {
  let tokenUrl = "";
  const provider = new WechatWebsiteLoginProvider({
    appId: "wx-app-id",
    appSecret: "wx-secret",
    fetch: async (input) => {
      tokenUrl = String(input);
      return new Response(JSON.stringify({ openid: "openid-1", unionid: "unionid-1" }), { status: 200 });
    },
  });
  const redirectUri = "https://app.example.cn/auth/wechat/callback";
  const authorizationUrl = provider.authorizationUrl({ state: "state-1", redirectUri });
  assert.match(authorizationUrl, /^https:\/\/open\.weixin\.qq\.com\/connect\/qrconnect\?/);
  assert.match(authorizationUrl, /scope=snsapi_login/);
  assert.match(authorizationUrl, /state=state-1/);

  assert.deepEqual(await provider.exchangeCode({ code: "oauth-code", redirectUri }), {
    openId: "openid-1", unionId: "unionid-1",
  });
  const exchange = new URL(tokenUrl);
  assert.equal(exchange.hostname, "api.weixin.qq.com");
  assert.equal(exchange.searchParams.get("appid"), "wx-app-id");
  assert.equal(exchange.searchParams.get("code"), "oauth-code");
});
