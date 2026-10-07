import { EvidenceMaterialRepositoryError, prepareEvidenceMaterial, type EvidenceMaterialRepository, type StoredEvidenceMaterial } from "./evidence-material-repository.ts";
import type { LedgerDatabaseClient, LedgerDatabasePool } from "./postgres-ledger.ts";

/** Restricted trusted-host pool; no migrations, authorization or pool lifecycle management. */
export class PostgresEvidenceMaterialRepository implements EvidenceMaterialRepository {
  readonly #pool: LedgerDatabasePool;
  constructor(pool: LedgerDatabasePool) { this.#pool = { connect: pool.connect.bind(pool) }; }
  async append(workspaceId: string, input: unknown, predecessorId: string | null = null): Promise<StoredEvidenceMaterial> {
    const prepared = await prepareEvidenceMaterial(workspaceId, input, predecessorId);
    const material = prepared.material as Record<string, unknown>, evidenceId = material.id as string;
    const json = JSON.stringify(material);
    if (Buffer.byteLength(json, "utf8") > 2_000_000) throw new EvidenceMaterialRepositoryError("INVALID_MATERIAL");
    if (predecessorId === evidenceId) throw new EvidenceMaterialRepositoryError("CONFLICT");
    return this.#transaction(workspaceId, async client => {
      // PostgreSQL's unique conflict wait followed by a new statement snapshot observes the winner.
      await client.query("insert into public.evidence_material(workspace_id,evidence_id,material,fingerprint,predecessor_id) values($1,$2,$3::jsonb,$4,$5) on conflict do nothing",
        [workspaceId, evidenceId, json, prepared.fingerprint, predecessorId]);
      const stored = await this.#get(client, workspaceId, evidenceId);
      if (!stored || stored.fingerprint !== prepared.fingerprint) throw new EvidenceMaterialRepositoryError("CONFLICT");
      return stored;
    });
  }
  get(workspaceId: string, evidenceId: string): Promise<StoredEvidenceMaterial | null> {
    if (typeof evidenceId !== "string" || !evidenceId || evidenceId.length > 256 || evidenceId.trim() !== evidenceId || /[\r\n]/.test(evidenceId)) {
      return Promise.reject(new EvidenceMaterialRepositoryError("INVALID_MATERIAL"));
    }
    return this.#transaction(workspaceId, client => this.#get(client, workspaceId, evidenceId));
  }
  async read(workspaceId: string, evidenceId: string): Promise<unknown> { return (await this.get(workspaceId, evidenceId))?.material ?? null; }
  async #get(client: LedgerDatabaseClient, workspaceId: string, evidenceId: string): Promise<StoredEvidenceMaterial | null> {
    const row = (await client.query("select material,fingerprint,predecessor_id from public.evidence_material where workspace_id=$1 and evidence_id=$2", [workspaceId, evidenceId])).rows[0];
    if (!row) return null;
    const prepared = await prepareEvidenceMaterial(workspaceId, row.material, row.predecessor_id as string | null);
    if ((prepared.material as Record<string, unknown>).id !== evidenceId || prepared.fingerprint !== row.fingerprint) throw new EvidenceMaterialRepositoryError("CONFLICT");
    return prepared;
  }
  async #transaction<T>(workspaceId: string, run: (client: LedgerDatabaseClient) => Promise<T>): Promise<T> {
    if (typeof workspaceId !== "string" || !workspaceId || workspaceId.trim() !== workspaceId || workspaceId.length > 256 || /[\r\n]/.test(workspaceId)) throw new EvidenceMaterialRepositoryError("INVALID_MATERIAL");
    let client: LedgerDatabaseClient | undefined;
    try {
      client = await this.#pool.connect();
      await client.query("begin isolation level read committed");
      await client.query("set local statement_timeout='5s'"); await client.query("set local search_path=pg_catalog");
      await client.query("select set_config('app.evidence_workspace_id',$1,true)", [workspaceId]);
      const value = await run(client); await client.query("commit"); return value;
    } catch (error) {
      await client?.query("rollback").catch(() => {});
      if (error instanceof EvidenceMaterialRepositoryError) throw error;
      const code = (error as { code?: string } | null)?.code;
      if (code === "P0002") throw new EvidenceMaterialRepositoryError("PREDECESSOR_NOT_FOUND");
      if (code === "P0001") throw new EvidenceMaterialRepositoryError("CONFLICT");
      throw new EvidenceMaterialRepositoryError("STORAGE_UNAVAILABLE");
    } finally { client?.release(); }
  }
}
