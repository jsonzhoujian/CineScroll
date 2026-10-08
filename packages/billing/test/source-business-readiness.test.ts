import assert from "node:assert/strict";
import test from "node:test";
import { assertIsolatedBusinessFixtureDatabase } from "./support/source-business-readiness.ts";

test("combined catalog preflight binds client methods and only commits a strict ready profile", async () => {
  const statements: string[] = [];
  const client = {
    async query(sql: string) {
      statements.push(sql);
      client.query = async () => { throw new Error("changed method"); };
      return { rows: [{ ready: true }] };
    },
    release(destroy?: boolean) { assert.equal(destroy, false); },
  };
  await assertIsolatedBusinessFixtureDatabase({ async connect() { return client; } });
  assert.equal(statements.length, 5);
  assert.match(statements[0]!, /^begin read only/);
  assert.equal(statements[4], "commit");
});

test("query, commit, rollback and release failures retain only the public preflight error", async () => {
  for (let failedStage = 0; failedStage < 5; failedStage++) {
    let stage = 0, destroyed = false;
    await assert.rejects(assertIsolatedBusinessFixtureDatabase({ async connect() { return {
      async query(sql: string) {
        if (sql === "rollback" || stage++ === failedStage) throw new Error("private database diagnostics");
        return { rows: [{ ready: true }] };
      },
      release(flag?: boolean) { destroyed = flag === true; },
    }; } }), { message: "BUSINESS_FIXTURE_DATABASE_NOT_READY" });
    assert.equal(destroyed, true);
  }
  await assert.rejects(assertIsolatedBusinessFixtureDatabase({ async connect() { return {
    async query() { return { rows: [{ ready: true }] }; },
    release() { throw new Error("private release detail"); },
  }; } }), { message: "BUSINESS_FIXTURE_DATABASE_NOT_READY" });
});

test("combined preflight rolls back, destroys failed sessions and never exposes storage errors", async () => {
  for (const rows of [[], [{ ready: false }], [{ ready: "true" }], [{ ready: true }, { ready: true }]]) {
    const statements: string[] = [];
    let destroyed = false;
    await assert.rejects(assertIsolatedBusinessFixtureDatabase({ async connect() { return {
      async query(sql: string) { statements.push(sql); return { rows }; },
      release(flag?: boolean) { destroyed = flag === true; },
    }; } }), { message: "BUSINESS_FIXTURE_DATABASE_NOT_READY" });
    assert.equal(statements.at(-1), "rollback");
    assert.equal(destroyed, true);
  }
  await assert.rejects(assertIsolatedBusinessFixtureDatabase({ async connect() { throw new Error("secret storage detail"); } }), { message: "BUSINESS_FIXTURE_DATABASE_NOT_READY" });
});
