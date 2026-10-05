import type { Actor } from "./index.ts";
import { ModelSettingsError } from "./model-settings.ts";
import type { ModelSettingsPool, ModelSettingsClient } from "./postgres-model-settings.ts";

/** Read-only authority for BYOK; manual administration is outside the application role. */
export class PostgresWorkspaceModelAccess {
  readonly #pool: ModelSettingsPool;
  constructor(pool: ModelSettingsPool) { this.#pool = pool; }
  async read(actor: Actor): Promise<{ owner: boolean; advanced: boolean } | null> {
    let client: ModelSettingsClient | undefined;
    try {
      client = await this.#pool.connect(); await client.query("begin"); await client.query("set local statement_timeout='5s'");
      await client.query("select set_config('app.model_workspace_id',$1,true),set_config('app.model_user_id',$2,true)", [actor.workspaceId, actor.userId]);
      const result = await client.query(`select m.role='owner' as owner,
        coalesce(e.plan='advanced' and e.enabled and e.starts_at<=now() and e.expires_at>now(),false) as advanced
        from workspace_model_members m left join workspace_model_entitlements e on e.workspace_id=m.workspace_id
        where m.workspace_id=$1 and m.user_id=$2 and m.active`, [actor.workspaceId, actor.userId]);
      await client.query("commit");
      const row = result.rows[0];
      return row && typeof row.owner === "boolean" && typeof row.advanced === "boolean" ? { owner: row.owner, advanced: row.advanced } : null;
    } catch {
      try { await client?.query("rollback"); } catch { /* Hide database details. */ }
      throw new ModelSettingsError("STORAGE_UNAVAILABLE");
    } finally { client?.release(); }
  }
}
