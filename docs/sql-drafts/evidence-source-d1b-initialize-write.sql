-- First initialization only, in the disposable PG16 fixture.
begin;
do $guard$ begin
  if not (select rolsuper from pg_roles where rolname=session_user)
    or current_setting('server_version_num')::int/10000<>16
    or current_setting('server_encoding')<>'UTF8'
    or current_setting('listen_addresses')<>''
    or current_database() !~ '^d1b_[a-f0-9]{32}$'
    or current_setting('data_directory') !~ '^/private/tmp/source-d1b\.[A-Za-z0-9]{6}/data$'
    or to_regnamespace('source_ingest_d1b_initialize_material_v1') is null
    or to_regnamespace('source_ingest_d1b_initialize_access_v1') is null
    then raise exception 'INITIALIZE_WRITE_UNSUPPORTED'; end if;
  if exists(select 1 from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a
    where d.defaclrole=(select oid from pg_roles where rolname=current_user)
      and d.defaclnamespace=0 and a.grantee not in (0,d.defaclrole))
    then raise exception 'INITIALIZE_WRITE_UNSUPPORTED'; end if;
end $guard$;

create schema source_ingest_d1b_initialize_write_v1;
revoke all on schema source_ingest_d1b_initialize_write_v1 from public;
grant usage on schema source_ingest_d1b_initialize_write_v1,
  source_ingest_d1b_initialize_material_v1 to novel_d1b_initializer;
grant execute on function source_ingest_d1b_initialize_material_v1.prepare(jsonb,jsonb,text,timestamptz),
  source_ingest_d1b_codec_v1.budget_bytes(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb),
  source_ingest_d1b_fixture_v1.valid_binding(jsonb,text,text,text),
  source_ingest_d1b_fixture_v1.valid_document(jsonb,bytea,text),
  source_ingest_d1b_fixture_v1.valid_id(text), source_ingest_d1b_fixture_v1.valid_ids(text[])
  to novel_d1b_initializer;
grant insert on source_ingest_d1b_fixture_v1.collection,source_ingest_d1b_fixture_v1.source_version,
  source_ingest_d1b_fixture_v1.task_source_link,source_ingest_d1b_fixture_v1.snapshot_source_link,
  source_ingest_d1b_fixture_v1.ingest_receipt,source_ingest_d1b_fixture_v1.receipt_source_member to novel_d1b_initializer;
grant select(workspace_id,receipt_count,receipt_bytes,source_count,source_bytes),
  update(receipt_count,receipt_bytes,source_count,source_bytes)
  on source_ingest_d1b_fixture_v1.workspace_budget to novel_d1b_initializer;

-- The existing ALWAYS row triggers stay installed. Only inserted initialization rows
-- and the four allowed budget deltas are admitted for the non-login initializer.
create or replace function source_ingest_d1b_fixture_v1.deny_draft_write() returns trigger
language plpgsql set search_path=pg_catalog,pg_temp as $body$
begin
  if current_user='novel_d1b_initializer' and TG_OP='INSERT' and TG_TABLE_NAME in
    ('collection','source_version','task_source_link','snapshot_source_link','ingest_receipt','receipt_source_member') then
    return NEW;
  end if;
  raise exception 'D1B_STORAGE_CLOSED' using errcode='P0001';
end $body$;

create or replace function source_ingest_d1b_fixture_v1.guard_test_business() returns trigger
language plpgsql set search_path=pg_catalog,pg_temp as $body$
begin
  if current_user='novel_d1b_initializer' then
    if TG_TABLE_NAME='workspace_budget' and TG_OP='UPDATE' then
      if NEW.receipt_count=OLD.receipt_count+1 and NEW.source_count=OLD.source_count+2
        and NEW.receipt_bytes>OLD.receipt_bytes and NEW.source_bytes>OLD.source_bytes
        and (to_jsonb(NEW)-array['receipt_count','source_count','receipt_bytes','source_bytes'])
          = (to_jsonb(OLD)-array['receipt_count','source_count','receipt_bytes','source_bytes']) then
        return NEW;
      end if;
    end if;
    raise exception using errcode='42501',message='FORBIDDEN';
  end if;
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

do $policies$
declare target text;
begin
  foreach target in array array['collection','source_version','task_source_link','snapshot_source_link',
    'ingest_receipt','receipt_source_member'] loop
    execute format('create policy initialize_insert on source_ingest_d1b_fixture_v1.%I
      for insert to novel_d1b_initializer with check
      (coalesce(source_ingest_d1b_fixture_v1.lock_authorization(workspace_id,''initialize'',null)->>''workspaceId''=workspace_id,false))',target);
  end loop;
end $policies$;
-- RLS can inspect unrelated rows under a sequential plan. Hide unauthorized rows.
create function source_ingest_d1b_initialize_write_v1.can_initialize_workspace(ws text) returns boolean
language plpgsql volatile security invoker set search_path=pg_catalog,pg_temp as $body$
begin
  return (source_ingest_d1b_fixture_v1.lock_authorization(ws,'initialize',null)->>'workspaceId'=ws) is true;
exception when insufficient_privilege then return false;
end $body$;
revoke all on function source_ingest_d1b_initialize_write_v1.can_initialize_workspace(text) from public;
grant execute on function source_ingest_d1b_initialize_write_v1.can_initialize_workspace(text) to novel_d1b_initializer;

create policy initialize_insert on source_ingest_d1b_fixture_v1.workspace_budget
  to novel_d1b_initializer
  using (source_ingest_d1b_initialize_write_v1.can_initialize_workspace(workspace_id))
  with check (source_ingest_d1b_initialize_write_v1.can_initialize_workspace(workspace_id));

create function source_ingest_d1b_initialize_write_v1.initialize_source_collection(
  command jsonb, expected_service text, expected_rule text
) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,pg_temp as $body$
declare
  ws text := command->>'workspaceId';
  permitted jsonb;
  proof jsonb;
  material jsonb;
  package_bytes bigint;
  new_receipt_bytes bigint;
  source_row jsonb;
  receipt_row jsonb;
begin
  permitted := source_ingest_d1b_fixture_v1.lock_authorization(ws,'initialize',null);
  if permitted->>'serviceId' is distinct from expected_service
    then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  perform workspace_id from source_ingest_d1b_fixture_v1.workspace_budget
    where workspace_id=ws for update;
  if not found then raise exception 'NOT_FOUND'; end if;

  proof := source_ingest_d1b_verify_v1.verify_initialize_business(command,expected_service,expected_rule);
  material := source_ingest_d1b_initialize_material_v1.prepare(command,proof,gen_random_uuid()::text,
    date_trunc('milliseconds',clock_timestamp()));
  package_bytes := (material->>'packageBytes')::bigint;
  new_receipt_bytes := (material->>'receiptCost')::bigint;

  insert into source_ingest_d1b_fixture_v1.collection
    select * from jsonb_populate_record(null::source_ingest_d1b_fixture_v1.collection,
      (material->'collectionBase') || jsonb_build_object('package_bytes',package_bytes));
  for source_row in select unnest(array[material->'taskSource',material->'snapshotSource']) loop
    insert into source_ingest_d1b_fixture_v1.source_version
      select * from jsonb_populate_record(null::source_ingest_d1b_fixture_v1.source_version,
        source_row || jsonb_build_object('canonical',chr(92)||'x'||(source_row->>'canonical')));
  end loop;
  insert into source_ingest_d1b_fixture_v1.task_source_link
    select * from jsonb_populate_record(null::source_ingest_d1b_fixture_v1.task_source_link,material->'taskLink');
  insert into source_ingest_d1b_fixture_v1.snapshot_source_link
    select * from jsonb_populate_record(null::source_ingest_d1b_fixture_v1.snapshot_source_link,material->'snapshotLink');
  receipt_row := material->'receiptBase';
  insert into source_ingest_d1b_fixture_v1.ingest_receipt
    select * from jsonb_populate_record(null::source_ingest_d1b_fixture_v1.ingest_receipt,
      receipt_row || jsonb_build_object('accounted_bytes',new_receipt_bytes,
        'command_canonical',chr(92)||'x'||(receipt_row->>'command_canonical'),
        'receipt_canonical',chr(92)||'x'||(receipt_row->>'receipt_canonical')));
  insert into source_ingest_d1b_fixture_v1.receipt_source_member
    select * from jsonb_populate_record(null::source_ingest_d1b_fixture_v1.receipt_source_member,material->'member0')
    union all
    select * from jsonb_populate_record(null::source_ingest_d1b_fixture_v1.receipt_source_member,material->'member1');
  update source_ingest_d1b_fixture_v1.workspace_budget as budget set
    receipt_count=budget.receipt_count+1, receipt_bytes=budget.receipt_bytes+new_receipt_bytes,
    source_count=budget.source_count+2, source_bytes=budget.source_bytes+package_bytes
    where workspace_id=ws and budget.receipt_count<1024 and budget.source_count<=4094
      and budget.receipt_bytes+new_receipt_bytes<=16777216
      and budget.source_bytes+package_bytes<=33554432;
  if not found then raise exception 'CAPACITY'; end if;
  return receipt_row->'receipt';
exception
  when insufficient_privilege then raise exception 'FORBIDDEN' using errcode='42501';
  when unique_violation then raise exception 'CONFLICT';
  when raise_exception then
    if sqlerrm='CODEC_CAPACITY' then raise exception 'CAPACITY'; end if;
    if sqlerrm in ('INVALID_COMMAND','NOT_FOUND','INTEGRITY_CONFLICT','CAPACITY','UNAVAILABLE') then raise; end if;
    raise exception 'UNAVAILABLE';
  when query_canceled or others then raise exception 'UNAVAILABLE';
end $body$;
revoke all on function source_ingest_d1b_initialize_write_v1.initialize_source_collection(jsonb,text,text) from public;
alter function source_ingest_d1b_initialize_write_v1.initialize_source_collection(jsonb,text,text) owner to novel_d1b_initializer;
commit;
