import assert from "node:assert/strict";
import test from "node:test";
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { HmacSessionManager } from "@novel-adaptation/identity";
import type { IdentityService } from "@novel-adaptation/identity";
import { InMemoryProjectImportRepository, ProjectImportService } from "@novel-adaptation/project-import";
import { ForwardedClientIpResolver, HmacDeviceTokenService, ProjectImportApiModule } from "../src/index.ts";

test("项目创建 API 拒绝无 Session 请求，并只使用 Session 中的 Actor", async () => {
  let id = 0;
  const sessions = new HmacSessionManager({
    secret: "0123456789abcdef0123456789abcdef",
    resolveActor: async (userId) => ({ userId, workspaceId: "wsp_studio" }),
  });
  const service = new ProjectImportService({
    repository: new InMemoryProjectImportRepository(),
    complianceScanner: { async scan() { return { allowed: true }; } },
    idGenerator: (prefix: string) => `${prefix}_${++id}`,
    clock: () => new Date("2026-09-28T00:00:00.000Z"),
  });
  const moduleRef = await Test.createTestingModule({ imports: [ProjectImportApiModule.register({
    identity: {} as IdentityService,
    sessionVerifier: sessions,
    projectImport: service,
    wechatRedirectUri: "https://app.example.cn/auth/wechat/callback",
    deviceTokens: new HmacDeviceTokenService("abcdef0123456789abcdef0123456789"),
    clientIpResolver: new ForwardedClientIpResolver(0),
  })] }).compile();
  const app = moduleRef.createNestApplication();
  await app.listen(0, "127.0.0.1");
  try {
    const body = {
      title: "人间剑令",
      rightsDeclared: true,
      aspectRatio: "9:16",
      targetDurationSeconds: 180,
      narrativeMode: "narration",
      actor: { userId: "attacker", workspaceId: "attacker" },
    };
    await request(app.getHttpServer()).post("/projects").send(body).expect(401);

    const token = await sessions.issue("usr_owner", "wsp_studio");
    await request(app.getHttpServer()).post("/projects")
      .set("authorization", `Bearer ${token}`).send({}).expect(400);
    const response = await request(app.getHttpServer())
      .post("/projects")
      .set("authorization", `Bearer ${token}`)
      .send(body)
      .expect(201);
    assert.equal(response.body.ownerUserId, "usr_owner");
    assert.equal(response.body.workspaceId, "wsp_studio");
  } finally {
    await app.close();
  }
});

test("已认证用户可预检多章节、选择一章导入并读取可追溯原文", async () => {
  let id = 0;
  const sessions = new HmacSessionManager({
    secret: "0123456789abcdef0123456789abcdef",
    resolveActor: async (userId) => ({ userId, workspaceId: userId === "usr_outsider" ? "wsp_other" : "wsp_studio" }),
  });
  const service = new ProjectImportService({
    repository: new InMemoryProjectImportRepository(),
    complianceScanner: { async scan() { return { allowed: true }; } },
    idGenerator: (prefix: string) => `${prefix}_${++id}`,
    clock: () => new Date("2026-09-28T00:00:00.000Z"),
  });
  const moduleRef = await Test.createTestingModule({ imports: [ProjectImportApiModule.register({
    identity: {} as IdentityService,
    sessionVerifier: sessions,
    projectImport: service,
    wechatRedirectUri: "https://app.example.cn/auth/wechat/callback",
    deviceTokens: new HmacDeviceTokenService("abcdef0123456789abcdef0123456789"),
    clientIpResolver: new ForwardedClientIpResolver(0),
  })] }).compile();
  const app = moduleRef.createNestApplication();
  await app.listen(0, "127.0.0.1");
  const token = await sessions.issue("usr_owner", "wsp_studio");
  const authorized = () => ({ authorization: `Bearer ${token}` });
  try {
    const project = await request(app.getHttpServer()).post("/projects").set(authorized()).send({
      title: "人间剑令", rightsDeclared: true, aspectRatio: "9:16",
      targetDurationSeconds: 180, narrativeMode: "narration",
    }).expect(201);
    const document = { kind: "paste", fileName: "人间剑令.txt", text: "第1章 青芽微澜\n雨落。\n第2章 风起\n剑鸣。" };
    const inspection = await request(app.getHttpServer())
      .post(`/projects/${project.body.id}/imports/inspect`).set(authorized()).send(document).expect(201);
    assert.deepEqual(inspection.body.chapters.map(({ title }: { title: string }) => title), ["第1章 青芽微澜", "第2章 风起"]);

    const imported = await request(app.getHttpServer())
      .post(`/projects/${project.body.id}/chapters/import`).set(authorized())
      .send({ document, selectedChapterIndex: 1 }).expect(201);
    const importedDocument = await request(app.getHttpServer())
      .get(`/projects/${project.body.id}/imported-documents/${imported.body.document.id}`)
      .set(authorized()).expect(200);
    assert.deepEqual(importedDocument.body.chapters.map(({ title, status }: { title: string; status: string }) => ({ title, status })), [
      { title: "第1章 青芽微澜", status: "pending" },
      { title: "第2章 风起", status: "imported" },
    ]);
    const continued = await request(app.getHttpServer())
      .post(`/projects/${project.body.id}/imported-documents/${imported.body.document.id}/chapters/import`)
      .set(authorized()).send({ chapterIndex: 0 }).expect(201);
    assert.equal(continued.body.chapter.title, "第1章 青芽微澜");
    assert.deepEqual(continued.body.document.chapters.map(({ status }: { status: string }) => status), ["imported", "imported"]);
    const duplicate = await request(app.getHttpServer())
      .post(`/projects/${project.body.id}/imported-documents/${imported.body.document.id}/chapters/import`)
      .set(authorized()).send({ chapterIndex: 0 }).expect(422);
    assert.equal(duplicate.body.code, "CHAPTER_ALREADY_IMPORTED");
    const chapter = await request(app.getHttpServer())
      .get(`/projects/${project.body.id}/chapters/${imported.body.chapter.id}`).set(authorized()).expect(200);
    assert.equal(chapter.body.title, "第2章 风起");
    assert.equal(chapter.body.versions[0].text, "剑鸣。");
    assert.ok(chapter.body.versions[0].fragments[0].id);

    const reimported = await request(app.getHttpServer())
      .post(`/projects/${project.body.id}/chapters/${imported.body.chapter.id}/reimport`)
      .set(authorized()).send({ fileName: "人间剑令.txt", text: "第2章 风起\n剑啸。", selectedChapterIndex: 0 })
      .expect(201);
    assert.equal(reimported.body.sourceVersion.ordinal, 2);
    assert.deepEqual(reimported.body.diff, { unchanged: [], removed: ["剑鸣。"], added: ["剑啸。"] });

    const malformed = await request(app.getHttpServer())
      .post(`/projects/${project.body.id}/imports/inspect`).set(authorized())
      .send({ kind: "txt", fileName: "broken.txt", contentBase64: "%%%" }).expect(422);
    assert.equal(malformed.body.code, "MALFORMED_DOCUMENT");

    const outsider = await sessions.issue("usr_outsider", "wsp_other");
    const outsiderAuthorization = { authorization: `Bearer ${outsider}` };
    const hidden = await request(app.getHttpServer())
      .get(`/projects/${project.body.id}/chapters/${imported.body.chapter.id}`)
      .set(outsiderAuthorization).expect(404);
    assert.equal(hidden.body.code, "PROJECT_NOT_FOUND");
    await request(app.getHttpServer()).post(`/projects/${project.body.id}/imports/inspect`)
      .set(outsiderAuthorization).send(document).expect(404);
    await request(app.getHttpServer()).post(`/projects/${project.body.id}/chapters/import`)
      .set(outsiderAuthorization).send({ document, selectedChapterIndex: 0 }).expect(404);
    await request(app.getHttpServer()).post(`/projects/${project.body.id}/chapters/${imported.body.chapter.id}/reimport`)
      .set(outsiderAuthorization).send({ fileName: "x.txt", text: "正文", selectedChapterIndex: 0 }).expect(404);
    await request(app.getHttpServer())
      .get(`/projects/${project.body.id}/imported-documents/${imported.body.document.id}`)
      .set(outsiderAuthorization).expect(404);
  } finally { await app.close(); }
});
