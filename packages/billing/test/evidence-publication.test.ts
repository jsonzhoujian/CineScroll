import assert from "node:assert/strict";
import test from "node:test";
import { evidencePublicationId, InMemoryEvidencePublicationRepository, EvidencePublicationService } from "../src/evidence-publication.ts";

const ref=(id:string)=>({id,version:"v1"});
const references={task:ref("task"),snapshot:ref("snapshot"),execution:ref("execution"),result:null,validation:null,pricing:null};
function prepared(){
  const binding={workspaceId:"studio",taskId:"task",unitId:"unit",projectId:"project",chapterId:"chapter",sourceVersionId:"source",upstreamVersionIds:[]};
  return {material:{id:"draft",formatVersion:1,binding,ruleVersion:"quality",snapshot:{binding,responsibility:"platform",quoteId:"quote",priceVersion:"price",reserved:60},
    execution:{binding,id:"execution",state:"unknown",closed:false},results:[],pricing:null},audit:{references,sourceFingerprint:"a".repeat(64),sourceSealId:"fixture-seal",verifiedAt:"2026-10-07T00:00:00.000Z"}};
}
const request={requestId:"request",references};
function fixture(){
  const repository=new InMemoryEvidencePublicationRepository(); let allowed=true;
  const service=new EvidencePublicationService({serviceId:"writer",repository,access:{authorize:async()=>allowed},prepare:async()=>prepared(),clock:()=>new Date("2026-10-07T00:00:00Z")});
  return {repository,service,revoke:()=>{allowed=false;}};
}
test("发布四项共同保存，协议ID固定，重放回执保持原时间与审计",async()=>{
  const {repository,service}=fixture();
  const receipt=await service.publish("studio",request);
  assert.equal(receipt.evidenceId,evidencePublicationId("studio","request"));
  assert.equal(receipt.evidenceId,"evp_e78f795ffe17753be93ec7b163dd8fa3c67289650e377cdb2d3cee2b181c3fe7");
  assert.match(receipt.evidenceId,/^evp_[a-f0-9]{64}$/);
  assert.equal(receipt.publishedAt,"2026-10-07T00:00:00.000Z");
  assert.deepEqual(await service.publish("studio",request),receipt);
  const record=await repository.lookup("studio","request");
  assert.equal((record!.material as {id:string}).id,receipt.evidenceId);
  assert.equal(record!.audit.serviceId,"writer");
  assert.deepEqual(record!.receipt,receipt);
});

test("同请求跨操作或引用冲突不覆盖，权限撤销不能重放或查询",async()=>{
  const {repository,service,revoke}=fixture();
  const original=await service.publish("studio",request);
  await assert.rejects(()=>service.publish("studio",{...request,references:{...references,snapshot:ref("other")}}),{code:"CONFLICT"});
  await assert.rejects(()=>service.supplement("studio",{...request,predecessorId:original.evidenceId}),{code:"CONFLICT"});
  revoke();
  await assert.rejects(()=>service.publish("studio",request),{code:"FORBIDDEN"});
  await assert.rejects(()=>service.lookup("studio","request","publish"),{code:"FORBIDDEN"});
  assert.deepEqual((await repository.lookup("studio","request"))!.receipt,original);
});

test("并发相同请求收敛，输出副本与工作室读取隔离",async()=>{
  const {service,repository}=fixture();
  const [a,b]=await Promise.all([service.publish("studio",request),service.publish("studio",request)]);
  assert.deepEqual(a,b);a.publishedAt="tampered";
  assert.equal((await service.lookup("studio","request","publish"))!.publishedAt,"2026-10-07T00:00:00.000Z");
  const row=await repository.lookup("studio","request"); row!.audit.serviceId="tampered";
  assert.equal((await repository.get("studio",b.evidenceId))!.audit.serviceId,"writer");
  assert.equal(await repository.get("other",b.evidenceId),null);
  assert.notEqual(evidencePublicationId("other","request"),b.evidenceId);
});

test("补证关联只追加，前序缺失或快照变化失败无残留",async()=>{
  const {service,repository}=fixture();
  const old=await service.publish("studio",request);
  const next=await service.supplement("studio",{...request,requestId:"next",predecessorId:old.evidenceId});
  assert.equal(next.predecessorId,old.evidenceId);
  assert.deepEqual((await repository.lookup("studio","request"))!.receipt,old);
  await assert.rejects(()=>service.supplement("studio",{...request,requestId:"missing",predecessorId:"absent"}),{code:"PREDECESSOR_NOT_FOUND"});
  assert.equal(await repository.lookup("studio","missing"),null);
});

test("非法审计或错配资料不能留下半份发布，准备器不能覆盖固定身份",async()=>{
  const repository=new InMemoryEvidencePublicationRepository();
  for(const mutate of [(data:ReturnType<typeof prepared>)=>{data.audit.sourceFingerprint="bad";},
    (data:ReturnType<typeof prepared>)=>{data.audit.sourceFingerprint=["a".repeat(64)] as never;},
    (data:ReturnType<typeof prepared>)=>{data.material.binding.taskId="other";}]){
    const data=prepared();mutate(data);
    const service=new EvidencePublicationService({serviceId:"writer",repository,access:{authorize:async()=>true},prepare:async()=>data,clock:()=>new Date("2026-10-07")});
    await assert.rejects(()=>service.publish("studio",request),{code:"INVALID_PUBLICATION"});
    assert.equal(await repository.lookup("studio","request"),null);
    assert.equal(await repository.get("studio",evidencePublicationId("studio","request")),null);
  }
  const malicious=new EvidencePublicationService({serviceId:"writer",repository,access:{authorize:async()=>true},
    prepare:async()=>({...prepared(),serviceId:"attacker"}),clock:()=>new Date("2026-10-07")});
  await assert.rejects(()=>malicious.publish("studio",request),{code:"INVALID_PUBLICATION"});
});

test("已提交重放不依赖当前来源，准备异常脱敏不留下资料",async()=>{
  const repository=new InMemoryEvidencePublicationRepository();let unavailable=false;
  const service=new EvidencePublicationService({serviceId:"writer",repository,access:{authorize:async()=>true},prepare:async()=>{if(unavailable)throw new Error("private-key");return prepared();},clock:()=>new Date("2026-10-07")});
  const old=await service.publish("studio",request);unavailable=true;
  assert.deepEqual(await service.publish("studio",request),old);
  await assert.rejects(()=>service.publish("studio",{...request,requestId:"other"}),{code:"UNAVAILABLE",message:"UNAVAILABLE"});
  assert.equal(await repository.lookup("studio","other"),null);
});
