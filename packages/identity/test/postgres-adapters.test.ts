import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";

import { PostgresIdentityRepository, PostgresLoginChallengeStore, PostgresLoginRateLimiter } from "../src/postgres-adapters.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;

integration("PostgreSQL 原子保存身份、一次性 challenge 和多维限流", async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    await pool.query(await readFile(new URL("../migrations/0001_identity.sql", import.meta.url), "utf8"));
    await pool.query("truncate identity_accounts, login_challenges, login_rate_limits");
    const repository = new PostgresIdentityRepository(pool);
    let created = 0;
    const accounts = await Promise.all([1, 2].map(() => repository.findOrCreateByPhone("+8613800138000", () => ({
      userId: `usr_${++created}`, workspaceId: `wsp_${created}`, phone: "+8613800138000",
    }))));
    assert.equal(new Set(accounts.map(({ userId }) => userId)).size, 1);
    assert.deepEqual(await repository.findActorByUserId(accounts[0]!.userId), {
      userId: accounts[0]!.userId,
      workspaceId: accounts[0]!.workspaceId,
    });
    assert.equal(await repository.findActorByUserId("usr_missing"), null);

    const second = await repository.findOrCreateByPhone("+8613900139000", () => ({
      userId: "usr_second", workspaceId: "wsp_second", phone: "+8613900139000",
    }));
    await repository.bindWechat(accounts[0]!, { openId: "open-1", unionId: "union-1" });
    const reused = await repository.findOrCreateByWechat({ openId: "open-1", unionId: "union-1" }, () => ({
      userId: "usr_unused", workspaceId: "wsp_unused", wechatOpenId: "open-1",
    }));
    assert.equal(reused.userId, accounts[0]!.userId);
    await repository.bindWechat(second, { openId: "open-2", unionId: "union-2" });
    await assert.rejects(
      () => repository.findOrCreateByWechat({ openId: "open-1", unionId: "union-2" }, () => ({
        userId: "usr_conflict", workspaceId: "wsp_conflict", wechatOpenId: "open-1", wechatUnionId: "union-2",
      })),
      { code: "IDENTITY_ALREADY_BOUND" },
    );
    await assert.rejects(
      () => repository.bindWechat(second, { openId: "open-1", unionId: "union-1" }),
      { code: "IDENTITY_ALREADY_BOUND" },
    );

    const challenges = new PostgresLoginChallengeStore(pool);
    await challenges.save({ kind: "phone", id: "ch_1", phone: "+8613800138000", expiresAt: new Date(Date.now() + 60_000).toISOString(), consumed: false, failedAttempts: 0 });
    const consumed = await Promise.all([challenges.consume("ch_1"), challenges.consume("ch_1")]);
    assert.equal(consumed.filter(Boolean).length, 1);

    const limiter = new PostgresLoginRateLimiter(pool, { phone: 1, ip: 10, device: 10, windowMs: 60_000 });
    const input = { phone: "+8613800138000", ipAddress: "203.0.113.8", deviceId: "d1", action: "send" as const, now: new Date() };
    assert.equal((await limiter.consume(input)).allowed, true);
    assert.equal((await limiter.consume(input)).allowed, false);

    const concurrentInput = { ...input, phone: "+8613900139000", ipAddress: "203.0.113.9", deviceId: "d2" };
    const concurrent = await Promise.all([limiter.consume(concurrentInput), limiter.consume(concurrentInput)]);
    assert.deepEqual(concurrent.map(({ allowed }) => allowed).sort(), [false, true]);

    const ipLimiter = new PostgresLoginRateLimiter(pool, { phone: 10, ip: 1, device: 10, windowMs: 60_000 });
    assert.equal((await ipLimiter.consume({ ...input, phone: "+8613600136000", ipAddress: "203.0.113.20", deviceId: "ip-d1" })).allowed, true);
    assert.equal((await ipLimiter.consume({ ...input, phone: "+8613700137000", ipAddress: "203.0.113.20", deviceId: "ip-d2" })).allowed, false);

    const deviceLimiter = new PostgresLoginRateLimiter(pool, { phone: 10, ip: 10, device: 1, windowMs: 60_000 });
    assert.equal((await deviceLimiter.consume({ ...input, phone: "+8613500135000", ipAddress: "203.0.113.21", deviceId: "shared-device" })).allowed, true);
    assert.equal((await deviceLimiter.consume({ ...input, phone: "+8613400134000", ipAddress: "203.0.113.22", deviceId: "shared-device" })).allowed, false);
  } finally { await pool.end(); }
});
