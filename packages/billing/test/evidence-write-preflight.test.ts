import assert from "node:assert/strict";
import test from "node:test";
import { createEvidenceWritePreflight } from "../src/evidence-write-preflight.ts";

const ref = (id: string) => ({ id, version: "v1" });
const references = { task: ref("task"), snapshot: ref("snapshot"), execution: ref("execution"), result: null, validation: null, pricing: null };
const request = { requestId: "request", references };
function material() {
  const binding = { workspaceId: "studio", taskId: "task", unitId: "unit", projectId: "project", chapterId: "chapter", sourceVersionId: "source", upstreamVersionIds: [] };
  return { id: "draft", formatVersion: 1, binding, ruleVersion: "quality-v1", snapshot: { binding, responsibility: "platform", quoteId: "quote", priceVersion: "price", reserved: 60 },
    execution: { binding, id: "execution", state: "unknown", closed: false }, results: [], pricing: null };
}
const policy = { serviceId: "writer", grants: [{ workspaceId: "studio", operations: ["publish", "supplement"] as const }] };
function source() {
  return { load: async () => ({ material: material(), references, snapshotToken: "token", complete: true }), isCurrent: async () => true,
    readPredecessor: async () => null as unknown };
}
test("专用权限通过后核验引用来源，只返回未发布草稿", async () => {
  const service = createEvidenceWritePreflight({ policy, source: source() });
  const result = await service.verifyPublish("studio", request);
  assert.deepEqual(result, { requestId: "request", material: material(), predecessorId: null });
  await assert.rejects(() => service.verifyPublish("other", request), { code: "FORBIDDEN" });
});

test("成功资料必须与结果/计价引用匹配，超报价不截断且多结果拒绝",async()=>{
  const base=material(),refs={...references,result:ref("result"),validation:ref("validation"),pricing:ref("pricing")};
  const data={...base,execution:{...base.execution,state:"completed",closed:true},
    results:[{binding:base.binding,id:"result",executionId:"execution",original:true,persisted:true,validation:"passed",ruleVersion:"quality-v1"}],
    pricing:{binding:base.binding,id:"pricing",resultVersionId:"result",quoteId:"quote",priceVersion:"price",origin:"quote",amount:70}};
  const ports={...source(),load:async()=>({material:data,references:refs,snapshotToken:"token",complete:true})};
  const service=createEvidenceWritePreflight({policy,source:ports});
  const output=await service.verifyPublish("studio",{...request,references:refs});
  assert.equal((output.material.pricing as {amount:number}).amount,70);
  data.results.push(structuredClone(data.results[0]!));
  await assert.rejects(()=>service.verifyPublish("studio",{...request,references:refs}),{code:"CONFLICT"});
});

test("专用权限不接受settle，非法请求与越权在读源前拒绝", async () => {
  assert.throws(() => createEvidenceWritePreflight({ policy: { ...policy, grants: [{ workspaceId:"studio", operations:["settle"] as never }] }, source:source() }), { message:"EVIDENCE_WRITE_CONFIG_INVALID" });
  const service=createEvidenceWritePreflight({ policy:{...policy,grants:[]},source:{...source(),load:async()=>{ throw new Error("must-not-load"); }} });
  await assert.rejects(()=>service.verifyPublish("studio",request),{code:"FORBIDDEN"});
  const allowed=createEvidenceWritePreflight({policy,source:{...source(),load:async()=>{ throw new Error("must-not-load"); }}});
  for(const input of [{...request,amount:50},{...request,material:material()},{...request,references:{...references,task:ref("https://evil")}}]) {
    await assert.rejects(()=>allowed.verifyPublish("studio",input),{code:"INVALID_REQUEST"});
  }
});

test("缺失、错误、引用错配、不完整结果与变化快照各自拒绝且脱敏",async()=>{
  const base={material:material(),references,snapshotToken:"token",complete:true};
  const samples:[unknown,string][]=[[null,"NOT_FOUND"],[{...base,complete:false},"CONFLICT"],
    [{...base,references:{...references,task:ref("other")}},"CONFLICT"],
    [{...base,material:{...material(),execution:{...material().execution,id:"wrong"}}},"CONFLICT"]];
  for(const [data,code] of samples){
    const service=createEvidenceWritePreflight({policy,source:{...source(),load:async()=>data}});
    await assert.rejects(()=>service.verifyPublish("studio",request),{code,message:code});
  }
  for(const phase of ["load","isCurrent"] as const){
    const ports=source(); ports[phase]=async()=>{throw new Error("private-key");};
    await assert.rejects(()=>createEvidenceWritePreflight({policy,source:ports}).verifyPublish("studio",request),{code:"UNAVAILABLE",message:"UNAVAILABLE"});
  }
  await assert.rejects(()=>createEvidenceWritePreflight({policy,source:{...source(),isCurrent:async()=>false}}).verifyPublish("studio",request),{code:"CONFLICT"});
});

test("补证权限独立，读取并检查前序且不改变原资料",async()=>{
  const old={...material(),id:"previous"};
  const ports={...source(),readPredecessor:async()=>old};
  const service=createEvidenceWritePreflight({policy,source:ports});
  const result=await service.verifySupplement("studio",{...request,predecessorId:"previous"});
  assert.equal(result.predecessorId,"previous"); assert.equal(old.id,"previous");
  const publishOnly=createEvidenceWritePreflight({policy:{...policy,grants:[{workspaceId:"studio",operations:["publish"]}]},source:ports});
  await assert.rejects(()=>publishOnly.verifySupplement("studio",{...request,predecessorId:"previous"}),{code:"FORBIDDEN"});
  await assert.rejects(()=>service.verifySupplement("studio",{...request,predecessorId:"draft"}),{code:"CONFLICT"});
  const wrong={...old,snapshot:{...old.snapshot,quoteId:"wrong"}};
  await assert.rejects(()=>createEvidenceWritePreflight({policy,source:{...ports,readPredecessor:async()=>wrong}}).verifySupplement("studio",{...request,predecessorId:"previous"}),{code:"CONFLICT"});
});

test("绑定依赖和异步前配置/请求复制，外部修改不扩大授权或污染草稿",async()=>{
  const config=structuredClone(policy),input=structuredClone(request),ports=source();
  const original=ports.load;
  ports.load=async()=>{
    config.serviceId="changed"; config.grants[0]!.workspaceId="changed";
    input.references.task.id="changed"; ports.isCurrent=async()=>false;
    return original();
  };
  const service=createEvidenceWritePreflight({policy:config,source:ports});
  const first=await service.verifyPublish("studio",input); first.material.id="tampered";
  assert.equal((await service.verifyPublish("studio",request)).material.id,"draft");
  await assert.rejects(()=>service.verifyPublish("changed",request),{code:"FORBIDDEN"});
});
