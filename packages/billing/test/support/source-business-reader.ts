// Test-administrator integrity reader only: no source registration or production export.
import type { Pool } from "pg";
import { prepareSourceBusinessFixture, prepareSourceIngestIdentity, SourceBusinessFixtureError, SourceIngestProtocolError,
  type PreparedFixtureRecord, type FixtureTaskRevision, type FixtureSnapshot, type FixtureExecutionIdentity,
  type FixtureQuote, type SourceIngestReference } from "../../src/index.ts";
import { businessFixtureTables, fixtureBusinessColumns, isolatedAdministratorProfileQuery } from "./source-business-loader.ts";
const schema = "source_ingest_d1b_fixture_v1";
export class SourceBusinessReadError extends Error {
  readonly code: "FORBIDDEN" | "NOT_FOUND" | "INTEGRITY_CONFLICT" | "UNAVAILABLE";
  constructor(code: SourceBusinessReadError["code"]) { super(code); this.code = code; }
}

export function createIsolatedSourceBusinessReader(pool: Pool, config: { workspaceId: string; allowedProducerServiceIds: string[] }) {
  const trusted = structuredClone(config);
  return { async read(input: unknown): Promise<{ records: PreparedFixtureRecord[] }> {
    const keys = ["taskReference", "snapshotReference", "executionReference"];
    let references: Record<string, unknown>;
    try {
      if (!input || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== 3) throw new Error();
      references = Object.fromEntries(keys.map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error();
        return [key, descriptor.value];
      }));
    } catch { throw new SourceIngestProtocolError(); }
    const identity = prepareSourceIngestIdentity("fixture-reader", "initialize", {
      ...references,
      protocolVersion: "source-ingest-v1", workspaceId: trusted.workspaceId, unitId: "fixture-reader", ingestId: "fixture-reader",
    }).identity;
    if (identity.operation !== "initialize") throw new SourceBusinessReadError("UNAVAILABLE");
    const values = [trusted.workspaceId, ...[identity.taskReference,identity.snapshotReference,identity.executionReference].flatMap(ref => [ref.id,ref.version])];
    if (values.some(value => /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value))) throw new SourceIngestProtocolError();
    const client = await pool.connect.bind(pool)().catch(() => { throw new SourceBusinessReadError("UNAVAILABLE"); });
    const query = client.query.bind(client), release = client.release.bind(client);
    try {
      await query("begin isolation level repeatable read read only; set local statement_timeout='5s'; set local search_path=pg_catalog,pg_temp");
      if ((await query(isolatedAdministratorProfileQuery)).rows[0]?.ok !== true) throw new SourceBusinessReadError("FORBIDDEN");
      await query("set local role novel_d1b_business_fixture");
      let bytes = 0;
      const readRow = async (kind: PreparedFixtureRecord["kind"], reference: SourceIngestReference, required: boolean) => {
        const result = await query(`select * from ${schema}.${businessFixtureTables[kind]} where workspace_id=$1 and id=$2 and version=$3 and producer_service_id=any($4::text[])`, [trusted.workspaceId, reference.id, reference.version, trusted.allowedProducerServiceIds]);
        if (result.rows.length !== 1) throw new SourceBusinessReadError(required ? "NOT_FOUND" : "INTEGRITY_CONFLICT");
        const row = result.rows[0]!;
        if (!Buffer.isBuffer(row.canonical) || row.canonical.length < 1 || row.canonical.length > 2097152
          || Buffer.byteLength(JSON.stringify(row.document), "utf8") > 2097152 || (bytes += row.canonical.length) > 16777216)
          throw new SourceBusinessReadError("INTEGRITY_CONFLICT");
        return row;
      };
      const task = await readRow("task", identity.taskReference, true);
      const snapshot = await readRow("snapshot", identity.snapshotReference, true);
      const execution = await readRow("execution", identity.executionReference, true);
      const quote = await readRow("quote", { id: snapshot.quote_record_id, version: snapshot.quote_record_version }, false);
      const tasks = [task];
      const seen = new Set([task.version]);
      while (tasks.at(-1)!.predecessor_version !== null) {
        if (tasks.length >= 4093) throw new SourceBusinessReadError("INTEGRITY_CONFLICT");
        const previous = await readRow("task", { id: identity.taskReference.id, version: tasks.at(-1)!.predecessor_version }, false);
        if (seen.has(previous.version)) throw new SourceBusinessReadError("INTEGRITY_CONFLICT");
        seen.add(previous.version); tasks.push(previous);
      }
      tasks.reverse();
      const prepared = prepareSourceBusinessFixture({ tasks: tasks.map(row => row.document) as FixtureTaskRevision[],
        snapshot: snapshot.document as FixtureSnapshot, execution: execution.document as FixtureExecutionIdentity, quote: quote.document as FixtureQuote });
      const selected = [...tasks, snapshot, execution, quote];
      for (const [index,record] of prepared.records.entries()) {
        if (record.workspaceId !== trusted.workspaceId || record.id !== selected[index]!.id || record.version !== selected[index]!.version)
          throw new SourceBusinessReadError("INTEGRITY_CONFLICT");
        const columns = fixtureBusinessColumns(record), names = Object.keys(columns);
        const result = await query(`select count(*)::int as matches from ${schema}.${businessFixtureTables[record.kind]} where ${names.map((name,index) => `${name} is not distinct from $${index + 1}`).join(" and ")}`, Object.values(columns));
        if (result.rows[0]?.matches !== 1) throw new SourceBusinessReadError("INTEGRITY_CONFLICT");
      }
      await query("commit");
      return prepared;
    } catch (error) {
      await query("rollback").catch(() => {});
      if (error instanceof SourceBusinessReadError) throw error;
      if (error instanceof SourceBusinessFixtureError) throw new SourceBusinessReadError("INTEGRITY_CONFLICT");
      throw new SourceBusinessReadError("UNAVAILABLE");
    } finally { try { release(true); } catch { throw new SourceBusinessReadError("UNAVAILABLE"); } }
  } };
}
