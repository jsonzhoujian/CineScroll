// Test-only combined profile. Never a production assembly/writer permission.
import type { LedgerDatabasePool } from "../../src/postgres-ledger.ts";
import { sourceIngestDraftRoleQuery } from "../../src/evidence-source-d1b-readiness.ts";
import { sourceIngestDraftCatalogQuery } from "../../src/evidence-source-d1b-catalog.ts";

export const businessFixtureCatalogFingerprint = "41fc16710899f624e3f2bf2ac4f192f23d7e8fbdb6d468c83fd9f008a05f93fb";
const originalRoles = "('novel_d1b_owner','novel_d1b_locker','novel_d1b_mutator','novel_d1b_reader','novel_d1b_inspector'))";
const extendedRoles = "('novel_d1b_owner','novel_d1b_locker','novel_d1b_mutator','novel_d1b_reader','novel_d1b_inspector','novel_d1b_auth_fixture','novel_d1b_business_fixture'))";
if (sourceIngestDraftCatalogQuery.split(originalRoles).length !== 2) throw new Error("BUSINESS_FIXTURE_CATALOG_TEMPLATE_CHANGED");
export const businessFixtureCatalogQuery = sourceIngestDraftCatalogQuery.replace(originalRoles, extendedRoles);
export const businessFixtureExtensionRolesQuery = `select
  current_database() ~ '^d1b_[a-f0-9]{32}$'
  and current_setting('listen_addresses')=''
  and (select count(*)=2 and bool_and(not rolcanlogin and not rolsuper and not rolcreatedb and not rolcreaterole and not rolbypassrls and not rolreplication)
    from pg_roles where rolname in ('novel_d1b_auth_fixture','novel_d1b_business_fixture'))
  and not exists(select 1 from pg_roles subject cross join pg_roles reachable
    where subject.rolname in ('novel_d1b_auth_fixture','novel_d1b_business_fixture')
    and subject.oid<>reachable.oid and pg_has_role(subject.oid,reachable.oid,'MEMBER')) as ready`;

export async function assertIsolatedBusinessFixtureDatabase(pool: LedgerDatabasePool): Promise<void> {
  let query: ((sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) | undefined;
  let release: ((destroy?: boolean) => void) | undefined;
  let failed = false;
  try {
    const client = await pool.connect.bind(pool)();
    query = client.query.bind(client);
    release = client.release.bind(client);
    await query("begin read only; set local statement_timeout='5s'; set local search_path=pg_catalog");
    for (const [sql, values] of [[sourceIngestDraftRoleQuery, []], [businessFixtureExtensionRolesQuery, []], [businessFixtureCatalogQuery, [businessFixtureCatalogFingerprint]]] as const) {
      const result = await query(sql, [...values]);
      if (result.rows.length !== 1 || result.rows[0]?.ready !== true) throw new Error();
    }
    await query("commit");
  } catch {
    failed = true;
    try { await query?.("rollback"); } catch { /* No storage diagnostics. */ }
    throw new Error("BUSINESS_FIXTURE_DATABASE_NOT_READY");
  } finally {
    try { release?.(failed); } catch { throw new Error("BUSINESS_FIXTURE_DATABASE_NOT_READY"); }
  }
}
