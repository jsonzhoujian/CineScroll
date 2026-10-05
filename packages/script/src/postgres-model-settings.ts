import { ModelSettingsError, type ModelConfiguration, type ModelSettingsRepository } from "./model-settings.ts";

/** Structural pg Pool seam; production supplies an existing server-owned connection pool. */
export interface ModelSettingsClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}
export interface ModelSettingsPool { connect(): Promise<ModelSettingsClient>; }

/** Internal credential repository, never a member-facing API. Owner/entitlement checks remain in the service. */
export class PostgresModelSettingsRepository implements ModelSettingsRepository {
  readonly #pool: ModelSettingsPool;
  constructor(pool: ModelSettingsPool) { this.#pool = pool; }
  async find(workspaceId: string): Promise<ModelConfiguration | null> {
    return this.#transaction(workspaceId, async (client) => {
      const result = await client.query(`select v.configuration from model_settings_heads h
        join model_settings_versions v on v.workspace_id=h.workspace_id and v.id=h.active_version_id
        where h.workspace_id=$1`, [workspaceId]);
      return result.rows[0] ? structuredClone(result.rows[0].configuration as ModelConfiguration) : null;
    });
  }
  async save(config: ModelConfiguration, expectedVersionId: string | null): Promise<ModelConfiguration> {
    if (config.parentVersionId !== expectedVersionId || !config.workspaceId || !config.id || !config.createdBy) throw new ModelSettingsError("INVALID_CONFIGURATION");
    const snapshot = structuredClone(config);
    return this.#transaction(snapshot.workspaceId, async (client) => {
      await client.query("insert into model_settings_heads(workspace_id) values($1) on conflict do nothing", [snapshot.workspaceId]);
      const result = await client.query("select active_version_id from model_settings_heads where workspace_id=$1 for update", [snapshot.workspaceId]);
      if (!result.rows[0] || (result.rows[0].active_version_id ?? null) !== expectedVersionId) throw new ModelSettingsError("VERSION_CONFLICT");
      await client.query(`insert into model_settings_versions(workspace_id,id,parent_version_id,configuration)
        values($1,$2,$3,$4::jsonb)`, [snapshot.workspaceId, snapshot.id, snapshot.parentVersionId, JSON.stringify(snapshot)]);
      await client.query("update model_settings_heads set active_version_id=$2 where workspace_id=$1", [snapshot.workspaceId, snapshot.id]);
      await client.query(`insert into model_settings_audit(workspace_id,version_id,actor_id,operation)
        values($1,$2,$3,$4)`, [snapshot.workspaceId, snapshot.id, snapshot.createdBy, snapshot.tested ? "connection_tested" : "configured"]);
      return structuredClone(snapshot);
    });
  }
  async #transaction<T>(workspaceId: string, action: (client: ModelSettingsClient) => Promise<T>): Promise<T> {
    let client: ModelSettingsClient | undefined;
    try {
      client = await this.#pool.connect();
      await client.query("begin"); await client.query("set local statement_timeout='5s'");
      await client.query("select set_config('app.model_workspace_id',$1,true)", [workspaceId]);
      const result = await action(client); await client.query("commit"); return result;
    } catch (error) {
      try { await client?.query("rollback"); } catch { /* Preserve a sanitized original failure. */ }
      if (error instanceof ModelSettingsError) throw error;
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") throw new ModelSettingsError("VERSION_CONFLICT");
      throw new ModelSettingsError("STORAGE_UNAVAILABLE");
    } finally { client?.release(); }
  }
}
