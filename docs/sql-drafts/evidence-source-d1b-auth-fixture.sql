-- TEST ONLY. Apply after the closed draft in a disposable socket-only cluster.
-- Changes the catalog deliberately: the original readiness gate MUST reject it.
begin;
do $guard$ begin
  if not (select rolsuper from pg_roles where rolname=session_user)
     or current_setting('server_version_num')::integer / 10000 <> 16
     or current_setting('server_encoding') <> 'UTF8'
     or current_setting('listen_addresses') <> ''
     or current_setting('data_directory') !~ '^/private/tmp/source-d1b\.[A-Za-z0-9]{6}/data$' then
    raise exception 'D1B_TEST_ONLY';
  end if;
end $guard$;
create role novel_d1b_auth_fixture nologin nosuperuser nocreatedb nocreaterole nobypassrls noreplication;
grant usage on schema source_ingest_d1b_fixture_v1 to novel_d1b_auth_fixture;
grant select,insert on source_ingest_d1b_fixture_v1.service_principal,
  source_ingest_d1b_fixture_v1.workspace_service_grant to novel_d1b_auth_fixture;
grant update(enabled,revision) on source_ingest_d1b_fixture_v1.service_principal,
  source_ingest_d1b_fixture_v1.workspace_service_grant to novel_d1b_auth_fixture;
grant execute on function source_ingest_d1b_fixture_v1.valid_id(text),
  source_ingest_d1b_fixture_v1.valid_ids(text[]) to novel_d1b_auth_fixture;
create policy test_principal_access on source_ingest_d1b_fixture_v1.service_principal
  to novel_d1b_auth_fixture using(true) with check(true);
create policy test_grant_access on source_ingest_d1b_fixture_v1.workspace_service_grant
  to novel_d1b_auth_fixture using(true) with check(true);

create function source_ingest_d1b_fixture_v1.guard_test_authorization() returns trigger
language plpgsql set search_path=pg_catalog,pg_temp as $body$
begin
  if current_user <> 'novel_d1b_auth_fixture' or TG_OP not in ('INSERT','UPDATE') then
    raise exception using errcode='42501',message='FORBIDDEN';
  end if;
  if TG_OP='INSERT' then
    if NEW.revision<>1 or NEW.lock_token then raise exception 'INVALID_TEST_ACCESS'; end if;
  elsif (to_jsonb(NEW)-array['enabled','revision']) <> (to_jsonb(OLD)-array['enabled','revision'])
    or NEW.enabled=OLD.enabled or NEW.revision<>OLD.revision+1 then
    raise exception 'INVALID_TEST_ACCESS';
  end if;
  return NEW;
end $body$;
revoke all on function source_ingest_d1b_fixture_v1.guard_test_authorization() from public;
drop trigger draft_closed_row on source_ingest_d1b_fixture_v1.service_principal;
drop trigger draft_closed_row on source_ingest_d1b_fixture_v1.workspace_service_grant;
create trigger test_authorization_row before insert or update or delete on source_ingest_d1b_fixture_v1.service_principal
  for each row execute function source_ingest_d1b_fixture_v1.guard_test_authorization();
create trigger test_authorization_row before insert or update or delete on source_ingest_d1b_fixture_v1.workspace_service_grant
  for each row execute function source_ingest_d1b_fixture_v1.guard_test_authorization();
alter table source_ingest_d1b_fixture_v1.service_principal enable always trigger test_authorization_row;
alter table source_ingest_d1b_fixture_v1.workspace_service_grant enable always trigger test_authorization_row;

create function source_ingest_d1b_fixture_v1.prepare_test_access(
  p_login text,p_service text,p_workspace text,p_initialize boolean,p_register boolean,p_read boolean,
  p_kinds text[],p_business text[],p_receipt text[]) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $body$
declare p source_ingest_d1b_fixture_v1.service_principal%rowtype;
  g source_ingest_d1b_fixture_v1.workspace_service_grant%rowtype;
begin
  if not (select rolsuper from pg_roles where rolname=session_user) then
    raise exception using errcode='42501',message='FORBIDDEN';
  end if;
  if not source_ingest_d1b_fixture_v1.valid_id(p_login)
    or not source_ingest_d1b_fixture_v1.valid_id(p_service)
    or not source_ingest_d1b_fixture_v1.valid_id(p_workspace)
    or p_initialize is null or p_register is null or p_read is null
    or not source_ingest_d1b_fixture_v1.valid_ids(p_kinds) or not p_kinds <@ array['task','snapshot']
    or not source_ingest_d1b_fixture_v1.valid_ids(p_business)
    or not source_ingest_d1b_fixture_v1.valid_ids(p_receipt)
    or (p_read and cardinality(p_receipt)=0)
    or not exists(select 1 from pg_roles where rolname=p_login and rolcanlogin
      and not (rolsuper or rolcreatedb or rolcreaterole or rolbypassrls or rolreplication))
    or exists(select 1 from pg_auth_members m join pg_roles r on r.oid=m.member where r.rolname=p_login) then
    raise exception 'INVALID_TEST_ACCESS';
  end if;
  insert into source_ingest_d1b_fixture_v1.service_principal(login_name,service_id,enabled,revision)
    values(p_login,p_service,true,1) on conflict do nothing;
  select * into p from source_ingest_d1b_fixture_v1.service_principal where login_name=p_login for update;
  if not found or p.service_id<>p_service then raise exception 'TEST_ACCESS_CONFLICT'; end if;
  insert into source_ingest_d1b_fixture_v1.workspace_service_grant
    (workspace_id,service_id,enabled,revision,allow_initialize,allow_register,allow_receipt_read,
     allowed_kinds,business_producer_ids,receipt_producer_ids)
    values(p_workspace,p_service,true,1,p_initialize,p_register,p_read,p_kinds,p_business,p_receipt)
    on conflict do nothing;
  select * into g from source_ingest_d1b_fixture_v1.workspace_service_grant
    where workspace_id=p_workspace and service_id=p_service for update;
  if g.allow_initialize<>p_initialize or g.allow_register<>p_register or g.allow_receipt_read<>p_read
    or g.allowed_kinds<>p_kinds or g.business_producer_ids<>p_business or g.receipt_producer_ids<>p_receipt then
    raise exception 'TEST_ACCESS_CONFLICT';
  end if;
  return jsonb_build_object('serviceId',p.service_id,'workspaceId',g.workspace_id,
    'principalRevision',p.revision,'grantRevision',g.revision,
    'principalEnabled',p.enabled,'grantEnabled',g.enabled);
end $body$;

create function source_ingest_d1b_fixture_v1.set_test_grant_enabled(
  p_workspace text,p_service text,p_expected bigint,p_enabled boolean) returns bigint
language plpgsql security definer set search_path=pg_catalog,pg_temp as $body$
declare g source_ingest_d1b_fixture_v1.workspace_service_grant%rowtype;
begin
  if not (select rolsuper from pg_roles where rolname=session_user) then
    raise exception using errcode='42501',message='FORBIDDEN';
  end if;
  if p_enabled is null or p_expected is null then raise exception 'INVALID_TEST_ACCESS'; end if;
  perform 1 from source_ingest_d1b_fixture_v1.service_principal where service_id=p_service for share;
  if not found then raise exception 'TEST_ACCESS_CONFLICT'; end if;
  select * into g from source_ingest_d1b_fixture_v1.workspace_service_grant
    where workspace_id=p_workspace and service_id=p_service for update;
  if not found or g.revision<>p_expected then raise exception 'TEST_ACCESS_CONFLICT'; end if;
  if g.enabled=p_enabled then return g.revision; end if;
  update source_ingest_d1b_fixture_v1.workspace_service_grant set enabled=p_enabled,revision=revision+1
    where workspace_id=p_workspace and service_id=p_service;
  return g.revision+1;
end $body$;
revoke all on function source_ingest_d1b_fixture_v1.prepare_test_access(text,text,text,boolean,boolean,boolean,text[],text[],text[]),
  source_ingest_d1b_fixture_v1.set_test_grant_enabled(text,text,bigint,boolean) from public;
grant create on schema source_ingest_d1b_fixture_v1 to novel_d1b_auth_fixture;
alter function source_ingest_d1b_fixture_v1.prepare_test_access(text,text,text,boolean,boolean,boolean,text[],text[],text[]) owner to novel_d1b_auth_fixture;
alter function source_ingest_d1b_fixture_v1.set_test_grant_enabled(text,text,bigint,boolean) owner to novel_d1b_auth_fixture;
revoke create on schema source_ingest_d1b_fixture_v1 from novel_d1b_auth_fixture;

create function source_ingest_d1b_fixture_v1.probe_test_access(text,text,text) returns jsonb
language sql security definer set search_path=pg_catalog,pg_temp as $body$
  select source_ingest_d1b_fixture_v1.lock_authorization($1,$2,$3)
$body$;
revoke all on function source_ingest_d1b_fixture_v1.probe_test_access(text,text,text) from public;
grant create on schema source_ingest_d1b_fixture_v1 to novel_d1b_mutator;
alter function source_ingest_d1b_fixture_v1.probe_test_access(text,text,text) owner to novel_d1b_mutator;
revoke create on schema source_ingest_d1b_fixture_v1 from novel_d1b_mutator;
alter function source_ingest_d1b_fixture_v1.guard_test_authorization() owner to novel_d1b_owner;
commit;
