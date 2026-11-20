import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { EpisodeReconciliationOpsModule } from "../src/episode-reconciliation-ops.ts";

test("内部告警入口从已认证凭据派生服务身份及工作室权限",async()=>{
  const token=randomBytes(32).toString("base64url");
  const digest=createHash("sha256").update(token).digest("hex");
  const calls:unknown[]=[];
  const ref=await Test.createTestingModule({imports:[EpisodeReconciliationOpsModule.register({
    services:[{serviceId:"ops-east",tokenSha256:digest,workspaceIds:["studio"]}],
    reader:policy=>async (actor,page)=>{
      calls.push({policy,actor,page});
      return {items:[],nextCursor:null};
    },
  })]}).compile();
  const app=ref.createNestApplication();
  try {
    await app.listen(0,"127.0.0.1");
    const http=request(app.getHttpServer());
    const path="/internal/workspaces/studio/episode-reconciliation-alerts";
    await http.get(path).expect(401);
    await http.get(path).set("authorization",`Bearer ${randomBytes(32).toString("base64url")}`).expect(401);
    await http.get("/internal/workspaces/other/episode-reconciliation-alerts").set("authorization",`Bearer ${token}`).expect(403);
    await http.get(path).set("authorization",`Bearer ${token}`).query({serviceId:"forged"}).expect(400);
    await http.get(path).set("authorization",`Bearer ${token}`).query({cursorTaskId:"job"}).expect(400);
    assert.deepEqual(calls,[]);
    await http.get(path).set("authorization",`Bearer ${token}`).set("x-service-id","forged")
      .query({limit:1,cursorTaskId:"job",cursorCode:"EXECUTION_UNKNOWN"}).expect(200,{items:[],nextCursor:null});
    assert.deepEqual(calls,[{policy:{serviceId:"ops-east",workspaceIds:["studio"]},
      actor:{serviceId:"ops-east",workspaceId:"studio"},page:{limit:1,cursor:{taskId:"job",code:"EXECUTION_UNKNOWN"}}}]);
    await http.post(path).set("authorization",`Bearer ${token}`).expect(404);
  } finally { await app.close(); }
});
