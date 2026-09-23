import assert from "node:assert/strict";
import test from "node:test";

import { HttpComplianceScanner } from "../src/http-compliance-scanner.ts";

test("生产合规网关把供应商结果归一化为允许或拒绝", async () => {
  const responses = [
    new Response(JSON.stringify({ allowed: true, requestId: "req-allow" }), { status: 200 }),
    new Response(JSON.stringify({ allowed: false, reason: "命中违法内容", requestId: "req-reject" }), { status: 200 }),
  ];
  const scanner = new HttpComplianceScanner({
    endpoint: "https://moderation.internal/v1/scan",
    apiKey: "secret",
    fetch: async () => responses.shift()!,
  });

  assert.deepEqual(await scanner.scan("普通文本"), { allowed: true, providerRequestId: "req-allow" });
  assert.deepEqual(await scanner.scan("受限文本"), {
    allowed: false,
    reason: "命中违法内容",
    providerRequestId: "req-reject",
  });
});

test("生产合规网关用稳定错误隐藏供应商响应内容", async () => {
  const scanner = new HttpComplianceScanner({
    endpoint: "https://moderation.internal/v1/scan",
    apiKey: "secret",
    fetch: async () => new Response("供应商内部敏感信息", { status: 503 }),
  });

  await assert.rejects(() => scanner.scan("待检测文本"), {
    name: "ComplianceProviderError",
    code: "PROVIDER_UNAVAILABLE",
    message: "内容合规服务暂不可用",
  });
});

test("生产合规网关超时后中止请求并返回可重试错误", async () => {
  let aborted = false;
  const scanner = new HttpComplianceScanner({
    endpoint: "https://moderation.internal/v1/scan",
    apiKey: "secret",
    timeoutMs: 10,
    fetch: async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(init.signal!.reason);
      });
    }),
  });

  await assert.rejects(() => scanner.scan("待检测文本"), { code: "PROVIDER_UNAVAILABLE" });
  assert.equal(aborted, true);
});

test("生产合规网关拒绝不安全或不完整的配置", () => {
  assert.throws(() => new HttpComplianceScanner({
    endpoint: "http://moderation.internal/v1/scan", apiKey: "secret",
  }), /HTTPS/);
  assert.throws(() => new HttpComplianceScanner({
    endpoint: "https://moderation.internal/v1/scan", apiKey: " ",
  }), /API key/);
  assert.throws(() => new HttpComplianceScanner({
    endpoint: "https://moderation.internal/v1/scan", apiKey: "secret", timeoutMs: 0,
  }), /timeout/);
});
