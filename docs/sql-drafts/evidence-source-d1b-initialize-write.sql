-- Initialization, receipt-only registration and historical replay, in the disposable PG16 fixture.
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
grant execute on function source_ingest_d1b_initialize_material_v1.prepare(jsonb,jsonb,text,timestamptz,boolean),
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
-- and the allowed budget deltas are admitted for the non-login initializer.
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
      if NEW.receipt_count=OLD.receipt_count+1 and NEW.receipt_bytes>OLD.receipt_bytes
        and ((NEW.source_count=OLD.source_count+2 and NEW.source_bytes>OLD.source_bytes)
          or (NEW.source_count=OLD.source_count and NEW.source_bytes=OLD.source_bytes))
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

-- Read only committed initialization evidence. The shared key lookup must see
-- all producers in an authorized workspace so a different producer conflicts.
grant select on source_ingest_d1b_fixture_v1.ingest_receipt,
  source_ingest_d1b_fixture_v1.receipt_source_member,source_ingest_d1b_fixture_v1.collection to novel_d1b_initializer;
grant select(workspace_id,collection_id,kind,id,version,payload_fingerprint,canonical,payload)
  on source_ingest_d1b_fixture_v1.source_version to novel_d1b_initializer;
grant select(workspace_id,collection_id,kind,id,version,payload_fingerprint,business_fingerprint,projection_rule_version)
  on source_ingest_d1b_fixture_v1.task_source_link,source_ingest_d1b_fixture_v1.snapshot_source_link
  to novel_d1b_initializer;
grant select(quote_record_id,quote_record_version,quote_fingerprint)
  on source_ingest_d1b_fixture_v1.snapshot_source_link to novel_d1b_initializer;

do $policies$
declare target text;
begin
  foreach target in array array['ingest_receipt','receipt_source_member','collection','source_version',
    'task_source_link','snapshot_source_link'] loop
    execute format('create policy initialize_replay on source_ingest_d1b_fixture_v1.%I
      for select to novel_d1b_initializer using
      (source_ingest_d1b_initialize_write_v1.can_initialize_workspace(workspace_id))',target);
  end loop;
end $policies$;

create function source_ingest_d1b_initialize_write_v1.replay_initialize(
  identity jsonb, identity_bytes bytea
) returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,pg_temp as $body$
declare
  stored source_ingest_d1b_fixture_v1.ingest_receipt%rowtype;
  reference_list jsonb;
  expected_receipt jsonb;
  digest text := encode(sha256(identity_bytes),'hex');
begin
  select * into stored from source_ingest_d1b_fixture_v1.ingest_receipt
    where workspace_id=identity->>'workspaceId' and ingest_id=identity->>'ingestId';
  if not found then return null; end if;
  if stored.command_fingerprint is distinct from digest then raise exception 'CONFLICT'; end if;
  if stored.command is distinct from identity or stored.command_canonical is distinct from identity_bytes
    or stored.unit_id is distinct from identity->>'unitId' or stored.operation<>'initialize'
    or stored.producer_service_id is distinct from identity->>'serviceId'
    then raise exception 'INTEGRITY_CONFLICT'; end if;

  select jsonb_agg(jsonb_build_object('kind',m.kind,'id',m.id,'version',m.version,
    'payloadFingerprint',m.payload_fingerprint) order by m.ordinal) into reference_list
  from source_ingest_d1b_fixture_v1.receipt_source_member m
  join source_ingest_d1b_fixture_v1.source_version s
    using(workspace_id,collection_id,kind,id,version,payload_fingerprint)
  where m.workspace_id=stored.workspace_id and m.ingest_id=stored.ingest_id and m.collection_id=stored.collection_id
    and source_ingest_d1b_fixture_v1.valid_document(s.payload,s.canonical,s.payload_fingerprint)
    and ((m.ordinal=0 and m.kind='task' and jsonb_build_object('id',m.id,'version',m.version)=identity->'taskReference'
      and exists(select 1 from source_ingest_d1b_fixture_v1.task_source_link t
        where (t.workspace_id,t.collection_id,t.kind,t.id,t.version,t.payload_fingerprint)
          =(m.workspace_id,m.collection_id,m.kind,m.id,m.version,m.payload_fingerprint)))
      or (m.ordinal=1 and m.kind='snapshot' and jsonb_build_object('id',m.id,'version',m.version)=identity->'snapshotReference'
      and exists(select 1 from source_ingest_d1b_fixture_v1.snapshot_source_link t
        where (t.workspace_id,t.collection_id,t.kind,t.id,t.version,t.payload_fingerprint)
          =(m.workspace_id,m.collection_id,m.kind,m.id,m.version,m.payload_fingerprint))));
  if jsonb_array_length(reference_list) is distinct from 2 then raise exception 'INTEGRITY_CONFLICT'; end if;

  expected_receipt := jsonb_build_object('protocolVersion',stored.protocol_version,'workspaceId',stored.workspace_id,
    'ingestId',stored.ingest_id,'operation',stored.operation,'producerServiceId',stored.producer_service_id,
    'commandFingerprint',digest,'collectionId',stored.collection_id,'unitId',stored.unit_id,
    'generationAtCommit',stored.generation_at_commit,'headRevisionAtCommit',stored.head_revision_at_commit,
    'status',stored.status,'sourceReferences',reference_list,
    'committedAt',source_ingest_d1b_codec_v1.utc_millis(stored.committed_at));
  if stored.receipt is distinct from expected_receipt
    or stored.receipt_canonical is distinct from source_ingest_d1b_codec_v1.encode_document('receipt',expected_receipt)
    or stored.receipt_fingerprint is distinct from encode(sha256(stored.receipt_canonical),'hex')
    then raise exception 'INTEGRITY_CONFLICT'; end if;
  return stored.receipt;
end $body$;
revoke all on function source_ingest_d1b_initialize_write_v1.replay_initialize(jsonb,bytea) from public;
grant execute on function source_ingest_d1b_initialize_write_v1.replay_initialize(jsonb,bytea) to novel_d1b_initializer;

create function source_ingest_d1b_initialize_write_v1.initialize_source_collection(
  command jsonb, expected_service text, expected_rule text
) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,pg_temp as $body$
declare
  ws text := command->>'workspaceId';
  permitted jsonb;
  identity jsonb;
  identity_bytes bytea;
  replayed jsonb;
  proof jsonb;
  material jsonb;
  package_bytes bigint;
  new_receipt_bytes bigint;
  source_row jsonb;
  receipt_row jsonb;
  existing source_ingest_d1b_fixture_v1.collection%rowtype;
  new_source_count integer;
begin
  permitted := source_ingest_d1b_fixture_v1.lock_authorization(ws,'initialize',null);
  if permitted->>'serviceId' is distinct from expected_service
    then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if command ?| array['operation','serviceId'] then raise exception 'INVALID_COMMAND'; end if;
  identity := command || jsonb_build_object('operation','initialize','serviceId',permitted->>'serviceId');
  identity_bytes := source_ingest_d1b_codec_v1.encode_document('identity',identity);
  replayed := source_ingest_d1b_initialize_write_v1.replay_initialize(identity,identity_bytes);
  if replayed is not null then return replayed; end if;
  perform workspace_id from source_ingest_d1b_fixture_v1.workspace_budget
    where workspace_id=ws for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  -- A concurrent first write may have committed while this call waited on the budget row.
  replayed := source_ingest_d1b_initialize_write_v1.replay_initialize(identity,identity_bytes);
  if replayed is not null then return replayed; end if;

  -- The workspace budget lock serializes every initialization writer for this unit.
  select * into existing from source_ingest_d1b_fixture_v1.collection
    where workspace_id=ws and unit_id=command->>'unitId';
  if found then
    if existing.generation<>1 or existing.head_revision<>1 or existing.member_count<>2
      or existing.history_count<>0 or existing.unresolved_count<>0
      or existing.current_seal_id is not null or existing.final_seal_id is not null
      then raise exception 'STATE_BLOCKED'; end if;
    if command->'taskReference' is distinct from jsonb_build_object('id',existing.task_id,'version',existing.task_version)
      or command->'snapshotReference' is distinct from jsonb_build_object('id',existing.snapshot_id,'version',existing.snapshot_version)
      or command->'executionReference' is distinct from jsonb_build_object('id',existing.execution_id,'version',existing.execution_version)
      then raise exception 'CONFLICT'; end if;
  end if;

  proof := source_ingest_d1b_verify_v1.verify_initialize_business(command,expected_service,expected_rule);
  material := source_ingest_d1b_initialize_material_v1.prepare(command,proof,
    coalesce(existing.collection_id,gen_random_uuid()::text),date_trunc('milliseconds',clock_timestamp()),
    existing.collection_id is not null);
  package_bytes := (material->>'packageBytes')::bigint;
  new_receipt_bytes := (material->>'receiptCost')::bigint;
  new_source_count := case when existing.collection_id is null then 2 else 0 end;

  if existing.collection_id is null then
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
  else
    if (to_jsonb(existing)-'package_bytes') is distinct from material->'collectionBase'
      then raise exception 'CONFLICT'; end if;
    for source_row in select unnest(array[material->'taskSource',material->'snapshotSource']) loop
      if not exists(select 1 from source_ingest_d1b_fixture_v1.source_version s
        where s.workspace_id=ws and s.collection_id=existing.collection_id and s.kind=source_row->>'kind'
          and s.id=source_row->>'id' and s.version=source_row->>'version'
          and s.payload_fingerprint=source_row->>'payload_fingerprint' and s.payload=source_row->'payload'
          and s.canonical=decode(source_row->>'canonical','hex'))
        then raise exception 'CONFLICT'; end if;
    end loop;
    if not exists(select 1 from source_ingest_d1b_fixture_v1.task_source_link t
      where (t.workspace_id,t.collection_id,t.id,t.version,t.payload_fingerprint)
      =(ws,existing.collection_id,existing.task_id,existing.task_version,material#>>'{taskLink,payload_fingerprint}')
        and t.business_fingerprint=existing.task_fingerprint
        and t.projection_rule_version=material#>>'{taskLink,projection_rule_version}')
      or not exists(select 1 from source_ingest_d1b_fixture_v1.snapshot_source_link t
      where (t.workspace_id,t.collection_id,t.id,t.version,t.payload_fingerprint)
      =(ws,existing.collection_id,existing.snapshot_id,existing.snapshot_version,material#>>'{snapshotLink,payload_fingerprint}')
        and t.business_fingerprint=existing.snapshot_fingerprint
        and t.projection_rule_version=material#>>'{snapshotLink,projection_rule_version}'
        and (t.quote_record_id,t.quote_record_version,t.quote_fingerprint)
          =(existing.quote_record_id,existing.quote_record_version,existing.quote_fingerprint))
      then raise exception 'INTEGRITY_CONFLICT'; end if;
  end if;
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
    source_count=budget.source_count+new_source_count, source_bytes=budget.source_bytes+package_bytes
    where workspace_id=ws and budget.receipt_count<1024 and budget.source_count+new_source_count<=4096
      and budget.receipt_bytes+new_receipt_bytes<=16777216
      and budget.source_bytes+package_bytes<=33554432;
  if not found then raise exception 'CAPACITY'; end if;
  return receipt_row->'receipt';
exception
  when insufficient_privilege then raise exception 'FORBIDDEN' using errcode='42501';
  when unique_violation then raise exception 'CONFLICT';
  when raise_exception then
    if sqlerrm='INVALID_CODEC_INPUT' then raise exception 'INVALID_COMMAND'; end if;
    if sqlerrm='CODEC_CAPACITY' then raise exception 'CAPACITY'; end if;
    if sqlerrm in ('INVALID_COMMAND','CONFLICT','STATE_BLOCKED','NOT_FOUND','INTEGRITY_CONFLICT','CAPACITY','UNAVAILABLE') then raise; end if;
    raise exception 'UNAVAILABLE';
  when query_canceled or others then raise exception 'UNAVAILABLE';
end $body$;
revoke all on function source_ingest_d1b_initialize_write_v1.initialize_source_collection(jsonb,text,text) from public;
alter function source_ingest_d1b_initialize_write_v1.initialize_source_collection(jsonb,text,text) owner to novel_d1b_initializer;
commit;
