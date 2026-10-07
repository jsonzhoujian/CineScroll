import assert from "node:assert/strict";
import test from "node:test";
import { createServerCreditLedger } from "../src/server-assembly.ts";

test("服务器装配配置或数据库失败不返回账本且不泄露详情", async () => {
  const pool = { connect: async () => { throw new Error("private-database"); } };
  const clock = () => new Date("2026-10-07");
  await assert.rejects(() => createServerCreditLedger({ pool, clock, policy: { serviceId: "worker", grants: [] } }), { message: "BILLING_DATABASE_NOT_READY" });
  await assert.rejects(() => createServerCreditLedger({ pool, clock, policy: { serviceId: "", grants: [] } }), { message: "BILLING_ACCESS_CONFIG_INVALID" });
  // @ts-expect-error invalid trusted-host dependency
  await assert.rejects(() => createServerCreditLedger({ pool, clock: null, policy: { serviceId: "worker", grants: [] } }), { message: "BILLING_SERVER_CONFIG_INVALID" });
});
