// Test-only PG16 pure-codec metadata gate. Not a runtime writer or production assembly.
import type { LedgerDatabasePool } from "../../src/postgres-ledger.ts";

export const codecCatalogFingerprint = "2b3f7fed921c271874fa0c5b6404e7f2133d9fbd40f4b3cf4f027c788829ffb4";
export const codecCatalogQuery = `with ns as (
  select n.*,r.rolname owner_name from pg_namespace n join pg_roles r on r.oid=n.nspowner
  where n.nspname='source_ingest_d1b_codec_v1'
), acl as (
  select 'schema' object,n.nspname::text identity,g.rolname grantor,coalesce(u.rolname,'PUBLIC') grantee,a.privilege_type privilege,a.is_grantable
  from ns n cross join lateral aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
  join pg_roles g on g.oid=a.grantor left join pg_roles u on u.oid=a.grantee
  union all
  select 'function',p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',g.rolname,coalesce(u.rolname,'PUBLIC'),a.privilege_type,a.is_grantable
  from pg_proc p join ns n on n.oid=p.pronamespace cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  join pg_roles g on g.oid=a.grantor left join pg_roles u on u.oid=a.grantee
), snapshot as (select jsonb_build_object(
  'schema',coalesce((select jsonb_build_object('name',nspname,'owner',owner_name) from ns),'null'::jsonb),
  'acl',coalesce((select jsonb_agg(to_jsonb(a) order by object,identity,grantor,grantee,privilege,is_grantable) from acl a),'[]'::jsonb),
  'functions',coalesce((select jsonb_agg(jsonb_build_object('name',p.proname,'arguments',pg_get_function_identity_arguments(p.oid),
    'definitionHash',encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex'),
    'owner',r.rolname,'kind',p.prokind,'language',l.lanname,'securityDefiner',p.prosecdef,'leakproof',p.proleakproof,
    'parallel',p.proparallel,'volatility',p.provolatile,'strict',p.proisstrict,'settings',p.proconfig,
    'result',pg_get_function_result(p.oid),'cost',p.procost,'rows',p.prorows)
    order by p.proname,pg_get_function_identity_arguments(p.oid))
    from pg_proc p join ns n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner join pg_language l on l.oid=p.prolang),'[]'::jsonb),
  'roles',coalesce((select jsonb_agg(jsonb_build_object('name',rolname,'login',rolcanlogin,'super',rolsuper,'createDb',rolcreatedb,
    'createRole',rolcreaterole,'bypass',rolbypassrls,'replication',rolreplication,'inherit',rolinherit,'limit',rolconnlimit)
    order by rolname) from pg_roles where rolname in ('codec_admin','codec_inspector')),'[]'::jsonb),
  'memberships',coalesce((select jsonb_agg(jsonb_build_object('role',r.rolname,'member',m.rolname,'grantor',g.rolname,
    'admin',a.admin_option,'inherit',a.inherit_option,'set',a.set_option) order by r.rolname,m.rolname,g.rolname)
    from pg_auth_members a join pg_roles r on r.oid=a.roleid join pg_roles m on m.oid=a.member join pg_roles g on g.oid=a.grantor
    where r.rolname in ('codec_admin','codec_inspector') or m.rolname in ('codec_admin','codec_inspector')),'[]'::jsonb),
  'defaults',coalesce((select jsonb_agg(jsonb_build_object('owner',r.rolname,'schema',coalesce(n.nspname,'GLOBAL'),
    'type',d.defaclobjtype,'grantor',g.rolname,'grantee',coalesce(u.rolname,'PUBLIC'),'privilege',a.privilege_type,'grantable',a.is_grantable)
    order by r.rolname,coalesce(n.nspname,'GLOBAL'),d.defaclobjtype,g.rolname,coalesce(u.rolname,'PUBLIC'),a.privilege_type,a.is_grantable)
    from pg_default_acl d join pg_roles r on r.oid=d.defaclrole left join pg_namespace n on n.oid=d.defaclnamespace
    cross join lateral aclexplode(d.defaclacl) a join pg_roles g on g.oid=a.grantor left join pg_roles u on u.oid=a.grantee
    where r.rolname in ('codec_admin','codec_inspector') and (d.defaclnamespace=0 or n.nspname='source_ingest_d1b_codec_v1')),'[]'::jsonb),
  'defaultHeaders',coalesce((select jsonb_agg(jsonb_build_object('owner',r.rolname,'schema',coalesce(n.nspname,'GLOBAL'),'type',d.defaclobjtype)
    order by r.rolname,coalesce(n.nspname,'GLOBAL'),d.defaclobjtype) from pg_default_acl d join pg_roles r on r.oid=d.defaclrole
    left join pg_namespace n on n.oid=d.defaclnamespace where r.rolname in ('codec_admin','codec_inspector')
    and (d.defaclnamespace=0 or n.nspname='source_ingest_d1b_codec_v1')),'[]'::jsonb),
  'roleSettings',coalesce((select jsonb_agg(jsonb_build_object('role',r.rolname,'database',coalesce(d.datname,'ALL'),'settings',s.setconfig)
    order by r.rolname,coalesce(d.datname,'ALL')) from pg_db_role_setting s join pg_roles r on r.oid=s.setrole
    left join pg_database d on d.oid=s.setdatabase where r.rolname in ('codec_admin','codec_inspector')),'[]'::jsonb),
  'otherObjects',jsonb_build_object(
    'relations',(select count(*) from pg_class c join ns n on n.oid=c.relnamespace),
    'types',(select count(*) from pg_type t join ns n on n.oid=t.typnamespace),
    'operators',(select count(*) from pg_operator o join ns n on n.oid=o.oprnamespace),
    'collations',(select count(*) from pg_collation c join ns n on n.oid=c.collnamespace),
    'conversions',(select count(*) from pg_conversion c join ns n on n.oid=c.connamespace)),
  'extensions',coalesce((select jsonb_agg(jsonb_build_object('name',e.extname,'version',e.extversion,'function',p.proname)
    order by e.extname,p.proname) from pg_depend d join pg_extension e on e.oid=d.refobjid and d.refclassid='pg_extension'::regclass
    join pg_proc p on p.oid=d.objid and d.classid='pg_proc'::regclass join ns n on n.oid=p.pronamespace where d.deptype='e'),'[]'::jsonb)
  ) value)
select value as snapshot,encode(sha256(convert_to(value::text,'UTF8')),'hex') as fingerprint,
  encode(sha256(convert_to(value::text,'UTF8')),'hex')=$1::text as ready from snapshot`;

export async function assertIsolatedCodecDatabase(pool: LedgerDatabasePool): Promise<void> {
  let query: ((sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) | undefined;
  let release: ((destroy?: boolean) => void) | undefined;
  let failed=false;
  try {
    const client=await pool.connect.bind(pool)(); query=client.query.bind(client); release=client.release.bind(client);
    await query("begin read only; set local statement_timeout='5s'; set local search_path=pg_catalog,pg_temp");
    const role=await query(`select current_setting('server_version_num')::int/10000=16 and current_setting('server_encoding')='UTF8'
      and current_setting('listen_addresses')='' and current_database()='postgres'
      and session_user='codec_inspector' and current_user=session_user
      and (select not rolsuper and not rolcreatedb and not rolcreaterole and not rolbypassrls and not rolreplication from pg_roles where rolname=session_user)
      and not exists(select 1 from pg_roles r where r.rolname<>session_user and pg_has_role(session_user,r.oid,'MEMBER'))
      and not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='source_ingest_d1b_codec_v1' and has_function_privilege(session_user,p.oid,'EXECUTE')) as ready`);
    if(role.rows.length!==1 || role.rows[0]?.ready!==true)throw new Error();
    const result=await query(codecCatalogQuery,[codecCatalogFingerprint]);
    if(result.rows.length!==1 || result.rows[0]?.ready!==true)throw new Error();
    await query('commit');
  } catch {
    failed=true;try {await query?.('rollback');}catch{/* sanitize */}
    throw new Error('CODEC_DATABASE_NOT_READY');
  } finally {try{release?.(failed);}catch{throw new Error('CODEC_DATABASE_NOT_READY');}}
}
