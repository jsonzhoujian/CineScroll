import assert from "node:assert/strict";
import test from "node:test";
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { HmacSessionManager } from "@novel-adaptation/identity";
import { InMemoryModelSettingsRepository, WorkspaceModelSettings } from "@novel-adaptation/script/model-settings";
import { ModelSettingsApiModule } from "../src/model-settings-api.ts";

test("模型设置 API 只使用登录工作室，负责人保存 Key，成员仅脱敏读取", async () => {
  const sessions = new HmacSessionManager({ secret: "0123456789abcdef0123456789abcdef", resolveActor: async (userId) => ({ userId, workspaceId: userId === "other" ? "other" : "studio" }) });
  let id = 0;
  const repository = new InMemoryModelSettingsRepository();
  const settings = new WorkspaceModelSettings({ repository, encryptionKey: new Uint8Array(32).fill(1), idGenerator: () => `v${++id}`, access: { read: async (actor) => ({ owner: actor.userId === "owner", advanced: true }) } });
  const ref = await Test.createTestingModule({ imports: [ModelSettingsApiModule.register({ sessionVerifier: sessions, settings })] }).compile();
  const app = ref.createNestApplication(); await app.listen(0, "127.0.0.1");
  try {
    const http = request(app.getHttpServer());
    const body = { expectedVersionId: null, providerId: "deepseek", apiKey: "fixture-key" };
    await http.post("/workspace/model-settings").send(body).expect(401);
    const owner = `Bearer ${await sessions.issue("owner", "studio")}`;
    const editor = `Bearer ${await sessions.issue("editor", "studio")}`;
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
  const ref = await Test.createTestingModule({ imports: [ModelSettingsApiModule.register({ sessionVerifier: sessions, settings })] }).compile();
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
  } finally { await app.close(); }
});
