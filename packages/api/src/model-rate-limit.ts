import { ModelSettingsError } from "@novel-adaptation/script/model-settings";
import type { ModelSettingsPool, ModelSettingsClient } from "@novel-adaptation/script/postgres-model-settings";

export interface ModelRateLimiter {
  consume(workspaceId: string, action: "configure" | "test"): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

/** Shared database-time window; no in-memory fallback. */
export class PostgresModelRateLimiter implements ModelRateLimiter {
  readonly #pool: ModelSettingsPool;
  constructor(pool: ModelSettingsPool) { this.#pool = pool; }
  async consume(workspaceId: string, action: "configure" | "test") {
    let client: ModelSettingsClient | undefined;
    try {
      client = await this.#pool.connect();
      await client.query("begin");
      await client.query("set local statement_timeout='5s'");
      const row = (await client.query("select * from public.consume_model_rate($1,$2)", [workspaceId, action])).rows[0];
      if (!row || typeof row.allowed !== "boolean" || !Number.isInteger(row.retry_after) || Number(row.retry_after) < 0 || Number(row.retry_after) > 60) throw new Error("invalid rate result");
      await client.query("commit");
      return { allowed: row.allowed, retryAfterSeconds: Number(row.retry_after) };
    } catch {
      try { await client?.query("rollback"); } catch { /* Keep details private. */ }
      throw new ModelSettingsError("STORAGE_UNAVAILABLE");
    } finally { client?.release(); }
  }
}
