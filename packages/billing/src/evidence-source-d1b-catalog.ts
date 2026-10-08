// Frozen PG16 closed fixture catalog. Internal expectations, never learned at startup.
export const sourceIngestDraftCatalogFingerprint = "96275bf28e4ac2e3b3adfeb591384c0b394e10d39d545fd98124e119d3aee138";

// Every entry uses names/definitions rather than cluster-local OIDs. Arrays sort by content.
// No business table is queried and no source-defined function is executed.
export const sourceIngestDraftCatalogQuery = `select /* source-d1b:catalog */
  encode(sha256(convert_to(profile::text,'UTF8')),'hex')=$1 as ready
from (
  select jsonb_build_object(
    'schema', (select jsonb_build_object('owner',pg_get_userbyid(n.nspowner),'acl',
      (select jsonb_agg(jsonb_build_array(case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
        pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable) order by a.grantee=0,pg_get_userbyid(a.grantee)::text collate "C",pg_get_userbyid(a.grantor)::text collate "C",a.privilege_type collate "C",a.is_grantable)
        from aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a))
      from pg_namespace n where n.nspname='source_ingest_d1b_fixture_v1'),
    'entries', (select coalesce(jsonb_agg(entry order by entry::text collate "C"),'[]'::jsonb) from (
      select jsonb_build_object('category','relation','name',c.relname,'kind',c.relkind,'owner',pg_get_userbyid(c.relowner),
        'rls',c.relrowsecurity,'force',c.relforcerowsecurity,'partition',c.relispartition,'persistence',c.relpersistence,
        'options',c.reloptions,'access',am.amname,'replicaIdentity',c.relreplident,
        'acl',(select coalesce(jsonb_agg(jsonb_build_array(case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
          pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable) order by a.grantee=0,pg_get_userbyid(a.grantee)::text collate "C",pg_get_userbyid(a.grantor)::text collate "C",a.privilege_type collate "C",a.is_grantable),'[]'::jsonb)
          from aclexplode(coalesce(c.relacl,acldefault(case when c.relkind='S' then 'S'::"char" else 'r'::"char" end,c.relowner))) a)) as entry
      from pg_class c left join pg_am am on am.oid=c.relam where c.relnamespace=to_regnamespace('source_ingest_d1b_fixture_v1')
      union all
      select jsonb_build_object('category','column','table',c.relname,'ordinal',a.attnum,'name',a.attname,
        'type',format_type(a.atttypid,a.atttypmod),'required',a.attnotnull,'generated',a.attgenerated,'identity',a.attidentity,
        'local',a.attislocal,'inheritCount',a.attinhcount,
        'collation',case when a.attcollation=0 then null else cn.nspname||'.'||coll.collname end,
        'default',pg_get_expr(d.adbin,d.adrelid),'acl',(select coalesce(jsonb_agg(jsonb_build_array(
          case when p.grantee=0 then 'PUBLIC' else pg_get_userbyid(p.grantee) end,pg_get_userbyid(p.grantor),p.privilege_type,p.is_grantable)
          order by p.grantee=0,pg_get_userbyid(p.grantee)::text collate "C",pg_get_userbyid(p.grantor)::text collate "C",p.privilege_type collate "C",p.is_grantable),'[]'::jsonb) from aclexplode(a.attacl) p))
      from pg_attribute a join pg_class c on c.oid=a.attrelid left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      left join pg_collation coll on coll.oid=a.attcollation left join pg_namespace cn on cn.oid=coll.collnamespace
      where c.relnamespace=to_regnamespace('source_ingest_d1b_fixture_v1') and a.attnum>0 and not a.attisdropped
      union all
      select jsonb_build_object('category','constraint','name',con.conname,'table',c.relname,'domain',t.typname,
        'type',con.contype,'definition',pg_get_constraintdef(con.oid),'validated',con.convalidated,
        'deferred',con.condeferred,'deferrable',con.condeferrable,'local',con.conislocal,'inheritCount',con.coninhcount,'noinherit',con.connoinherit)
      from pg_constraint con left join pg_class c on c.oid=con.conrelid left join pg_type t on t.oid=con.contypid
      where con.connamespace=to_regnamespace('source_ingest_d1b_fixture_v1')
      union all
      select jsonb_build_object('category','index','table',c.relname,'name',idx.relname,'definition',pg_get_indexdef(i.indexrelid),
        'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,'unique',i.indisunique,'primary',i.indisprimary,
        'immediate',i.indimmediate,'exclusion',i.indisexclusion,'options',i.indoption::text,
        'collations',(select jsonb_agg(n.nspname||'.'||co.collname order by k.ord) from unnest(i.indcollation) with ordinality k(id,ord)
          left join pg_collation co on co.oid=k.id left join pg_namespace n on n.oid=co.collnamespace),
        'opclasses',(select jsonb_agg(n.nspname||'.'||op.opcname order by k.ord) from unnest(i.indclass) with ordinality k(id,ord)
          join pg_opclass op on op.oid=k.id join pg_namespace n on n.oid=op.opcnamespace))
      from pg_index i join pg_class c on c.oid=i.indrelid join pg_class idx on idx.oid=i.indexrelid
      where c.relnamespace=to_regnamespace('source_ingest_d1b_fixture_v1')
      union all
      select jsonb_build_object('category','function','name',p.proname,'arguments',pg_get_function_identity_arguments(p.oid),
        'definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'language',l.lanname,'kind',p.prokind,
        'cost',p.procost,'rows',p.prorows,'support',p.prosupport::regproc::text,
        'acl',(select coalesce(jsonb_agg(jsonb_build_array(case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
          pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable) order by a.grantee=0,pg_get_userbyid(a.grantee)::text collate "C",pg_get_userbyid(a.grantor)::text collate "C",a.privilege_type collate "C",a.is_grantable),'[]'::jsonb)
          from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a))
      from pg_proc p join pg_language l on l.oid=p.prolang where p.pronamespace=to_regnamespace('source_ingest_d1b_fixture_v1')
      union all
      select jsonb_build_object('category','type','name',t.typname,'kind',t.typtype,'owner',pg_get_userbyid(t.typowner),
        'base',format_type(t.typbasetype,t.typtypmod),'notnull',t.typnotnull,'default',t.typdefault,
        'collation',case when t.typcollation=0 then null else n.nspname||'.'||co.collname end,
        'acl',(select coalesce(jsonb_agg(jsonb_build_array(case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
          pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable) order by a.grantee=0,pg_get_userbyid(a.grantee)::text collate "C",pg_get_userbyid(a.grantor)::text collate "C",a.privilege_type collate "C",a.is_grantable),'[]'::jsonb)
          from aclexplode(coalesce(t.typacl,acldefault('T',t.typowner))) a))
      from pg_type t left join pg_collation co on co.oid=t.typcollation left join pg_namespace n on n.oid=co.collnamespace
      where t.typnamespace=to_regnamespace('source_ingest_d1b_fixture_v1') and t.typtype<>'c' and t.typelem=0
      union all
      select jsonb_build_object('category','trigger','table',c.relname,'name',case when tr.tgisinternal then null else tr.tgname end,
        'internal',tr.tgisinternal,'constraint',con.conname,'constraintTable',cc.relname,
        'function',tr.tgfoid::regprocedure::text,'type',tr.tgtype,'enabled',tr.tgenabled,'args',encode(tr.tgargs,'hex'),
        'condition',pg_get_expr(tr.tgqual,tr.tgrelid),'deferrable',tr.tgdeferrable,'deferred',tr.tginitdeferred,
        'oldTable',tr.tgoldtable,'newTable',tr.tgnewtable,'columns',tr.tgattr::text)
      from pg_trigger tr join pg_class c on c.oid=tr.tgrelid left join pg_constraint con on con.oid=tr.tgconstraint
      left join pg_class cc on cc.oid=con.conrelid where c.relnamespace=to_regnamespace('source_ingest_d1b_fixture_v1')
      union all
      select jsonb_build_object('category','policy','table',c.relname,'name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,
        'roles',(select jsonb_agg(case when id=0 then 'PUBLIC' else pg_get_userbyid(id) end order by id=0,pg_get_userbyid(id)::text collate "C") from unnest(p.polroles) id),
        'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid))
      from pg_policy p join pg_class c on c.oid=p.polrelid where c.relnamespace=to_regnamespace('source_ingest_d1b_fixture_v1')
      union all
      select jsonb_build_object('category','rule','table',c.relname,'name',r.rulename,'enabled',r.ev_enabled,'definition',pg_get_ruledef(r.oid))
      from pg_rewrite r join pg_class c on c.oid=r.ev_class where c.relnamespace=to_regnamespace('source_ingest_d1b_fixture_v1')
      union all
      select jsonb_build_object('category','inheritance','child',c.relname,'parentSchema',n.nspname,'parent',parent.relname,'order',i.inhseqno)
      from pg_inherits i join pg_class c on c.oid=i.inhrelid join pg_class parent on parent.oid=i.inhparent join pg_namespace n on n.oid=parent.relnamespace
      where c.relnamespace=to_regnamespace('source_ingest_d1b_fixture_v1') or parent.relnamespace=to_regnamespace('source_ingest_d1b_fixture_v1')
      union all
      select jsonb_build_object('category','defaultAcl','owner',pg_get_userbyid(d.defaclrole),'schema',n.nspname,'kind',d.defaclobjtype,
        'acl',(select coalesce(jsonb_agg(jsonb_build_array(case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
          pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable) order by a.grantee=0,pg_get_userbyid(a.grantee)::text collate "C",pg_get_userbyid(a.grantor)::text collate "C",a.privilege_type collate "C",a.is_grantable),'[]'::jsonb)
          from aclexplode(d.defaclacl) a))
      from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace
      where n.nspname='source_ingest_d1b_fixture_v1' or (d.defaclnamespace=0 and pg_get_userbyid(d.defaclrole) in
        ('novel_d1b_owner','novel_d1b_locker','novel_d1b_mutator','novel_d1b_reader','novel_d1b_inspector'))
    ) entries)
  ) as profile
) frozen`;
