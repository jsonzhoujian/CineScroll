import assert from "node:assert/strict";
import test from "node:test";
import { createServerSettlementEvidenceReader } from "../src/evidence-reader-assembly.ts";

test("证据读取装配配置或预检失败不返回服务，错误脱敏", async () => {
  const pool = { connect: async () => { throw new Error("private-database"); } };
  await assert.rejects(() => createServerSettlementEvidenceReader({ pool, policy: { serviceId: "reader", grants: [] } }), { message: "EVIDENCE_DATABASE_NOT_READY" });
  await assert.rejects(() => createServerSettlementEvidenceReader({ pool, policy: { serviceId: "", grants: [] } }), { message: "BILLING_ACCESS_CONFIG_INVALID" });
});
