import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { HmacSessionManager } from "@novel-adaptation/identity";
import { InMemoryScriptContentRepository } from "@novel-adaptation/script/script-content";
import { ScriptRevisionService } from "@novel-adaptation/script/script-revision";
import { ScriptContentApiModule } from "../src/script-content-api.ts";
import { ScriptContentContext } from "../src/script-content-context.ts";
import { version,context } from "../../script/test/script-quality-fixture.ts";
test("authenticated revision API preserves formal content and returns isolated historical snapshots",async () => {
  const actor = { userId: "owner",workspaceId: "w" },repository = new InMemoryScriptContentRepository();let sequence = 0;
  await repository.save(actor,{ ...version,status: "confirmed" },null);
  const withImpacts = Object.assign(repository,{ listImpacts: async () => [{ confirmed_version_id: version.id,source_version_id: version.id,source_element_id: "e1",target_stage: "storyboard",target_version_id: "board",target_item_id: "shot",status: "unreviewed" }] });
  const revision = new ScriptRevisionService({ repository,contextReader: { findGenerationContext: async () => context },accessReader: { findProjectAccess: async a => a.userId === "outsider" ? null : { role: a.userId === "editor" ? "editor" : "owner" } },idGenerator: () => `r${++sequence}`,clock: () => new Date("2026-11-02") });
  const sessions = new HmacSessionManager({ secret: "0123456789abcdef0123456789abcdef",resolveActor: async userId => ({ userId,workspaceId: "w" }) });
  // Public context read gate; generation prerequisites are independently exercised by the production TLS fixture.
  const readContext = Object.create(ScriptContentContext.prototype) as ScriptContentContext;
  readContext.canRead = async (a,p,c) => a.userId !== "outsider" && p === "p" && c === "c";
  const ref = await Test.createTestingModule({ imports: [ScriptContentApiModule.register({ sessionVerifier: sessions,repository: withImpacts,context: readContext,revision })] }).compile();
  const app = ref.createNestApplication();await app.listen(0,"127.0.0.1");
  try {
    const http = request(app.getHttpServer()),base = "/projects/p/chapters/c/script-content";
    const owner = { authorization: `Bearer ${await sessions.issue("owner","w")}` },editor = { authorization: `Bearer ${await sessions.issue("editor","w")}` };
    await http.get(`${base}/versions/confirmed`).expect(401);
    assert.equal((await http.get(`${base}/versions/${version.id}/impacts`).set(editor).expect(200)).body.impacts[0].target_item_id,"shot");
    await http.get(`${base}/versions/${version.id}/impacts`).expect(401);
    const formal = (await http.get(`${base}/versions/confirmed`).set(editor).expect(200)).body.version;
    const input = { kind: "suggest",requestId: "suggest",expectedActiveVersionId: formal.id,elementId: "e1",text: "少年缓缓起身。",reason: "节奏" };
    const proposed = (await http.post(`${base}/revision`).set(editor).send(input).expect(201)).body;
    assert.equal((await http.post(`${base}/revision`).set(editor).send(input).expect(201)).body.id,proposed.id);
    const command = { kind: "decide",requestId: "accept",expectedActiveVersionId: proposed.id,suggestionId: proposed.suggestions[0].id,decision: "accepted",reason: "符合原文" };
    await http.post(`${base}/revision`).set(editor).send(command).expect(403);
    const candidate = (await http.post(`${base}/revision`).set(owner).send(command).expect(201)).body;
    assert.equal(candidate.status,"candidate");assert.equal((await http.get(`${base}/versions/confirmed`).set(owner).expect(200)).body.version.id,proposed.id);
    assert.equal((await http.get(`${base}/versions/${formal.id}`).set(owner).expect(200)).body.version.elements[0].text,version.elements[0]!.text);
    await http.get(`${base}/versions/${formal.id}`).set({ authorization: `Bearer ${await sessions.issue("outsider","w")}` }).expect(404);
    await http.post(`${base}/revision`).set(owner).send({ ...command,requestId: "late" }).expect(409);
  } finally { await app.close(); }
});
