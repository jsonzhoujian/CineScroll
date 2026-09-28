import assert from "node:assert/strict";
import test from "node:test";

import { ApiClient } from "../src/lib/api.ts";
import { expectedWechatLoginMessage, isTrustedWechatAuthorizationUrl, isWechatLoginMessage, WECHAT_LOGIN_MESSAGE } from "../src/lib/wechat-flow.ts";

test("微信回调消息只接受完整的登录会话", () => {
  assert.equal(isWechatLoginMessage({ type: WECHAT_LOGIN_MESSAGE, state: "state-1", sessionToken: "token" }), true);
  assert.equal(isWechatLoginMessage({ type: WECHAT_LOGIN_MESSAGE, state: "state-1", sessionToken: "" }), false);
  assert.equal(isWechatLoginMessage({ type: "other", sessionToken: "token" }), false);
});

test("只打开微信官方 HTTPS 授权地址", () => {
  assert.equal(isTrustedWechatAuthorizationUrl("https://open.weixin.qq.com/connect/qrconnect?state=1"), true);
  assert.equal(isTrustedWechatAuthorizationUrl("http://open.weixin.qq.com/connect/qrconnect"), false);
  assert.equal(isTrustedWechatAuthorizationUrl("https://open.weixin.qq.com.evil.example/qr"), false);
  assert.equal(isTrustedWechatAuthorizationUrl("https://open.weixin.qq.com:444/connect/qrconnect"), false);
  assert.equal(isTrustedWechatAuthorizationUrl("https://open.weixin.qq.com/other"), false);
});

test("主窗口只接收预期弹窗、同源且 state 一致的登录消息", () => {
  const source = {};
  const data = { type: WECHAT_LOGIN_MESSAGE, state: "state-1", sessionToken: "token" };
  const expectation = { origin: "https://app.example.cn", source, state: "state-1" };
  assert.deepEqual(expectedWechatLoginMessage({ origin: expectation.origin, source, data }, expectation), data);
  assert.equal(expectedWechatLoginMessage({ origin: "https://evil.example", source, data }, expectation), null);
  assert.equal(expectedWechatLoginMessage({ origin: expectation.origin, source: {}, data }, expectation), null);
  assert.equal(expectedWechatLoginMessage({ origin: expectation.origin, source, data: { ...data, state: "stale" } }, expectation), null);
});

test("微信登录 API 契约从授权地址完成回调并接管 Session", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; authorization: string | null }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({ url, authorization: headers.get("authorization") });
    if (url.endsWith("/auth/wechat/start")) return Response.json({ state: "state-1", authorizationUrl: "https://open.weixin.qq.com/qr" });
    if (url.includes("/auth/wechat/callback")) return Response.json({ kind: "login", sessionToken: "session-1", actor: { userId: "u1", workspaceId: "w1" } });
    return Response.json({ id: "p1", title: "项目" });
  };
  try {
    const api = new ApiClient("https://api.example.cn");
    assert.equal((await api.beginWechatLogin()).authorizationUrl, "https://open.weixin.qq.com/qr");
    const login = await api.completeWechatLogin("code-1", "state-1");
    api.acceptSession(login.sessionToken);
    await api.createProject({ title: "项目", rightsDeclared: true, aspectRatio: "9:16", targetDurationSeconds: 180, narrativeMode: "narration" });
    assert.equal(requests.at(-1)?.authorization, "Bearer session-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
