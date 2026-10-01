import assert from "node:assert/strict";
import test from "node:test";
import { NativeModelDirectoryProbe } from "../src/provider-probe.ts";

test("DeepSeek 目录探测使用固定官方地址和鉴权，不发送作品或付费生成请求", async () => {
  const probe = new NativeModelDirectoryProbe({ routes: { deepseek: "mainland" }, fetch: async (url, init) => {
    assert.equal(String(url), "https://api.deepseek.com/models");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-secret");
    assert.equal(init?.body, undefined);
    return Response.json({ object: "list", data: [{ id: "model-a", object: "model" }, { id: "model-b", object: "model" }] });
  } });
  assert.deepEqual(await probe.test({ providerId: "deepseek", apiKey: "test-secret" }), { modelIds: ["model-a", "model-b"], processingRegion: "mainland" });
  assert.equal(probe.processingRegion("google"), "unknown");
  await assert.rejects(() => probe.test({ providerId: "google", apiKey: "secret" }), { code: "PROVIDER_UNAVAILABLE" });
});

test("探测拒绝未知区域、非法 Key、故障和畸形目录且不泄露上游信息", async () => {
  let calls = 0;
  const unknown = new NativeModelDirectoryProbe({ routes: {}, fetch: async () => { calls++; throw new Error("secret"); } });
  await assert.rejects(() => unknown.test({ providerId: "deepseek", apiKey: "secret" }), { code: "PROVIDER_UNAVAILABLE" });
  assert.equal(calls, 0);
  const known = new NativeModelDirectoryProbe({ routes: { deepseek: "mainland" }, fetch: async () => { calls++; throw new Error("secret"); } });
  for (const apiKey of [" ", "key\r\nvalue", "x".repeat(8193)]) {
    await assert.rejects(() => known.test({ providerId: "deepseek", apiKey }), { code: "PROVIDER_UNAVAILABLE" });
  }
  assert.equal(calls, 0);
  for (const response of [
    Response.json({ secret: "provider-secret" }, { status: 401 }),
    Response.json({ object: "list", data: [] }),
    Response.json({ object: "list", data: [{ id: "a", object: "model" }, { id: "a", object: "model" }] }),
    Response.json({ object: "list", data: [{ id: "a", object: "unknown" }] }),
    new Response("invalid-json", { headers: { "content-type": "application/json" } }),
    new Response("{}", { headers: { "content-type": "text/html" } }),
    new Response(new Uint8Array([255]), { headers: { "content-type": "application/json" } }),
    new Response("x".repeat(512_001), { headers: { "content-type": "application/json" } }),
  ]) {
    const probe = new NativeModelDirectoryProbe({ routes: { deepseek: "mainland" }, fetch: async () => response });
    await assert.rejects(() => probe.test({ providerId: "deepseek", apiKey: "secret" }), { code: "PROVIDER_UNAVAILABLE", message: "PROVIDER_UNAVAILABLE" });
  }
});

test("读取目录响应流时超时会中止探测，错误响应会取消流", async () => {
  let cancelled = false;
  const rejected = new NativeModelDirectoryProbe({ routes: { deepseek: "mainland" }, fetch: async () =>
    new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 403 }) });
  await assert.rejects(() => rejected.test({ providerId: "deepseek", apiKey: "key" }), { code: "PROVIDER_UNAVAILABLE" });
  assert.equal(cancelled, true);
  const timeout = new NativeModelDirectoryProbe({ routes: { deepseek: "mainland" }, timeoutMs: 10, fetch: async (_url, init) => {
    return new Response(new ReadableStream({ start(controller) {
      const timer = setTimeout(() => controller.error(new Error("timeout not aborted")), 200);
      init?.signal?.addEventListener("abort", () => { clearTimeout(timer); controller.error(new Error("secret")); }, { once: true });
    } }), { headers: { "content-type": "application/json" } });
  } });
  await assert.rejects(() => timeout.test({ providerId: "deepseek", apiKey: "key" }), { code: "PROVIDER_UNAVAILABLE", message: "PROVIDER_UNAVAILABLE" });
});
