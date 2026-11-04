import assert from "node:assert/strict";
import test from "node:test";
import { DeepSeekSettingsModel } from "../src/deepseek-settings-model.ts";
import type { SettingsGenerationRequest } from "@novel-adaptation/script/settings-runner";
import { version,context } from "../../script/test/script-quality-fixture.ts";
const input: SettingsGenerationRequest = { contractVersion: "0.1.0",stage: "settings",jobId: "settings-job",projectId: version.projectId,chapterId: version.chapterId,sourceVersionId: version.sourceVersionId,upstreamConfirmedVersionIds: [version.id,"plan_1","bible_1"],input: { version: { ...version,status: "confirmed" },sourceFragments: context.fragments,upstreamConfirmedVersionIds: ["plan_1","bible_1"] } };
const credentials = { apiKey: "fixture-secret",providerId: "deepseek",modelId: "fixture-model",processingRegion: "mainland" as const };
function completion() { return { object: "chat.completion",model: "fixture-model",choices: [{ index: 0,finish_reason: "stop",message: { role: "assistant",content: JSON.stringify({ status: "failed",items: [] }) } }] }; }
test("settings native transport fixes endpoint, separates instructions and exposes credentials only in authentication header",async () => {
  let calls = 0;
  const model = new DeepSeekSettingsModel({ fetch: async (url,init) => {
    calls++;assert.equal(url,"https://api.deepseek.com/chat/completions");assert.equal(init?.redirect,"error");
    assert.equal(new Headers(init?.headers).get("authorization"),"Bearer fixture-secret");
    const body = JSON.parse(String(init?.body));assert.equal(body.stream,false);assert.deepEqual(body.response_format,{ type: "json_object" });
    assert.deepEqual(JSON.parse(body.messages[1].content),input);assert.ok(!String(init?.body).includes("fixture-secret"));
    return Response.json(completion());
  } });
  assert.deepEqual(await model.generate(input,credentials),{ status: "failed",items: [] });assert.equal(calls,1);
});
test("settings transport rejects wrong credentials, region, formal identity and oversized input before sending",async () => {
  let calls = 0;const model = new DeepSeekSettingsModel({ fetch: async () => { calls++;return Response.json(completion()); } });
  for (const bad of [{ ...credentials,providerId: "other" },{ ...credentials,apiKey: "bad\nkey" },{ ...credentials,modelId: "" }]) await assert.rejects(model.generate(input,bad),{ code: "INVALID_REQUEST" });
  await assert.rejects(model.generate(input,JSON.parse(JSON.stringify({ ...credentials,processingRegion: "overseas" }))),{ code: "INVALID_REQUEST" });
  await assert.rejects(model.generate({ ...input,upstreamConfirmedVersionIds: [] },credentials),{ code: "INVALID_REQUEST" });
  await assert.rejects(model.generate({ ...input,input: { ...input.input,version: { ...input.input.version,status: "candidate" } } },credentials),{ code: "INVALID_REQUEST" });
  await assert.rejects(model.generate({ ...input,input: { ...input.input,sourceFragments: [{ id: "f",text: "雨".repeat(700000) }] } },credentials),{ code: "INVALID_REQUEST" });
  assert.equal(calls,0);
});
test("settings transport sanitizes malformed completions and never retries network, HTTP, body or deadline failures",async () => {
  for (const mode of ["network","http","large","json","truncated","tool","model","timeout"]) {
    let calls = 0;
    const model = new DeepSeekSettingsModel({ timeoutMs: 15,fetch: async () => {
      calls++;
      if (mode === "network") throw new Error("fixture-secret endpoint");
      if (mode === "timeout") return new Promise<Response>(() => {});
      if (mode === "http") return new Response("private",{ status: 429 });
      if (mode === "large") return new Response("x".repeat(1000001),{ headers: { "content-type": "application/json" } });
      if (mode === "json") return Response.json({ ...completion(),choices: [{ index: 0,finish_reason: "stop",message: { role: "assistant",content: "invalid-json" } }] });
      if (mode === "tool") return Response.json({ ...completion(),choices: [{ index: 0,finish_reason: "stop",message: { role: "assistant",content: "{}",tool_calls: [] } }] });
      if (mode === "model") return Response.json({ ...completion(),model: "wrong" });
      return Response.json({ ...completion(),choices: [{ ...completion().choices[0]!,finish_reason: "length" }] });
    } });
    const code = ["json","truncated","tool","model"].includes(mode) ? "INVALID_RESPONSE" : "PROVIDER_UNAVAILABLE";
    await assert.rejects(model.generate(input,credentials),{ code,message: code });assert.equal(calls,1);
  }
});

test("settings regeneration transport preserves exact selected scope and separates local replacement instructions",async () => {
  const request = { ...input,regeneration: { baseVersionId: "settings-base",reason: "visible detail",targets: [{ scopeKey: "failure_scope",failureScopeKey: "missing-character" }] } };
  let calls = 0;
  const model = new DeepSeekSettingsModel({ fetch: async (_url,init) => {
    calls++;const body = JSON.parse(String(init?.body));assert.deepEqual(JSON.parse(body.messages[1].content),request);
    assert.match(body.messages[0].content,/exactly one item for each regeneration target/);
    assert.match(body.messages[0].content,/Preserve each target asset id and assetType/);
    return Response.json(completion());
  } });
  await model.generate(request,credentials);assert.equal(calls,1);
});
test("settings regeneration transport rejects malformed or overlapping targets before any model call",async () => {
  let calls = 0;const model = new DeepSeekSettingsModel({ fetch: async () => { calls++;return Response.json(completion()); } });
  const target = { scopeKey: "scope",failureScopeKey: "failure" };
  for (const regeneration of [
    { baseVersionId: "base",reason: "visible",targets: [] },
    { baseVersionId: "base",reason: "visible",targets: [target,target] },
    { baseVersionId: "base",reason: "visible",targets: [{ scopeKey: "empty" }] },
    { baseVersionId: "base",reason: "visible",targets: [target,{ ...target,scopeKey: "other" }] },
    { baseVersionId: "base",reason: "visible",targets: [target],extra: true },
    { baseVersionId: "base",reason: " ",targets: [target] },
    { baseVersionId: "base",reason: "visible",targets: [{ scopeKey: "asset",asset: { id: "unknown",provenance: [] } }] },
  ]) await assert.rejects(model.generate({ ...input,regeneration } as never,credentials),{ code: "INVALID_REQUEST" });
  assert.equal(calls,0);
});
