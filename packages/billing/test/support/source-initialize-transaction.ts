// Fixture-only transaction caller. The SQL entrypoint remains isolated to PG16 test databases.
import type { QueryResult } from 'pg';
import { prepareSourceIngestIdentity } from '../../src/evidence-source-ingest.ts';

interface Connection {
  query(sql: string, values?: unknown[]): Promise<QueryResult>;
  release(destroy?: boolean): void;
}

const declaredErrors = new Set(['INVALID_COMMAND','CONFLICT','NOT_FOUND','INTEGRITY_CONFLICT','CAPACITY','STATE_BLOCKED']);

export class InitializeCommitUnknown extends Error {
  readonly code = 'UNAVAILABLE';
  readonly #retry: () => Promise<unknown>;

  constructor(retry: () => Promise<unknown>) {
    super('UNAVAILABLE');
    this.#retry = retry;
  }

  retry(): Promise<unknown> {
    return this.#retry();
  }
}

export function createIsolatedInitializer(
  pool: {connect(): Promise<Connection>}, expectedService: string, expectedRule: string,
) {
  const connect = pool.connect.bind(pool);
  return {
    async initializeSourceCollection(input: unknown): Promise<unknown> {
      const prepared = prepareSourceIngestIdentity(expectedService,'initialize',input);
      const {serviceId: _serviceId,operation: _operation,...command} = prepared.identity;
      // Serialize once before I/O. Explicit recovery uses the same original values.
      const serialized = JSON.stringify(command);
      async function run(): Promise<unknown> {
        let client: Connection;
        try { client=await connect(); } catch { throw new Error('UNAVAILABLE'); }
        let destroy=false;
        let committing=false;
        try {
          await client.query("begin isolation level read committed; set local statement_timeout='5s'; set local lock_timeout='1s'; set local idle_in_transaction_session_timeout='5s'");
          const result=await client.query(
            'select source_ingest_d1b_initialize_write_v1.initialize_source_collection($1::jsonb,$2,$3) receipt',
            [serialized,expectedService,expectedRule]);
          const receipt=result.rows[0]?.receipt;
          if (result.rows.length!==1 || receipt?.commandFingerprint!==prepared.commandFingerprint) {
            throw new Error('UNAVAILABLE');
          }
          committing=true;
          const commit=await client.query('commit');
          if (commit.command!=='COMMIT') throw new Error('UNAVAILABLE');
          return receipt;
        } catch (error) {
          if (committing) {
            destroy=true;
            throw new InitializeCommitUnknown(run);
          }
          try { await client.query('rollback'); } catch { destroy=true; }
          const failure=error as {code?: string; message?: string} | null;
          if (failure?.code==='42501' && failure.message==='FORBIDDEN') throw new Error('FORBIDDEN');
          if (failure?.code==='P0001' && failure.message && declaredErrors.has(failure.message)) {
            throw new Error(failure.message);
          }
          throw new Error('UNAVAILABLE');
        } finally {
          client.release(destroy);
        }
      }
      return run();
    },
  };
}
