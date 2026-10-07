import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresModelRateLimiter } from "../src/model-rate-limit.ts";

test("限流存储故障拒绝请求且不泄露数据库细节", async () => {
  const limiter = new PostgresModelRateLimiter({ connect: async () => { throw new Error("private-url"); } });
  await assert.rejects(() => limiter.consume("w", "configure"), { message: "STORAGE_UNAVAILABLE" });
});

test("工作室跨实例共享原子额度，操作分别计数且窗口结束恢复", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: "-c role=novel_app" });
  const workspace = randomUUID();
  try {
    await admin.query("do $$ begin if not exists(select 1 from pg_roles where rolname='novel_app') then create role novel_app nologin; end if; exception when duplicate_object then null; end $$");
    await admin.query(await readFile(new URL("../migrations/0001_model_rate_limits.sql", import.meta.url), "utf8"));
    await admin.query(await readFile(new URL("../migrations/0002_generation_rate_limits.sql", import.meta.url), "utf8"));
    const a = new PostgresModelRateLimiter(pool), b = new PostgresModelRateLimiter(pool);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).consume(workspace, "configure")));
    assert.equal(results.filter(r => r.allowed).length, 10);
    const denied = results.find(r => !r.allowed)!;
    assert.ok(denied.retryAfterSeconds! >= 1 && denied.retryAfterSeconds! <= 60);
    const probes = await Promise.all(Array.from({ length: 8 }, () => b.consume(workspace, "test")));
    assert.equal(probes.filter(r => r.allowed).length, 5);
    assert.equal((await a.consume(randomUUID(), "configure")).allowed, true);
    await admin.query("update model_rate_limits set window_started_at=now()-interval '61 seconds' where workspace_id=$1", [workspace]);
    assert.equal((await b.consume(workspace, "configure")).allowed, true);
    const generation = await Promise.all(Array.from({ length: 20 },(_,i) => (i % 2 ? a : b).consume(workspace,"generate")));
    assert.equal(generation.filter(r => r.allowed).length,10);
    assert.equal((await a.consume(workspace,"generate")).allowed,false);
    await assert.rejects(() => pool.query("select * from model_rate_limits"));
    await assert.rejects(() => pool.query("update model_rate_limits set request_count=1"));
    await assert.rejects(() => pool.query("delete from model_rate_limits"));
    await assert.rejects(() => pool.query("select * from public.consume_model_rate($1,$2)", [workspace, "invalid"]));
  } finally { await pool.end(); await admin.end(); }
});
