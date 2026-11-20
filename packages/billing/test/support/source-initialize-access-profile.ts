// Test-only snapshot of the isolated initializer and its dependency schemas.
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

const expectedFingerprint = '96acd856348f001a4722bf2b3d562528594287141a72ddd1749a6dd9a2ef9858';

export async function assertInitializeAccessProfile(database: Pool | PoolClient): Promise<void> {
  const { rows } = await database.query(`
    with namespaces as (
      select n.* from pg_namespace n where nspname in (
        'source_ingest_d1b_fixture_v1', 'source_ingest_d1b_codec_v1',
        'source_ingest_d1b_verify_v1', 'source_ingest_d1b_initialize_access_v1')
    ), relations as (
      select c.*, n.nspname from pg_class c join namespaces n on n.oid=c.relnamespace
      where c.relkind in ('r','v','S','p')
    ), metadata(kind, entry) as (
      select 'role', (to_jsonb(r)-'oid') from pg_roles r where rolname='novel_d1b_initializer'
      union all
      select 'membership', jsonb_build_array(r.rolname,m.rolname,g.rolname,
        a.admin_option,a.inherit_option,a.set_option)
      from pg_auth_members a join pg_roles r on r.oid=a.roleid
        join pg_roles m on m.oid=a.member join pg_roles g on g.oid=a.grantor
      where 'novel_d1b_initializer' in (r.rolname,m.rolname,g.rolname)
      union all
      select 'schema', jsonb_build_array(nspname,pg_get_userbyid(nspowner),
        coalesce(nspacl,acldefault('n',nspowner))::text) from namespaces
      union all
      select 'relation', jsonb_build_array(nspname,relname,pg_get_userbyid(relowner),
        relrowsecurity,relforcerowsecurity,coalesce(relacl,acldefault(
          case when relkind='S' then 's' else 'r' end::"char",relowner))::text) from relations
      union all
      select 'column ACL', jsonb_build_array(nspname,relname,attname,attacl::text)
      from relations c join pg_attribute a on a.attrelid=c.oid where a.attacl is not null
      union all
      select 'policy', jsonb_build_array(nspname,relname,policyname,permissive,roles,cmd,qual,with_check)
      from pg_policies join relations on schemaname=nspname and tablename=relname
      union all
      select 'function', jsonb_build_array(nspname,pg_get_functiondef(p.oid),
        pg_get_userbyid(proowner),coalesce(proacl,acldefault('f',proowner))::text)
      from pg_proc p join namespaces n on n.oid=p.pronamespace where p.prokind in ('f','p','w')
      union all
      select 'default ACL', jsonb_build_array(pg_get_userbyid(defaclrole),
        n.nspname,defaclobjtype,defaclacl::text)
      from pg_default_acl d left join namespaces n on n.oid=d.defaclnamespace
      where n.oid is not null or d.defaclnamespace=0
      union all
      select 'role settings', jsonb_build_array(setdatabase=0,setconfig)
      from pg_db_role_setting where setrole=(select oid from pg_roles where rolname='novel_d1b_initializer')
    )
    select kind, entry::text from metadata order by kind collate "C", entry::text collate "C"
  `);
  const fingerprint = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  if (fingerprint !== expectedFingerprint) throw new Error('INITIALIZE_ACCESS_PROFILE_NOT_READY');
}
