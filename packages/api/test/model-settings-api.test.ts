import assert from "node:assert/strict";
import test from "node:test";
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { HmacSessionManager } from "@novel-adaptation/identity";
import { InMemoryModelSettingsRepository, WorkspaceModelSettings } from "@novel-adaptation/script/model-settings";
import { ModelSettingsApiModule } from "../src/model-settings-api.ts";

test("超限返回429和重试时间，存储故障返回503且不写Key", async () => {
  const sessions = new HmacSessionManager({ secret: "0123456789abcdef0123456789abcdef", resolveActor: async () => ({ userId: "owner", workspaceId: "studio" }) });
  const settings = new WorkspaceModelSettings({ repository: new InMemoryModelSettingsRepository(), encryptionKey: new Uint8Array(32).fill(1), idGenerator: () => "v1", access: { read: async () => ({ owner: true, advanced: true }) } });
  let unavailable = false;
  const ref = await Test.createTestingModule({ imports: [ModelSettingsApiModule.register({ sessionVerifier: sessions, settings, rateLimiter: { consume: async (workspace, action) => {
    assert.equal(workspace, "studio"); assert.ok(action === "configure" || action === "test");
    if (unavailable) throw new Error("private-url");
    return { allowed: false, retryAfterSeconds: 42 };
  } } })] }).compile();
  const app = ref.createNestApplication(); await app.listen(0, "127.0.0.1");
  try {
    const http = request(app.getHttpServer()), authorization = `Bearer ${await sessions.issue("owner", "studio")}`;
    const body = { expectedVersionId: null, providerId: "deepseek", apiKey: "fixture-key" };
    const limited = await http.post("/workspace/model-settings").set("authorization", authorization).send(body).expect(429);
    assert.equal(limited.headers["retry-after"], "42"); assert.equal(limited.body.retryAfterSeconds, 42);
    await http.post("/workspace/model-settings/test").set("authorization", authorization).send({ expectedVersionId: "v1", allowNonMainland: false }).expect(429);
    unavailable = true;
    const failed = await http.post("/workspace/model-settings").set("authorization", authorization).send(body).expect(503);
    assert.equal(failed.body.code, "STORAGE_UNAVAILABLE"); assert.ok(!JSON.stringify(failed.body).includes("private-url"));
    assert.equal(await settings.get({ userId: "owner", workspaceId: "studio" }), null);
  } finally { await app.close(); }
});

test("未配置限流存储时模型写接口拒绝服务", async () => {
  const sessions = new HmacSessionManager({ secret: "0123456789abcdef0123456789abcdef", resolveActor: async () => ({ userId: "owner", workspaceId: "studio" }) });
  const settings = new WorkspaceModelSettings({ repository: new InMemoryModelSettingsRepository(), encryptionKey: new Uint8Array(32).fill(1), idGenerator: () => "v1", access: { read: async () => ({ owner: true, advanced: true }) } });
  const ref = await Test.createTestingModule({ imports: [ModelSettingsApiModule.register({ sessionVerifier: sessions, settings })] }).compile();
  const app = ref.createNestApplication(); await app.listen(0, "127.0.0.1");
  try {
    await request(app.getHttpServer()).post("/workspace/model-settings").set("authorization", `Bearer ${await sessions.issue("owner", "studio")}`).send({ expectedVersionId: null, providerId: "deepseek", apiKey: "fixture-key" }).expect(503);
    assert.equal(await settings.get({ userId: "owner", workspaceId: "studio" }), null);
  } finally { await app.close(); }
});

test("模型设置 API 只使用登录工作室，负责人保存 Key，成员仅脱敏读取", async () => {
  const sessions = new HmacSessionManager({ secret: "0123456789abcdef0123456789abcdef", resolveActor: async (userId) => ({ userId, workspaceId: userId === "other" ? "other" : "studio" }) });
  let id = 0;
  const repository = new InMemoryModelSettingsRepository();
  const settings = new WorkspaceModelSettings({ repository, encryptionKey: new Uint8Array(32).fill(1), idGenerator: () => `v${++id}`, access: { read: async (actor) => ({ owner: actor.userId === "owner", advanced: true }) } });
  const ref = await Test.createTestingModule({ imports: [ModelSettingsApiModule.register({ sessionVerifier: sessions, settings, rateLimiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0 }) } })] }).compile();
  const app = ref.createNestApplication(); await app.listen(0, "127.0.0.1");
  try {
    const http = request(app.getHttpServer());
    const body = { expectedVersionId: null, providerId: "deepseek", apiKey: "fixture-key" };
    await http.post("/workspace/model-settings").send(body).expect(401);
    const owner = `Bearer ${await sessions.issue("owner", "studio")}`;
    const editor = `Bearer ${await sessions.issue("editor", "studio")}`;
    const capabilities = await http.get("/workspace/model-settings/capabilities").set("authorization", editor).expect(200);
    assert.equal(capabilities.body.canManage, false);
    assert.equal(capabilities.body.advanced, true);
    assert.ok(capabilities.body.providers.some((p: { id: string }) => p.id === "openai"));
    await http.post("/workspace/model-settings").set("authorization", editor).send(body).expect(403);
    await http.post("/workspace/model-settings").set("authorization", owner).send({ ...body, workspaceId: "other" }).expect(400);
    const saved = await http.post("/workspace/model-settings").set("authorization", owner).send(body).expect(201);
    assert.equal(saved.headers["cache-control"], "no-store");
    assert.equal(saved.body.workspaceId, "studio"); assert.equal(saved.body.keyMask, "••••••••");
    assert.ok(!JSON.stringify(saved.body).includes("fixture-key")); assert.equal(saved.body.ciphertext, undefined);
    const read = await http.get("/workspace/model-settings").set("authorization", editor).expect(200);
    assert.deepEqual(read.body.configuration, saved.body); assert.equal(await repository.find("other"), null);
    const other = await http.get("/workspace/model-settings").set("authorization", `Bearer ${await sessions.issue("other", "other")}`).expect(200);
    assert.deepEqual(other.body, { configuration: null });
    for (const extra of [{ actor: { userId: "owner" } }, { endpoint: "https://attacker.example" }]) await http.post("/workspace/model-settings").set("authorization", owner).send({ ...body, ...extra }).expect(400);
    await http.post("/workspace/model-settings").set("authorization", owner).send(body).expect(409);
  } finally { await app.close(); }
});

test("连接测试的境外授权必须由负责人明确提供，失败不泄露密钥", async () => {
  const sessions = new HmacSessionManager({ secret: "0123456789abcdef0123456789abcdef", resolveActor: async (userId) => ({ userId, workspaceId: "studio" }) });
  let id = 0; let probes = 0; let fail = false;
  const settings = new WorkspaceModelSettings({ repository: new InMemoryModelSettingsRepository(), encryptionKey: new Uint8Array(32).fill(1), idGenerator: () => `v${++id}`,
    access: { read: async (actor) => actor.userId === "outsider" ? null : ({ owner: actor.userId === "owner", advanced: actor.userId !== "free" }) },
    probe: { processingRegion: () => "overseas", test: async () => { probes++; if (fail) throw new Error("fixture-key"); return { modelIds: ["pinned"], processingRegion: "overseas" }; } },
  });
  const ref = await Test.createTestingModule({ imports: [ModelSettingsApiModule.register({ sessionVerifier: sessions, settings, rateLimiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0 }) } })] }).compile();
  const app = ref.createNestApplication(); await app.listen(0, "127.0.0.1");
  try {
    const http = request(app.getHttpServer()); const owner = `Bearer ${await sessions.issue("owner", "studio")}`;
    const saved = await http.post("/workspace/model-settings").set("authorization", owner).send({ providerId: "openai", apiKey: "fixture-key", expectedVersionId: null }).expect(201);
    const body = { expectedVersionId: saved.body.id, allowNonMainland: false };
    await http.post("/workspace/model-settings/test").set("authorization", owner).send(body).expect(403); assert.equal(probes, 0);
    await http.post("/workspace/model-settings/test").set("authorization", owner).send({ ...body, allowNonMainland: "true" }).expect(400);
    for (const userId of ["editor", "free", "outsider"]) await http.post("/workspace/model-settings/test").set("authorization", `Bearer ${await sessions.issue(userId, "studio")}`).send({ ...body, allowNonMainland: true }).expect(403);
    assert.equal(probes, 0);
    const tested = await http.post("/workspace/model-settings/test").set("authorization", owner).send({ ...body, allowNonMainland: true }).expect(201);
    assert.deepEqual(tested.body.availableModelIds, ["pinned"]); assert.equal(probes, 1);
    fail = true;
    const failed = await http.post("/workspace/model-settings/test").set("authorization", owner).send({ expectedVersionId: tested.body.id, allowNonMainland: true }).expect(503);
    assert.equal(failed.body.code, "PROVIDER_UNAVAILABLE"); assert.ok(!JSON.stringify(failed.body).includes("fixture-key"));
    for (const userId of ["free", "outsider"]) await http.get("/workspace/model-settings").set("authorization", `Bearer ${await sessions.issue(userId, "studio")}`).expect(403);
    const free = await http.get("/workspace/model-settings/capabilities").set("authorization", `Bearer ${await sessions.issue("free", "studio")}`).expect(200);
    assert.equal(free.body.advanced, false); assert.equal(free.body.canManage, false);
    await http.get("/workspace/model-settings/capabilities").set("authorization", `Bearer ${await sessions.issue("outsider", "studio")}`).expect(403);
    const ownerCapabilities = await http.get("/workspace/model-settings/capabilities").set("authorization", owner).expect(200);
    assert.equal(ownerCapabilities.body.canManage, true);
  } finally { await app.close(); }
});
