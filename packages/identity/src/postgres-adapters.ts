import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { Actor, IdentityAccount, IdentityRepository, LoginChallenge, LoginChallengeStore, LoginRateLimiter } from "./index.ts";
import { IdentityError } from "./index.ts";

export class PostgresIdentityRepository implements IdentityRepository {
  private readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }

  async findOrCreateByPhone(phone: string, create: () => IdentityAccount) {
    const candidate = create();
    await this.pool.query(
      `insert into identity_accounts (user_id, workspace_id, phone) values ($1,$2,$3)
       on conflict (phone) do nothing`,
      [candidate.userId, candidate.workspaceId, phone],
    );
    return accountFrom((await this.pool.query<AccountRow>("select * from identity_accounts where phone = $1", [phone])).rows[0]!);
  }

  async findOrCreateByWechat(identity: { openId: string; unionId?: string }, create: () => IdentityAccount) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await lockWechatIdentity(client, identity);
      let account = await resolveWechatIdentity(client, identity);
      if (!account) {
        const candidate = create();
        const inserted = await client.query<AccountRow>(
          `insert into identity_accounts (user_id, workspace_id, wechat_open_id, wechat_union_id)
           values ($1,$2,$3,$4) returning *`,
          [candidate.userId, candidate.workspaceId, identity.openId, identity.unionId ?? null],
        );
        account = inserted.rows[0]!;
      } else {
        account = (await client.query<AccountRow>(
          `update identity_accounts
           set wechat_open_id = coalesce(wechat_open_id, $1),
               wechat_union_id = coalesce(wechat_union_id, $2)
           where user_id = $3 returning *`,
          [identity.openId, identity.unionId ?? null, account.user_id],
        )).rows[0]!;
      }
      await client.query("commit");
      return accountFrom(account);
    } catch (error) {
      await client.query("rollback");
      if ((error as { code?: string }).code === "23505") {
        throw new IdentityError("IDENTITY_ALREADY_BOUND", "微信身份关联存在冲突");
      }
      throw error;
    } finally { client.release(); }
  }

  async bindWechat(actor: Actor, identity: { openId: string; unionId?: string }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await lockWechatIdentity(client, identity);
      const resolved = await resolveWechatIdentity(client, identity);
      if (resolved && (resolved.user_id !== actor.userId || resolved.workspace_id !== actor.workspaceId)) {
        throw new IdentityError("IDENTITY_ALREADY_BOUND", "该微信已绑定其他账号");
      }
      const result = await client.query(
        `update identity_accounts set wechat_open_id = $1, wechat_union_id = $2
         where user_id = $3 and workspace_id = $4`,
        [identity.openId, identity.unionId ?? null, actor.userId, actor.workspaceId],
      );
      if (result.rowCount === 0) throw new IdentityError("ACCOUNT_NOT_FOUND", "账号不存在");
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      if (error instanceof IdentityError) throw error;
      if ((error as { code?: string }).code === "23505") {
        throw new IdentityError("IDENTITY_ALREADY_BOUND", "该微信已绑定其他账号");
      }
      throw error;
    } finally { client.release(); }
  }
}

async function lockWechatIdentity(client: PoolClient, identity: { openId: string; unionId?: string }) {
  const keys = [`openid:${identity.openId}`, ...(identity.unionId ? [`unionid:${identity.unionId}`] : [])].sort();
  for (const key of keys) await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
}

async function resolveWechatIdentity(client: PoolClient, identity: { openId: string; unionId?: string }): Promise<AccountRow | undefined> {
  const byOpenId = (await client.query<AccountRow>("select * from identity_accounts where wechat_open_id = $1", [identity.openId])).rows[0];
  const byUnionId = identity.unionId
    ? (await client.query<AccountRow>("select * from identity_accounts where wechat_union_id = $1", [identity.unionId])).rows[0]
    : undefined;
  if (byOpenId && byUnionId && byOpenId.user_id !== byUnionId.user_id) {
    throw new IdentityError("IDENTITY_ALREADY_BOUND", "微信身份关联存在冲突");
  }
  return byOpenId ?? byUnionId;
}

export class PostgresLoginChallengeStore implements LoginChallengeStore {
  private readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }

  async save(challenge: LoginChallenge): Promise<void> {
    await this.pool.query(
      `insert into login_challenges
       (id, kind, phone, redirect_uri, bind_user_id, bind_workspace_id, expires_at, failed_attempts)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [challenge.id, challenge.kind, challenge.kind === "phone" ? challenge.phone : null,
        challenge.kind === "wechat" ? challenge.redirectUri : null,
        challenge.kind === "wechat" ? challenge.bindActor?.userId ?? null : null,
        challenge.kind === "wechat" ? challenge.bindActor?.workspaceId ?? null : null,
        challenge.expiresAt, challenge.kind === "phone" ? challenge.failedAttempts : 0],
    );
  }

  async find(id: string) { return challengeFrom((await this.pool.query<ChallengeRow>("select * from login_challenges where id = $1", [id])).rows[0]); }

  async consume(id: string) {
    const result = await this.pool.query<ChallengeRow>(
      `update login_challenges set consumed_at = now() where id = $1 and consumed_at is null and expires_at > now() returning *`, [id],
    );
    return challengeFrom(result.rows[0]);
  }

  async recordFailedAttempt(id: string, maximumAttempts: number): Promise<void> {
    await this.pool.query(
      `update login_challenges set failed_attempts = least(failed_attempts + 1, $2),
       consumed_at = case when failed_attempts + 1 >= $2 then now() else consumed_at end
       where id = $1 and kind = 'phone' and consumed_at is null`, [id, maximumAttempts],
    );
  }
}

export class PostgresLoginRateLimiter implements LoginRateLimiter {
  private readonly pool: Pool;
  private readonly limits: { phone: number; ip: number; device: number; windowMs: number };
  constructor(pool: Pool, limits = { phone: 3, ip: 10, device: 5, windowMs: 600_000 }) { this.pool = pool; this.limits = limits; }

  async consume(input: { phone: string; ipAddress: string; deviceId: string; action: "send" | "verify"; now: Date }) {
    const client = await this.pool.connect();
    const entries = [["phone", input.phone, this.limits.phone], ["ip", input.ipAddress, this.limits.ip], ["device", input.deviceId, this.limits.device]] as const;
    try {
      await client.query("begin");
      const lockKeys = entries
        .map(([dimension, value]) => `${input.action}:${dimension}:${hash(value)}`)
        .sort();
      for (const lockKey of lockKeys) {
        await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
      }
      for (const [dimension, value, limit] of entries) {
        const key = hash(value);
        const row = (await client.query<RateRow>(
          `select request_count, window_started_at from login_rate_limits
           where action=$1 and dimension=$2 and key_hash=$3 for update`, [input.action, dimension, key],
        )).rows[0];
        if (row && row.window_started_at.getTime() + this.limits.windowMs > input.now.getTime() && row.request_count >= limit) {
          await client.query("rollback");
          return { allowed: false, retryAfterSeconds: Math.ceil((row.window_started_at.getTime() + this.limits.windowMs - input.now.getTime()) / 1000) };
        }
      }
      for (const [dimension, value] of entries) await upsertRate(client, input, dimension, hash(value), this.limits.windowMs);
      await client.query("commit");
      return { allowed: true };
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
  }
}

async function upsertRate(client: PoolClient, input: { action: string; now: Date }, dimension: string, key: string, windowMs: number) {
  await client.query(
    `insert into login_rate_limits values ($1,$2,$3,$4,1)
     on conflict (action, dimension, key_hash) do update set
       window_started_at = case when login_rate_limits.window_started_at + ($5 * interval '1 millisecond') <= $4 then $4 else login_rate_limits.window_started_at end,
       request_count = case when login_rate_limits.window_started_at + ($5 * interval '1 millisecond') <= $4 then 1 else login_rate_limits.request_count + 1 end`,
    [input.action, dimension, key, input.now, windowMs],
  );
}

function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function accountFrom(row: AccountRow): IdentityAccount { return { userId: row.user_id, workspaceId: row.workspace_id, ...(row.phone ? { phone: row.phone } : {}), ...(row.wechat_open_id ? { wechatOpenId: row.wechat_open_id } : {}), ...(row.wechat_union_id ? { wechatUnionId: row.wechat_union_id } : {}) }; }
function challengeFrom(row?: ChallengeRow): LoginChallenge | null { if (!row) return null; return row.kind === "phone" ? { kind: "phone", id: row.id, phone: row.phone!, expiresAt: row.expires_at.toISOString(), consumed: Boolean(row.consumed_at), failedAttempts: row.failed_attempts } : { kind: "wechat", id: row.id, redirectUri: row.redirect_uri!, expiresAt: row.expires_at.toISOString(), consumed: Boolean(row.consumed_at), ...(row.bind_user_id && row.bind_workspace_id ? { bindActor: { userId: row.bind_user_id, workspaceId: row.bind_workspace_id } } : {}) }; }
interface AccountRow extends QueryResultRow { user_id: string; workspace_id: string; phone: string | null; wechat_open_id: string | null; wechat_union_id: string | null }
interface ChallengeRow extends QueryResultRow { id: string; kind: "phone" | "wechat"; phone: string | null; redirect_uri: string | null; bind_user_id: string | null; bind_workspace_id: string | null; expires_at: Date; consumed_at: Date | null; failed_attempts: number }
interface RateRow extends QueryResultRow { request_count: number; window_started_at: Date }
