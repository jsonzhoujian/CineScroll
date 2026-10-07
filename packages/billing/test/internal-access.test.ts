import assert from "node:assert/strict";
import test from "node:test";
import { createInternalBillingAccess } from "../src/internal-access.ts";
import { CreditLedgerService, InMemoryCreditLedgerRepository } from "../src/index.ts";

test("内部账本授权绑定服务器服务并严格限制工作室和操作", async () => {
  const access = createInternalBillingAccess({ serviceId: "worker", grants: [{ workspaceId: "studio", operations: ["read", "reserve"] }] });
  assert.equal(await access.authorize({ serviceId: "worker", workspaceId: "studio" }, "reserve"), true);
  assert.equal(await access.authorize({ serviceId: "admin", workspaceId: "studio" }, "reserve"), false);
  assert.equal(await access.authorize({ serviceId: "worker", workspaceId: "other" }, "reserve"), false);
  assert.equal(await access.authorize({ serviceId: "worker", workspaceId: "studio" }, "grant"), false);
});

test("受限服务不能冒充授予服务，拒绝后账本余额和流水保持不变", async () => {
  const repository = new InMemoryCreditLedgerRepository();
  const actor = { serviceId: "reader", workspaceId: "studio" };
  const ledger = new CreditLedgerService({ repository, clock: () => new Date("2026-10-07T00:00:00Z"),
    access: createInternalBillingAccess({ serviceId: "reader", grants: [{ workspaceId: "studio", operations: ["read"] }] }) });
  await assert.rejects(() => ledger.grant(actor, { eventId: "event", grantId: "grant", amount: 100, source: "fixture" }), { code: "FORBIDDEN" });
  await assert.rejects(() => ledger.grant({ ...actor, serviceId: "admin" }, { eventId: "event", grantId: "grant", amount: 100, source: "fixture" }), { code: "FORBIDDEN" });
  assert.deepEqual(await ledger.balance(actor), { available: 0, reserved: 0, consumed: 0, granted: 0 });
  assert.deepEqual(await ledger.entries(actor), []);
});

test("非法内部配置拒绝且错误不包含配置，非法调用默认拒绝", async () => {
  for (const policy of [null, { serviceId: "secret", grants: [{ workspaceId: "studio", operations: ["*"] }] },
    { serviceId: "worker", grants: [], extra: "secret" },
    { serviceId: "worker", grants: [{ workspaceId: "studio", operations: ["read", "read"] }] }]) {
    // Runtime trust boundary intentionally accepts hostile JavaScript inputs.
    // @ts-expect-error invalid configuration
    assert.throws(() => createInternalBillingAccess(policy), { message: "BILLING_ACCESS_CONFIG_INVALID" });
  }
  const access = createInternalBillingAccess({ serviceId: "worker", grants: [{ workspaceId: "studio", operations: ["read"] }] });
  // @ts-expect-error hostile actor
  assert.equal(await access.authorize(null, "read"), false);
  assert.equal(await access.authorize({ serviceId: "worker", workspaceId: "studio", extra: true } as never, "read"), false);
});

test("服务器配置外部修改不能扩大已有授权，空授权全部拒绝", async () => {
  const policy = { serviceId: "worker", grants: [{ workspaceId: "studio", operations: ["read" as const] }] };
  const access = createInternalBillingAccess(policy);
  policy.serviceId = "attacker";
  policy.grants[0]!.workspaceId = "other";
  assert.equal(await access.authorize({ serviceId: "worker", workspaceId: "studio" }, "read"), true);
  assert.equal(await access.authorize({ serviceId: "attacker", workspaceId: "other" }, "read"), false);
  assert.equal(await createInternalBillingAccess({ serviceId: "worker", grants: [] }).authorize({ serviceId: "worker", workspaceId: "studio" }, "read"), false);
});
