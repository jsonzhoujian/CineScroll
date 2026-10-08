import assert from "node:assert/strict";
import test from "node:test";
import { assertEvidenceSourceDatabase } from "../src/evidence-source-database-readiness.ts";

function catalogPool(drift: string | null = null) {
  const statements: string[] = [];
  let released = false;
  return { statements, get released() { return released; }, pool: { connect: async () => ({
    query: async (sql: string) => {
      statements.push(sql);
      if (!/^(begin read only|set local |select |commit$|rollback$)/i.test(sql)) throw new Error("mutation-not-allowed");
      const tag = /\/\* source-d1a:([a-z]+) \*\//.exec(sql)?.[1];
      return { rows: tag ? [{ ready: tag !== drift }] : [] };
    }, release: () => { released = true; },
  }) } };
}

test("a matching draft catalog completes without offering a data repository or mutating the database", async () => {
  const db = catalogPool();
  assert.equal(await assertEvidenceSourceDatabase(db.pool), undefined);
  assert.ok(db.statements.includes("begin read only"));
  assert.ok(db.statements.includes("commit"));
  assert.equal(db.released, true);
});

test("missing or permissive source tables refuse startup without attempting repair", async () => {
  const db = catalogPool("tables");
  await assert.rejects(assertEvidenceSourceDatabase(db.pool), { message: "EVIDENCE_SOURCE_DATABASE_NOT_READY" });
  assert.ok(db.statements.includes("rollback"));
  assert.equal(db.released, true);
});

test("an unsafe inspector role catalog decision refuses startup", async () => {
  const db = catalogPool("roles");
  await assert.rejects(assertEvidenceSourceDatabase(db.pool), { message: "EVIDENCE_SOURCE_DATABASE_NOT_READY" });
  assert.equal(db.released, true);
});

test("column, constraint or index drift refuses the draft catalog", async () => {
  const db = catalogPool("structure");
  await assert.rejects(assertEvidenceSourceDatabase(db.pool), { message: "EVIDENCE_SOURCE_DATABASE_NOT_READY" });
});

test("disabled or altered closed-state functions and triggers refuse startup", async () => {
  const db = catalogPool("guards");
  await assert.rejects(assertEvidenceSourceDatabase(db.pool), { message: "EVIDENCE_SOURCE_DATABASE_NOT_READY" });
});

test("connection, query and cleanup failures expose only the fixed readiness error", async () => {
  await assert.rejects(assertEvidenceSourceDatabase({ connect: async () => { throw new Error("private-connection"); } }), { message: "EVIDENCE_SOURCE_DATABASE_NOT_READY" });
  const db = catalogPool();
  const client = await db.pool.connect();
  client.release = () => { throw new Error("private-release"); };
  await assert.rejects(assertEvidenceSourceDatabase({ connect: async () => client }), { message: "EVIDENCE_SOURCE_DATABASE_NOT_READY" });
});

test("query and release methods stay bound despite dependency mutation during waits", async () => {
  const db = catalogPool(); const client = await db.pool.connect();
  const original = client.query.bind(client);
  client.query = async sql => {
    client.query = async () => { throw new Error("replaced-query"); };
    client.release = () => { throw new Error("replaced-release"); };
    return original(sql);
  };
  await assertEvidenceSourceDatabase({ connect: async () => client });
  assert.equal(db.released, true);
});

test("non-boolean or missing catalog decisions fail closed and a failed session is discarded", async () => {
  for (const rows of [[], [{ ready: "true" }], [{ ready: null }], [{ ready: true }, { ready: true }]]) {
    let destroyed = false;
    await assert.rejects(assertEvidenceSourceDatabase({ connect: async () => ({
      query: async () => ({ rows }), release: (discard?: boolean) => { destroyed = discard === true; },
    }) }), { message: "EVIDENCE_SOURCE_DATABASE_NOT_READY" });
    assert.equal(destroyed, true);
  }
});

test("catalog and rollback errors are sanitized while the failed connection is discarded", async () => {
  let destroyed = false;
  await assert.rejects(assertEvidenceSourceDatabase({ connect: async () => ({
    query: async (sql: string) => {
      if (sql.startsWith("select") || sql === "rollback") throw new Error("private-catalog-path");
      return { rows: [] };
    }, release: (discard?: boolean) => { destroyed = discard === true; },
  }) }), { message: "EVIDENCE_SOURCE_DATABASE_NOT_READY" });
  assert.equal(destroyed, true);
});
