import assert from "node:assert/strict";
import test from "node:test";
import { createIsolatedSourceBusinessAssembly } from "./support/source-business-assembly.ts";
const config = () => ({ connectionString: "postgresql://test_admin@localhost/d1b_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?host=/private/tmp/source-d1b.ABC123&port=56444",
  inspectorLogin: "d1b_login_inspector_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", workspaceId: "studio", allowedProducerServiceIds: ["producer"] });

test("assembly refuses nonisolated endpoints and unsafe configuration without exposing its connection string", () => {
  for (const endpoint of [
    "postgresql://secret:secret@localhost/d1b_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?host=/private/tmp/source-d1b.ABC123&port=56444",
    "postgresql://test_admin@localhost/production?host=/private/tmp/source-d1b.ABC123&port=56444",
    "postgresql://test_admin@localhost/d1b_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?host=127.0.0.1&port=56444",
    `${config().connectionString}&options=-c%20role=novel_d1b_owner`,
    `${config().connectionString}&port=56445`,
  ]) assert.throws(() => createIsolatedSourceBusinessAssembly({ ...config(), connectionString: endpoint }), { code: "INVALID_CONFIG", message: "INVALID_CONFIG" });
  for (const producers of [[], ["producer","producer"], ["bad\u0000id"], new Array(1)])
    assert.throws(() => createIsolatedSourceBusinessAssembly({ ...config(), allowedProducerServiceIds: producers }), { code: "INVALID_CONFIG" });
  let calls = 0;
  const getter = config(); Object.defineProperty(getter,"connectionString",{ enumerable: true, get() { calls++; return "secret"; } });
  assert.throws(() => createIsolatedSourceBusinessAssembly(getter), { code: "INVALID_CONFIG" });
  assert.equal(calls,0);
});

test("assembly close is idempotent and closed reads do not attempt a connection", async () => {
  const assembly = createIsolatedSourceBusinessAssembly(config());
  await Promise.all([assembly.close(),assembly.close()]);
  await assert.rejects(assembly.read({}), { code: "CLOSED" });
});
