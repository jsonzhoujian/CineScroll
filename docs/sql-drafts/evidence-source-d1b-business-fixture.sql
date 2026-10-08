-- TEST ONLY, trusted administrator in a disposable socket-only PG16 cluster.
-- Not an application migration. Original closed-profile readiness must reject this extension.
begin;
do $guard$ begin
  if not (select rolsuper from pg_roles where rolname=session_user)
    or current_setting('server_version_num')::integer / 10000 <> 16
    or current_setting('server_encoding') <> 'UTF8'
    or current_setting('listen_addresses') <> ''
    or current_setting('data_directory') !~ '^/private/tmp/source-d1b\.[A-Za-z0-9]{6}/data$'
    or current_database() !~ '^d1b_[a-f0-9]{32}$' then raise exception 'D1B_TEST_ONLY'; end if;
end $guard$;
create role novel_d1b_business_fixture nologin nosuperuser nocreatedb nocreaterole nobypassrls noreplication;
grant usage on schema source_ingest_d1b_fixture_v1 to novel_d1b_business_fixture;
grant select,insert on source_ingest_d1b_fixture_v1.task_revision,
  source_ingest_d1b_fixture_v1.fixed_snapshot,source_ingest_d1b_fixture_v1.execution_identity,
  source_ingest_d1b_fixture_v1.fixed_quote,source_ingest_d1b_fixture_v1.workspace_budget to novel_d1b_business_fixture;
grant update(business_count,business_bytes) on source_ingest_d1b_fixture_v1.workspace_budget to novel_d1b_business_fixture;
grant execute on function source_ingest_d1b_fixture_v1.valid_id(text),source_ingest_d1b_fixture_v1.valid_ids(text[]),
  source_ingest_d1b_fixture_v1.valid_binding(jsonb,text,text,text),source_ingest_d1b_fixture_v1.valid_document(jsonb,bytea,text)
  to novel_d1b_business_fixture;

create function source_ingest_d1b_fixture_v1.guard_test_business() returns trigger
language plpgsql set search_path=pg_catalog,pg_temp as $body$
begin
  if current_user <> 'novel_d1b_business_fixture'
    or not (select rolsuper from pg_roles where rolname=session_user) then
    raise exception using errcode='42501',message='FORBIDDEN';
  end if;
  if TG_TABLE_NAME='workspace_budget' then
    if TG_OP='INSERT' then
      if NEW.receipt_count<>0 or NEW.receipt_bytes<>0 or NEW.source_count<>0 or NEW.source_bytes<>0
        or NEW.business_count<>0 or NEW.business_bytes<>0 then raise exception 'INVALID_TEST_BUDGET'; end if;
    elsif TG_OP='UPDATE' then
      if (to_jsonb(NEW)-array['business_count','business_bytes'])<>(to_jsonb(OLD)-array['business_count','business_bytes'])
        or NEW.business_count<OLD.business_count or NEW.business_bytes<OLD.business_bytes then raise exception 'INVALID_TEST_BUDGET'; end if;
    else raise exception using errcode='42501',message='FORBIDDEN'; end if;
  elsif TG_OP<>'INSERT' then
    raise exception using errcode='42501',message='FORBIDDEN';
  end if;
  return NEW;
end $body$;
revoke all on function source_ingest_d1b_fixture_v1.guard_test_business() from public;
do $install$ declare target text; begin
  foreach target in array array['task_revision','fixed_snapshot','execution_identity','fixed_quote','workspace_budget'] loop
    execute format('create policy test_business_access on source_ingest_d1b_fixture_v1.%I to novel_d1b_business_fixture using(true) with check(true)',target);
    execute format('drop trigger draft_closed_row on source_ingest_d1b_fixture_v1.%I',target);
    execute format('create trigger test_business_row before insert or update or delete on source_ingest_d1b_fixture_v1.%I for each row execute function source_ingest_d1b_fixture_v1.guard_test_business()',target);
    execute format('alter table source_ingest_d1b_fixture_v1.%I enable always trigger test_business_row',target);
  end loop;
end $install$;
alter function source_ingest_d1b_fixture_v1.guard_test_business() owner to novel_d1b_owner;
commit;
