// Isolated test tooling only. Never exported by the application package or attached to HTTP.
import type { Pool, PoolClient } from "pg";
import { prepareSourceBusinessFixture, type PreparedFixtureRecord, type FixtureTaskRevision,
  type FixtureSnapshot, type FixtureExecutionIdentity, type FixtureQuote } from "../../src/index.ts";
const schema = "source_ingest_d1b_fixture_v1";
const tables = { task: "task_revision", snapshot: "fixed_snapshot", execution: "execution_identity", quote: "fixed_quote" };
export class SourceBusinessLoadError extends Error {
  readonly code: "FORBIDDEN" | "CONFLICT" | "CAPACITY_EXCEEDED" | "UNAVAILABLE";
  constructor(code: SourceBusinessLoadError["code"]) { super(code); this.code = code; }
}
function projection(record: PreparedFixtureRecord): Record<string, unknown> {
  const d = record.document;
  const common = { workspace_id: record.workspaceId, id: record.id, version: record.version,
    task_id: d.binding.taskId, unit_id: d.binding.unitId, binding: d.binding, producer_service_id: d.producerServiceId,
    recorded_at: d.recordedAt, document: d, canonical: Buffer.from(record.canonical, "utf8"), business_fingerprint: record.businessFingerprint };
  if (record.kind === "task") {
    const task = d as FixtureTaskRevision;
    return { ...common, revision: task.revision, predecessor_version: task.predecessorVersion, scope_keys: task.scopeKeys,
      snapshot_id: task.snapshotReference.id, snapshot_version: task.snapshotReference.version,
      execution_id: task.executionReference.id, execution_version: task.executionReference.version };
  }
  if (record.kind === "execution") {
    const execution = d as FixtureExecutionIdentity;
    return { ...common, task_anchor_version: execution.taskAnchorReference.version,
      snapshot_id: execution.snapshotReference.id, snapshot_version: execution.snapshotReference.version };
  }
  const priced = d as FixtureSnapshot | FixtureQuote;
  const pricedColumns = { ...common, task_anchor_version: priced.taskAnchorReference.version,
    execution_id: priced.executionReference.id, execution_version: priced.executionReference.version,
    quote_id: priced.quoteId, price_version: priced.priceVersion, responsibility: priced.responsibility, reserved: priced.reserved };
  if (record.kind === "snapshot") {
    const snapshot = d as FixtureSnapshot;
    return { ...pricedColumns, quote_record_id: snapshot.quoteReference.id, quote_record_version: snapshot.quoteReference.version };
  }
  return { ...pricedColumns, pricing_rule_version: (d as FixtureQuote).pricingRuleVersion };
}

/** Pool and producer range are trusted test-administrator configuration, not load parameters. */
export function createIsolatedSourceBusinessLoader(pool: Pool, config: { workspaceId: string; allowedProducerServiceIds: string[] }) {
  const trusted = structuredClone(config);
  return { async load(input: unknown): Promise<{ inserted: number; replayed: number }> {
    const { records } = prepareSourceBusinessFixture(input);
    if (records.some(row => row.workspaceId !== trusted.workspaceId || !trusted.allowedProducerServiceIds.includes(row.document.producerServiceId)))
      throw new SourceBusinessLoadError("FORBIDDEN");
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query("begin isolation level read committed; set local statement_timeout='5s'; set local lock_timeout='1s'; set local search_path=pg_catalog,pg_temp");
      const profile = (await client.query(`select ((select rolsuper from pg_roles where rolname=session_user)
        and current_user=session_user and current_setting('server_version_num')::int/10000=16
        and current_setting('server_encoding')='UTF8' and current_setting('listen_addresses')=''
        and current_setting('data_directory') ~ '^/private/tmp/source-d1b\\.[A-Za-z0-9]{6}/data$'
        and current_database() ~ '^d1b_[a-f0-9]{32}$') as ok`)).rows[0]?.ok;
      if (profile !== true) throw new SourceBusinessLoadError("FORBIDDEN");
      await client.query("set local role novel_d1b_business_fixture");
      await client.query(`insert into ${schema}.workspace_budget values($1,0,0,0,0,0,0) on conflict do nothing`, [trusted.workspaceId]);
      await client.query(`select business_count from ${schema}.workspace_budget where workspace_id=$1 for update`, [trusted.workspaceId]);
      let inserted = 0, bytes = 0;
      for (const record of records) {
        const columns = projection(record), names = Object.keys(columns), values = Object.values(columns);
        // Identifiers originate only from the fixed server-side projection above.
        const table = `${schema}.${tables[record.kind]}`;
        const result = await client.query(`select count(*)::int as matches from ${table} where ${names.map((name, index) => `${name} is not distinct from $${index + 1}`).join(" and ")}`, values);
        if (result.rows[0].matches === 1) continue;
        if (record.kind !== "task") {
          const fixed = await client.query(`select 1 from ${table} where workspace_id=$1 and (id=$2 or unit_id=$3) limit 1`, [record.workspaceId, record.id, record.document.binding.unitId]);
          if (fixed.rowCount) throw new SourceBusinessLoadError("CONFLICT");
        } else {
          const other = await client.query(`select 1 from ${table} where workspace_id=$1 and unit_id=$2 and id<>$3 limit 1`, [record.workspaceId, record.document.binding.unitId, record.id]);
          if (other.rowCount) throw new SourceBusinessLoadError("CONFLICT");
        }
        await client.query(`insert into ${table} (${names.join(",")}) values(${names.map((_, index) => `$${index + 1}`).join(",")})`, values);
        inserted++; bytes += record.byteLength;
      }
      await client.query(`update ${schema}.workspace_budget set business_count=business_count+$2,business_bytes=business_bytes+$3 where workspace_id=$1`, [trusted.workspaceId, inserted, bytes]);
      await client.query("commit");
      return { inserted, replayed: records.length - inserted };
    } catch (error) {
      if (client) await client.query("rollback").catch(() => {});
      if (error instanceof SourceBusinessLoadError) throw error;
      const failure = error as { code?: string; constraint?: string };
      const capacity = failure?.code === "23514" && ["workspace_budget_business_count_check", "workspace_budget_business_bytes_check"].includes(failure.constraint ?? "");
      throw new SourceBusinessLoadError(failure?.code === "23505" ? "CONFLICT" : capacity ? "CAPACITY_EXCEEDED" : "UNAVAILABLE");
    } finally { client?.release(true); }
  } };
}
