import assert from "node:assert/strict";
import test from "node:test";
import { assertSourceIngestDraftDatabase } from "../src/index.ts";

test("a closed D1b profile is checked in a read-only transaction without returning a writer", async () => {
  const statements: string[] = []; let released: boolean | undefined;
  const pool = { connect: async () => ({ query: async (sql: string) => {
    statements.push(sql);
    assert.match(sql, /^(begin read only|set local |select |commit$|rollback$)/i);
    return { rows: sql.startsWith("select") ? [{ ready: true }] : [] };
  }, release: (destroy?: boolean) => { released = destroy; } }) };
  assert.equal(await assertSourceIngestDraftDatabase(pool), undefined);
  assert.ok(statements.includes("begin read only")); assert.ok(statements.includes("commit"));
  assert.equal(released, false);
});

test("only a single strict true catalog decision is accepted", async () => {
  for (const rows of [[], [{ ready: "true" }], [{ ready: 1 }], [{ ready: null }], [{ ready: true }, { ready: true }]]) {
    let discarded = false;
    await assert.rejects(assertSourceIngestDraftDatabase({ connect: async () => ({
      query: async () => ({ rows }), release: (destroy?: boolean) => { discarded = destroy === true; },
    }) }), { message: "SOURCE_INGEST_DRAFT_DATABASE_NOT_READY" });
    assert.equal(discarded, true);
  }
});

test("connect, query, commit, rollback and release failures expose only the fixed error", async () => {
  await assert.rejects(assertSourceIngestDraftDatabase({ connect: async () => { throw new Error("private URL"); } }),
    { message: "SOURCE_INGEST_DRAFT_DATABASE_NOT_READY" });
  for (const failure of ["select", "commit"]) {
    let discarded = false;
    await assert.rejects(assertSourceIngestDraftDatabase({ connect: async () => ({
      query: async (sql: string) => {
        if (sql.startsWith(failure) || sql === "rollback") throw new Error("private catalog diagnostic");
        return { rows: [{ ready: true }] };
      }, release: (destroy?: boolean) => { discarded = destroy === true; },
    }) }), { message: "SOURCE_INGEST_DRAFT_DATABASE_NOT_READY" });
    assert.equal(discarded, true);
  }
  await assert.rejects(assertSourceIngestDraftDatabase({ connect: async () => ({
    query: async () => ({ rows: [{ ready: true }] }), release: () => { throw new Error("private release error"); },
  }) }), { message: "SOURCE_INGEST_DRAFT_DATABASE_NOT_READY" });
});

test("query and release implementations stay fixed during asynchronous waits", async () => {
  let released = false;
  const client = { query: async (sql: string) => {
    client.query = async () => { throw new Error("replaced query"); };
    client.release = () => { throw new Error("replaced release"); };
    return { rows: sql.startsWith("select") ? [{ ready: true }] : [] };
  }, release: () => { released = true; } };
  await assertSourceIngestDraftDatabase({ connect: async () => client });
  assert.equal(released, true);
});

test("role or catalog refusal rolls back and destroys the failed session", async () => {
  for (const stage of ["roles", "catalog"]) {
    let discarded = false; const statements: string[] = [];
    await assert.rejects(assertSourceIngestDraftDatabase({ connect: async () => ({
      query: async (sql: string) => { statements.push(sql); return { rows: [{ ready: !sql.includes(`source-d1b:${stage}`) }] }; },
      release: (destroy?: boolean) => { discarded = destroy === true; },
    }) }), { message: "SOURCE_INGEST_DRAFT_DATABASE_NOT_READY" });
    assert.equal(discarded, true); assert.ok(statements.includes("rollback")); assert.ok(!statements.includes("commit"));
  }
});
