import { CreditLedgerError, type CreditLedgerRepository, type LedgerAggregate } from "./index.ts";

export interface LedgerDatabaseClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string,unknown>[] }>;
  release(): void;
}
export interface LedgerDatabasePool { connect(): Promise<LedgerDatabaseClient> }

/** Trusted server pool only; caller owns its lifecycle and restricted login/TLS configuration. */
export class PostgresCreditLedgerRepository implements CreditLedgerRepository {
  readonly #pool: LedgerDatabasePool;
  constructor(pool: LedgerDatabasePool) { this.#pool = pool; }
  read(workspaceId: string): Promise<LedgerAggregate> {
    return this.#transaction(workspaceId,async client => {
      const result = await client.query(`select v.state_json from public.credit_ledger_heads h
        join public.credit_ledger_versions v on v.workspace_id=h.workspace_id and v.revision=h.active_revision
        where h.workspace_id=$1`,[workspaceId]);
      return result.rows[0] ? structuredClone(result.rows[0].state_json) as LedgerAggregate
        : { revision: 0,entries: [],tasks: [],events: [],evidence: [] };
    });
  }
  async compareAndSwap(workspaceId: string, expectedRevision: number, next: LedgerAggregate): Promise<boolean> {
    let json: string;
    const revision = expectedRevision + 1;
    try {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || next.revision !== expectedRevision + 1
        || !Number.isSafeInteger(next.revision)) throw new Error();
      json = JSON.stringify(next);
      if (Buffer.byteLength(json,"utf8") > 2_000_000) throw new Error();
    } catch { throw new CreditLedgerError("INVALID_COMMAND"); }
    return this.#transaction(workspaceId,async client => {
      await client.query("insert into public.credit_ledger_heads(workspace_id) values($1) on conflict do nothing",[workspaceId]);
      const head = (await client.query("select active_revision from public.credit_ledger_heads where workspace_id=$1 for update",[workspaceId])).rows[0];
      if (!head || Number(head.active_revision ?? 0) !== expectedRevision) return false;
      await client.query("insert into public.credit_ledger_versions(workspace_id,revision,state_json) values($1,$2,$3::jsonb)",[workspaceId,revision,json]);
      await client.query("update public.credit_ledger_heads set active_revision=$2 where workspace_id=$1",[workspaceId,revision]);
      return true;
    });
  }
  async #transaction<T>(workspaceId: string, action: (client: LedgerDatabaseClient) => Promise<T>): Promise<T> {
    if (typeof workspaceId !== "string" || !workspaceId.trim() || workspaceId.length > 256 || /[\r\n]/.test(workspaceId)) throw new CreditLedgerError("INVALID_COMMAND");
    let client: LedgerDatabaseClient | undefined;
    try {
      client = await this.#pool.connect();
      await client.query("begin"); await client.query("set local statement_timeout='5s'");
      await client.query("select set_config('app.billing_workspace_id',$1,true)",[workspaceId]);
      const value = await action(client); await client.query("commit"); return value;
    } catch (error) {
      await client?.query("rollback").catch(() => {});
      if (error instanceof CreditLedgerError) throw error;
      throw new CreditLedgerError("STORAGE_UNAVAILABLE");
    } finally { client?.release(); }
  }
}
