import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceModelSettings, InMemoryModelSettingsRepository, MODEL_PROVIDERS } from "../src/model-settings.ts";

test("工作室负责人管理加密共享 Key，成员只查看脱敏配置", async () => {
  let owner = true;
  const repository = new InMemoryModelSettingsRepository();
  const service = new WorkspaceModelSettings({ repository, encryptionKey: new Uint8Array(32).fill(7),
    access: { async read() { return { owner, advanced: true }; } }, idGenerator: () => "config_1" });
  const actor = { userId: "owner", workspaceId: "studio" };
  const config = await service.configure(actor, { expectedVersionId: null, providerId: "deepseek", apiKey: "private-api-key" });
  assert.equal(config.keyMask, "••••••••");
  assert.equal(config.tested, false);
  assert.ok(!JSON.stringify(config).includes("private-api-key"));
  assert.ok(!JSON.stringify(await repository.find("studio")).includes("private-api-key"));
  owner = false;
  assert.deepEqual(await service.get(actor), config);
  await assert.rejects(() => service.configure(actor, { expectedVersionId: config.id, providerId: "openai", apiKey: "other-key" }), { code: "FORBIDDEN" });
  assert.equal(await service.get({ ...actor, workspaceId: "other" }), null);
  assert.ok(MODEL_PROVIDERS.some(({ id }) => id === "anthropic"));
  assert.ok(MODEL_PROVIDERS.some(({ id, kind }) => id === "openrouter" && kind === "aggregator"));
});

test("连接通过后成员按列表选模型，海外处理需负责人批准且任务配置保持固定", async () => {
  let sequence = 0;
  let owner = true;
  let advanced = true;
  let probeCalls = 0;
  const repository = new InMemoryModelSettingsRepository();
  const service = new WorkspaceModelSettings({ repository, encryptionKey: new Uint8Array(32).fill(8),
    access: { async read() { return { owner, advanced }; } }, idGenerator: () => `config_${++sequence}`,
    probe: { processingRegion() { return "overseas"; }, async test({ apiKey }) { probeCalls++; assert.equal(apiKey, "secret"); return { modelIds: ["model-a", "model-b"], processingRegion: "overseas" }; } },
  });
  const actor = { userId: "owner", workspaceId: "studio" };
  advanced = false;
  await assert.rejects(() => service.configure(actor, { expectedVersionId: null, providerId: "openai", apiKey: "secret" }), { code: "FORBIDDEN" });
  advanced = true;
  const config = await service.configure(actor, { expectedVersionId: null, providerId: "openai", apiKey: "secret" });
  await assert.rejects(() => service.selectForTask(actor, config.id, "model-a"), { code: "NOT_READY" });
  await assert.rejects(() => service.testConnection(actor, config.id), { code: "FORBIDDEN" });
  assert.equal(probeCalls, 0);
  const tested = await service.testConnection(actor, config.id, true);
  assert.deepEqual(tested.availableModelIds, ["model-a", "model-b"]);
  owner = false;
  const pinned = await service.selectForTask(actor, tested.id, "model-a");
  assert.equal((await service.selectForTask(actor, tested.id, "model-b")).modelId, "model-b");
  await assert.rejects(() => service.testConnection(actor, tested.id, true), { code: "FORBIDDEN" });
  await assert.rejects(() => service.selectForTask(actor, tested.id, "unknown"), { code: "NOT_READY" });
  owner = true;
  await service.configure(actor, { expectedVersionId: tested.id, providerId: "deepseek", apiKey: "new-secret" });
  assert.equal(pinned.configurationVersionId, tested.id);
  assert.equal(pinned.providerId, "openai");
  await assert.rejects(() => service.selectForTask(actor, tested.id, "model-a"), { code: "VERSION_CONFLICT" });
});

test("并发配置只保存一个版本，复制密文到其他工作室无法解密", async () => {
  let sequence = 0;
  let calls = 0;
  const repository = new InMemoryModelSettingsRepository();
  const service = new WorkspaceModelSettings({ repository, encryptionKey: new Uint8Array(32).fill(9),
    access: { async read() { return { owner: true, advanced: true }; } }, idGenerator: () => `v_${++sequence}`,
    probe: { processingRegion() { return "mainland"; }, async test() { calls++; return { modelIds: ["m"], processingRegion: "mainland" }; } },
  });
  const actor = { userId: "owner", workspaceId: "studio" };
  const results = await Promise.allSettled(["key-a", "key-b"].map((apiKey) => service.configure(actor, { expectedVersionId: null, providerId: "deepseek", apiKey })));
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  const failed = results.find((item) => item.status === "rejected");
  assert.equal(failed?.status === "rejected" ? failed.reason.code : null, "VERSION_CONFLICT");
  const stored = await repository.find("studio"); assert.ok(stored);
  await repository.save({ ...stored, workspaceId: "other" }, null);
  await assert.rejects(() => service.testConnection({ ...actor, workspaceId: "other" }, stored.id), { code: "PROVIDER_UNAVAILABLE" });
  assert.equal(calls, 0);
});
