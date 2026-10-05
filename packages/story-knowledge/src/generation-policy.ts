import type { Pool, PoolClient } from "pg";
import type { Actor } from "./index.ts";

/** Read-only server adapter. Verdict updates require a separate trusted database administrator. */
export class PostgresGenerationPolicyReader {
  private readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }
  async isAllowed(actor: Actor, projectId: string, chapterId: string, sourceVersionId: string): Promise<boolean> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query("begin");
      await client.query("set local statement_timeout='5s'");
      await client.query("select set_config('app.current_user_id',$1,true),set_config('app.current_workspace_id',$2,true)", [actor.userId,actor.workspaceId]);
      const result = await client.query("select public.generation_allowed_locked($1,$2,$3,$4) as allowed", [actor.workspaceId,projectId,chapterId,sourceVersionId]);
      await client.query("commit");
      return result.rows[0]?.allowed === true;
    } catch {
      try { await client?.query("rollback"); } catch { /* Preserve a secret-free failure. */ }
      throw new Error("GENERATION_POLICY_UNAVAILABLE");
    } finally { client?.release(); }
  }
}
