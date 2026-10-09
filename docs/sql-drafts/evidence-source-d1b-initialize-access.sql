-- DRAFT: isolated PG16 initializer read/verification permissions only, NOT a writer.
-- No LOGIN provisioning, no application EXECUTE, no INSERT/UPDATE/DELETE or guard changes.
begin;
do $guard$ begin
  if current_setting('server_version_num')::int/10000<>16 or current_setting('server_encoding')<>'UTF8'
    or current_setting('listen_addresses')<>''
    or current_database() !~ '^d1b_[a-f0-9]{32}$'
    or current_setting('data_directory') !~ '^/private/tmp/source-d1b\.[A-Za-z0-9]{6}/data$'
    or to_regnamespace('source_ingest_d1b_verify_v1') is null then raise exception 'INITIALIZE_ACCESS_PROFILE_UNSUPPORTED'; end if;
  if exists(select 1 from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a
    where d.defaclrole=(select oid from pg_roles where rolname=current_user) and d.defaclnamespace=0
      and a.grantee not in (0,d.defaclrole)) then raise exception 'INITIALIZE_ACCESS_PROFILE_UNSUPPORTED'; end if;
end $guard$;
create role novel_d1b_initializer nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls noreplication;
create schema source_ingest_d1b_initialize_access_v1;
revoke all on schema source_ingest_d1b_initialize_access_v1 from public;
-- Namespace remains owned by the controlled DDL administrator, not the initializer.
grant usage on schema source_ingest_d1b_initialize_access_v1 to novel_d1b_initializer;

grant usage on schema source_ingest_d1b_fixture_v1,source_ingest_d1b_codec_v1,source_ingest_d1b_verify_v1 to novel_d1b_initializer;
grant select on source_ingest_d1b_fixture_v1.task_revision,source_ingest_d1b_fixture_v1.fixed_snapshot,
  source_ingest_d1b_fixture_v1.execution_identity,source_ingest_d1b_fixture_v1.fixed_quote to novel_d1b_initializer;
grant execute on function source_ingest_d1b_fixture_v1.lock_authorization(text,text,text) to novel_d1b_initializer;
grant execute on function source_ingest_d1b_verify_v1.verify_business_row(text,jsonb),
  source_ingest_d1b_verify_v1.verify_initialize_business(jsonb,text,text) to novel_d1b_initializer;
grant execute on function source_ingest_d1b_codec_v1.profiles(),source_ingest_d1b_codec_v1.quote_string(text),
  source_ingest_d1b_codec_v1.valid_identifier(text),source_ingest_d1b_codec_v1.utc_millis(timestamptz),
  source_ingest_d1b_codec_v1.walk(jsonb,jsonb,text,int,int),source_ingest_d1b_codec_v1.encode_document(text,jsonb),
  source_ingest_d1b_codec_v1.project_payload(text,jsonb,jsonb,text) to novel_d1b_initializer;

-- Nonrecursive policy: authorization tables are read only by the existing locker.
-- Identity is session_user, never current_user or a caller-controlled GUC.
create function source_ingest_d1b_initialize_access_v1.can_read_business(ws text,producer text) returns boolean
language plpgsql volatile security invoker set search_path=pg_catalog,pg_temp as $body$
declare permission jsonb;
begin
  permission:=source_ingest_d1b_fixture_v1.lock_authorization(ws,'initialize',null);
  return (permission->>'workspaceId'=ws and exists(select 1
    from jsonb_array_elements_text(permission->'allowedBusinessProducerServiceIds') p(value) where p.value=producer)) is true;
exception when insufficient_privilege then return false;
when others then raise exception 'UNAVAILABLE';
end $body$;
revoke all on function source_ingest_d1b_initialize_access_v1.can_read_business(text,text) from public;
alter function source_ingest_d1b_initialize_access_v1.can_read_business(text,text) owner to novel_d1b_initializer;

create policy initializer_business_select on source_ingest_d1b_fixture_v1.task_revision for select to novel_d1b_initializer
  using(source_ingest_d1b_initialize_access_v1.can_read_business(workspace_id,producer_service_id));
create policy initializer_business_select on source_ingest_d1b_fixture_v1.fixed_snapshot for select to novel_d1b_initializer
  using(source_ingest_d1b_initialize_access_v1.can_read_business(workspace_id,producer_service_id));
create policy initializer_business_select on source_ingest_d1b_fixture_v1.execution_identity for select to novel_d1b_initializer
  using(source_ingest_d1b_initialize_access_v1.can_read_business(workspace_id,producer_service_id));
create policy initializer_business_select on source_ingest_d1b_fixture_v1.fixed_quote for select to novel_d1b_initializer
  using(source_ingest_d1b_initialize_access_v1.can_read_business(workspace_id,producer_service_id));
-- No table mutation permissions, no type/role membership, no runtime call entrypoint.
commit;
