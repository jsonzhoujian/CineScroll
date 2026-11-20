// Fixture-only metadata gate and checked connection assembly.
import type { Pool, PoolClient } from 'pg';
import { initializeProfileFingerprint } from './source-initialize-access-profile.ts';

const expectedFingerprint = '457cc9310ca1351433c1f2bb488c9926d89f2e9697f970b2ae24c7ee77b7fa70';
const inspectorLogin = 'codec_inspector';
const runtimeLogin = 'initialize_access_test_login';

function isolatedEndpoint(connectionString: string | undefined, login: string): URL {
  const url = new URL(connectionString ?? '');
  const port = url.searchParams.get('port') ?? '';
  if (url.protocol !== 'postgresql:' || url.hostname !== 'localhost' || url.port || url.username !== login
    || url.password || url.hash || !/^\/d1b_[a-f0-9]{32}$/.test(url.pathname)
    || !/^\/private\/tmp\/source-d1b\.[A-Za-z0-9]{6}$/.test(url.searchParams.get('host') ?? '')
    || !/^[1-9][0-9]{0,4}$/.test(port) || Number(port)>65535
    || [...url.searchParams.keys()].sort().join(',') !== 'host,port') throw new Error();
  url.username = '';
  url.searchParams.sort();
  return url;
}

async function assertIdentity(client: PoolClient, login: string, endpoint: URL): Promise<void> {
  const result = await client.query(`select session_user=$1 and current_user=session_user
    and current_database()=$2 and current_setting('server_version_num')::int/10000=16
    and current_setting('server_encoding')='UTF8' and current_setting('listen_addresses')=''
    and inet_server_addr() is null as ok`,[login,endpoint.pathname.slice(1)]);
  if (result.rows[0]?.ok !== true) throw new Error();
}

export async function checkInitializeWritePool(inspector: Pool, runtime: Pool) {
  const inspectConnect = inspector.connect.bind(inspector);
  const runtimeConnect = runtime.connect.bind(runtime);
  let endpoint: URL;

  async function assertReady(): Promise<void> {
    let client: PoolClient | undefined;
    let discard = false;
    try {
      client = await inspectConnect();
      await client.query("begin isolation level repeatable read read only; set local search_path=pg_catalog,pg_temp; set local statement_timeout='5s'");
      await assertIdentity(client,inspectorLogin,endpoint);
      const fingerprint = await initializeProfileFingerprint(client,true);
      if (fingerprint !== expectedFingerprint) throw new Error();
      await client.query('commit');
    } catch {
      discard = true;
      throw new Error('INITIALIZE_WRITE_PROFILE_NOT_READY');
    } finally {
      client?.release(discard);
    }
  }

  async function connectRuntime(): Promise<PoolClient> {
    const client = await runtimeConnect();
    try {
      await assertIdentity(client,runtimeLogin,endpoint);
      return client;
    } catch {
      client.release(true);
      throw new Error('INITIALIZE_WRITE_PROFILE_NOT_READY');
    }
  }

  try {
    endpoint = isolatedEndpoint(inspector.options.connectionString,inspectorLogin);
    if (endpoint.href !== isolatedEndpoint(runtime.options.connectionString,runtimeLogin).href) throw new Error();
    await assertReady();
    (await connectRuntime()).release();
  } catch {
    throw new Error('INITIALIZE_WRITE_PROFILE_NOT_READY');
  }

  return {
    async connect(): Promise<PoolClient> {
      await assertReady();
      return connectRuntime();
    },
  };
}
