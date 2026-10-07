import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryEvidenceMaterialRepository } from "../src/evidence-material-repository.ts";
import { createVerifiedSettlementEvidenceReader } from "../src/verified-evidence.ts";

function material(id = "evidence") {
  const binding = { workspaceId: "studio", taskId: "task", unitId: "unit", projectId: "project", chapterId: "chapter", sourceVersionId: "source", upstreamVersionIds: [] };
  return { id, formatVersion: 1, binding, ruleVersion: "quality-v1",
    snapshot: { binding, responsibility: "platform", quoteId: "quote", priceVersion: "price-v1", reserved: 60 },
    execution: { binding, id: "execution", state: "unknown", closed: false }, results: [], pricing: null };
}
test("证据按工作室隔离，同内容幂等并拒绝覆盖", async () => {
  const repository = new InMemoryEvidenceMaterialRepository();
  const data = material();
  const first = await repository.append("studio", data);
  const { pricing, ...rest } = data;
  const reordered = { pricing, ...rest };
  assert.deepEqual(await repository.append("studio", reordered), first);
  await assert.rejects(() => repository.append("studio", { ...data, ruleVersion: "changed" }), { code: "CONFLICT" });
  assert.equal(await repository.read("other", "evidence"), null);
  assert.deepEqual(await repository.read("studio", "evidence"), data);
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
});

test("补证仅追加，同工作室前序必须存在且绑定/报价/执行保持一致", async () => {
  const repository = new InMemoryEvidenceMaterialRepository();
  const original = await repository.append("studio", material());
  await assert.rejects(() => repository.append("studio", material("missing"), "absent"), { code: "PREDECESSOR_NOT_FOUND" });
  await assert.rejects(() => repository.append("studio", material("self"), "self"), { code: "CONFLICT" });
  const data = material("changed"); data.snapshot.quoteId = "different";
  await assert.rejects(() => repository.append("studio", data, "evidence"), { code: "CONFLICT" });
  const next = await repository.append("studio", material("next"), "evidence");
  assert.equal(next.predecessorId, "evidence");
  assert.deepEqual(await repository.get("studio", "evidence"), original);
  await assert.rejects(() => repository.append("studio", material("next")), { code: "CONFLICT" });
});

test("输入及读回修改不污染快照，保存读取投影使用公开接口", async () => {
  const repository = new InMemoryEvidenceMaterialRepository();
  const data = material();
  const pending = repository.append("studio", data);
  data.execution.state = "not_sent";
  const stored = await pending;
  stored.predecessorId = "tampered";
  const read = await repository.read("studio", "evidence") as ReturnType<typeof material>;
  read.ruleVersion = "tampered";
  const reader = createVerifiedSettlementEvidenceReader({ access: { authorize: async () => true }, source: repository });
  assert.deepEqual(await reader.read({ workspaceId: "studio", serviceId: "settler" }, "evidence"), {
    id: "evidence", workspaceId: "studio", taskId: "task", unitId: "unit", sourceVersionId: "source", outcome: "unknown", amount: null, resultVersionId: null, ruleVersion: "quality-v1",
  });
  assert.equal((await repository.get("studio", "evidence"))!.predecessorId, null);
});

test("并发重复保存收敛，非法资料及跨工作室写入不留下记录", async () => {
  const repository = new InMemoryEvidenceMaterialRepository();
  const records = await Promise.all([repository.append("studio", material()), repository.append("studio", material())]);
  assert.deepEqual(records[0], records[1]);
  await assert.rejects(() => repository.append("other", material()), { code: "INVALID_MATERIAL" });
  await assert.rejects(() => repository.append("studio", { ...material("invalid"), pricing: { private: "secret" } }), { message: "INVALID_MATERIAL" });
  assert.equal(await repository.read("studio", "invalid"), null);
  const other = material();
  other.binding.workspaceId = "other";
  await repository.append("other", other);
  assert.equal((await repository.read("other", "evidence") as ReturnType<typeof material>).binding.workspaceId, "other");
});
