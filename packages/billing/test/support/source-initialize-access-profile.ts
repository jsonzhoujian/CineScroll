// Test-only snapshot of the isolated initializer and its dependency schemas.
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

const expectedFingerprint = '96acd856348f001a4722bf2b3d562528594287141a72ddd1749a6dd9a2ef9858';

export async function assertInitializeAccessProfile(database: Pool | PoolClient): Promise<void> {
  const fingerprint = await initializeProfileFingerprint(database, false);
  if (fingerprint !== expectedFingerprint) throw new Error('INITIALIZE_ACCESS_PROFILE_NOT_READY');
}

export async function initializeProfileFingerprint(database: Pool | PoolClient, writer: boolean): Promise<string> {
  const { rows } = await database.query(`
    with namespaces as (
      select n.* from pg_namespace n where nspname in (
        'source_ingest_d1b_fixture_v1', 'source_ingest_d1b_codec_v1',
        'source_ingest_d1b_verify_v1', 'source_ingest_d1b_initialize_access_v1'
        ${writer ? ", 'source_ingest_d1b_initialize_material_v1', 'source_ingest_d1b_initialize_write_v1'" : ''})
    ), profile_roles as (
      select oid,rolname from pg_roles where rolname='novel_d1b_initializer'
        ${writer ? "or rolname in ('initialize_access_test_login','codec_inspector','novel_d1b_locker','novel_d1b_owner','novel_d1b_business_fixture','novel_d1b_auth_fixture','codec_admin')" : ''}
    ), relations as (
      select c.*, n.nspname from pg_class c join namespaces n on n.oid=c.relnamespace
      where c.relkind in ('r','v','S','p')
    ), metadata(kind, entry) as (
      select 'role', (to_jsonb(r)-'oid') from pg_roles r where r.oid in (select oid from profile_roles)
      union all
      select 'membership', jsonb_build_array(r.rolname,m.rolname,g.rolname,
        a.admin_option,a.inherit_option,a.set_option)
      from pg_auth_members a join pg_roles r on r.oid=a.roleid
        join pg_roles m on m.oid=a.member join pg_roles g on g.oid=a.grantor
      where exists(select 1 from profile_roles p where p.oid in (r.oid,m.oid${writer ? '' : ',g.oid'}))
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
      select 'role settings', jsonb_build_array(${writer ? 'pg_get_userbyid(setrole),' : ''}setdatabase=0,setconfig)
      from pg_db_role_setting where setrole in (select oid from profile_roles)
      ${writer ? `
      union all
      select 'trigger', jsonb_build_array(nspname,relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid))
      from relations r join pg_trigger t on t.tgrelid=r.oid where not t.tgisinternal
      union all
      select 'constraint', jsonb_build_array(n.nspname,c.conname,r.relname,ty.typname,c.convalidated,pg_get_constraintdef(c.oid))
      from pg_constraint c join namespaces n on n.oid=c.connamespace
      left join pg_class r on r.oid=c.conrelid left join pg_type ty on ty.oid=c.contypid
      union all
      select 'type', jsonb_build_array(n.nspname,t.typname,t.typtype,pg_get_userbyid(t.typowner),
        coalesce(t.typacl,acldefault('T',t.typowner))::text)
      from namespaces n join pg_type t on t.typnamespace=n.oid where t.typtype='d'
      ` : ''}
    )
    select kind, entry::text from metadata order by kind collate "C", entry::text collate "C"
  `);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
