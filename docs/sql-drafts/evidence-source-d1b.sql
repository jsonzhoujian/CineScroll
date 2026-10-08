-- DRAFT ONLY: PG16/UTF8, fresh isolated database, trusted DDL administrator.
-- Never loaded by the application. NOT a migration. NOT executed in this task.
-- Strict creation; no IF NOT EXISTS, login provisioning, seeds or production assembly.
-- This is storage + internal authorization locking, NOT an ingest writer.
begin;
do $guard$ begin
  if current_setting('server_version_num')::integer / 10000 <> 16
     or current_setting('server_encoding') <> 'UTF8' then
    raise exception 'D1B_PROFILE_UNSUPPORTED';
  end if;
end $guard$;

create role novel_d1b_owner nologin nosuperuser nocreatedb nocreaterole nobypassrls noreplication;
create role novel_d1b_locker nologin nosuperuser nocreatedb nocreaterole nobypassrls noreplication;
create role novel_d1b_mutator nologin nosuperuser nocreatedb nocreaterole nobypassrls noreplication;
create role novel_d1b_reader nologin nosuperuser nocreatedb nocreaterole nobypassrls noreplication;
create role novel_d1b_inspector nologin nosuperuser nocreatedb nocreaterole nobypassrls noreplication;
create schema source_ingest_d1b_fixture_v1 authorization novel_d1b_owner;
revoke all on schema source_ingest_d1b_fixture_v1 from public;
grant usage on schema source_ingest_d1b_fixture_v1 to novel_d1b_locker, novel_d1b_mutator, novel_d1b_reader, novel_d1b_inspector;
set local role novel_d1b_owner;
alter default privileges in schema source_ingest_d1b_fixture_v1 revoke execute on functions from public;
alter default privileges in schema source_ingest_d1b_fixture_v1 revoke all on tables from public;
alter default privileges in schema source_ingest_d1b_fixture_v1 revoke usage on types from public;

-- UTF16 length matches the JS protocol for representable PostgreSQL text.
-- NUL/unpaired UTF16 surrogates must be rejected before the driver; never normalized.
create function source_ingest_d1b_fixture_v1.valid_id(value text) returns boolean
language plpgsql immutable set search_path = pg_catalog, pg_temp as $body$
declare units integer := 0; ch text;
begin
  if value is null or value = '' or value <> btrim(value,
    chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||
    chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||
    chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||
    chr(8287)||chr(12288)||chr(65279))
    or value ~ E'[\\r\\n*?]' or strpos(value, '://') > 0 then return false; end if;
  for ch in select regexp_split_to_table(value, '') loop
    units := units + case when ascii(ch) > 65535 then 2 else 1 end;
    if units > 256 then return false; end if;
  end loop;
  return units > 0;
end $body$;
create domain source_ingest_d1b_fixture_v1.identifier as text collate "C"
  check (value is null or source_ingest_d1b_fixture_v1.valid_id(value));
create domain source_ingest_d1b_fixture_v1.fingerprint as text collate "C"
  check (value ~ '^[a-f0-9]{64}$');
create domain source_ingest_d1b_fixture_v1.safe_positive as bigint
  check (value between 1 and 9007199254740991);

-- This verifies JSON/bytes/digest correspondence, NOT JS canonical ordering.
-- The future writer must construct/verify the frozen canonical representation.
create function source_ingest_d1b_fixture_v1.valid_document(body jsonb, bytes bytea, digest text)
returns boolean language plpgsql immutable set search_path = pg_catalog, pg_temp as $body$
begin
  return (jsonb_typeof(body) = 'object'
    and octet_length(bytes) between 1 and 2097152
    and convert_from(bytes, 'UTF8')::jsonb = body
    and encode(sha256(bytes), 'hex') = digest) is true;
exception when others then return false;
end $body$;
create function source_ingest_d1b_fixture_v1.valid_ids(items text[]) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $body$
select (items is not null and cardinality(items) <= 100
  and (cardinality(items) = 0 or (array_ndims(items) = 1 and array_lower(items, 1) = 1))
  and not exists(select 1 from unnest(items) v where not source_ingest_d1b_fixture_v1.valid_id(v))
  and cardinality(items) = (select count(distinct v collate "C") from unnest(items) v)) is true
$body$;
create function source_ingest_d1b_fixture_v1.valid_binding(body jsonb, ws text, task text, unit text)
returns boolean language sql immutable set search_path = pg_catalog, pg_temp as $body$
select (jsonb_typeof(body) = 'object'
  and body ?& array['workspaceId','taskId','unitId','projectId','chapterId','sourceVersionId','upstreamVersionIds']
  and body - array['workspaceId','taskId','unitId','projectId','chapterId','sourceVersionId','upstreamVersionIds'] = '{}'::jsonb
  and body->>'workspaceId' = ws and body->>'taskId' = task and body->>'unitId' = unit
  and source_ingest_d1b_fixture_v1.valid_id(body->>'projectId') and source_ingest_d1b_fixture_v1.valid_id(body->>'chapterId')
  and source_ingest_d1b_fixture_v1.valid_id(body->>'sourceVersionId')
  and jsonb_typeof(body->'upstreamVersionIds') = 'array') is true
$body$;

create table source_ingest_d1b_fixture_v1.service_principal (
  login_name text collate "C" primary key,
  service_id source_ingest_d1b_fixture_v1.identifier not null unique,
  enabled boolean not null, revision source_ingest_d1b_fixture_v1.safe_positive not null,
  lock_token boolean not null default false,
  check (source_ingest_d1b_fixture_v1.valid_id(login_name)), check (lock_token = false)
);
create table source_ingest_d1b_fixture_v1.workspace_service_grant (
  workspace_id source_ingest_d1b_fixture_v1.identifier not null, service_id source_ingest_d1b_fixture_v1.identifier not null,
  enabled boolean not null, revision source_ingest_d1b_fixture_v1.safe_positive not null,
  allow_initialize boolean not null, allow_register boolean not null, allow_receipt_read boolean not null,
  allowed_kinds text[] not null, business_producer_ids text[] not null, receipt_producer_ids text[] not null,
  lock_token boolean not null default false,
  primary key(workspace_id,service_id),
  foreign key(service_id) references source_ingest_d1b_fixture_v1.service_principal(service_id),
  check (source_ingest_d1b_fixture_v1.valid_ids(allowed_kinds) and allowed_kinds <@ array['task','snapshot']),
  check (source_ingest_d1b_fixture_v1.valid_ids(business_producer_ids) and source_ingest_d1b_fixture_v1.valid_ids(receipt_producer_ids)),
  check (lock_token = false)
);
create index grant_service_lookup on source_ingest_d1b_fixture_v1.workspace_service_grant(service_id,workspace_id);

create table source_ingest_d1b_fixture_v1.workspace_budget (
  workspace_id source_ingest_d1b_fixture_v1.identifier primary key,
  receipt_count integer not null check (receipt_count between 0 and 1024),
  receipt_bytes bigint not null check (receipt_bytes between 0 and 16777216),
  source_count integer not null check (source_count between 0 and 4096),
  source_bytes bigint not null check (source_bytes between 0 and 33554432),
  business_count integer not null check (business_count between 0 and 4096),
  business_bytes bigint not null check (business_bytes between 0 and 16777216)
);

create table source_ingest_d1b_fixture_v1.task_revision (
  workspace_id source_ingest_d1b_fixture_v1.identifier not null, id source_ingest_d1b_fixture_v1.identifier not null, version source_ingest_d1b_fixture_v1.identifier not null,
  task_id source_ingest_d1b_fixture_v1.identifier not null, unit_id source_ingest_d1b_fixture_v1.identifier not null, binding jsonb not null,
  producer_service_id source_ingest_d1b_fixture_v1.identifier not null, recorded_at timestamptz not null check (isfinite(recorded_at)),
  document jsonb not null, canonical bytea not null, business_fingerprint source_ingest_d1b_fixture_v1.fingerprint not null,
  primary key(workspace_id,id,version),
  check (source_ingest_d1b_fixture_v1.valid_binding(binding,workspace_id,task_id,unit_id)),
  check (source_ingest_d1b_fixture_v1.valid_document(document,canonical,business_fingerprint)),
  revision source_ingest_d1b_fixture_v1.safe_positive not null, predecessor_version source_ingest_d1b_fixture_v1.identifier,
  scope_keys text[] not null,
  snapshot_id source_ingest_d1b_fixture_v1.identifier not null, snapshot_version source_ingest_d1b_fixture_v1.identifier not null,
  execution_id source_ingest_d1b_fixture_v1.identifier not null, execution_version source_ingest_d1b_fixture_v1.identifier not null,
  unique(workspace_id,id,revision),
  check(id=task_id), check(scope_keys=array[unit_id::text]),
  check((revision=1 and predecessor_version is null) or (revision>1 and predecessor_version is not null and predecessor_version<>version)),
  foreign key(workspace_id,id,predecessor_version) references source_ingest_d1b_fixture_v1.task_revision(workspace_id,id,version) deferrable initially deferred
);
create table source_ingest_d1b_fixture_v1.fixed_snapshot (
  workspace_id source_ingest_d1b_fixture_v1.identifier not null, id source_ingest_d1b_fixture_v1.identifier not null, version source_ingest_d1b_fixture_v1.identifier not null,
  task_id source_ingest_d1b_fixture_v1.identifier not null, unit_id source_ingest_d1b_fixture_v1.identifier not null, binding jsonb not null,
  producer_service_id source_ingest_d1b_fixture_v1.identifier not null, recorded_at timestamptz not null check (isfinite(recorded_at)),
  document jsonb not null, canonical bytea not null, business_fingerprint source_ingest_d1b_fixture_v1.fingerprint not null,
  primary key(workspace_id,id,version),
  check (source_ingest_d1b_fixture_v1.valid_binding(binding,workspace_id,task_id,unit_id)),
  check (source_ingest_d1b_fixture_v1.valid_document(document,canonical,business_fingerprint)),
  task_anchor_version source_ingest_d1b_fixture_v1.identifier not null,
  execution_id source_ingest_d1b_fixture_v1.identifier not null, execution_version source_ingest_d1b_fixture_v1.identifier not null,
  quote_record_id source_ingest_d1b_fixture_v1.identifier not null, quote_record_version source_ingest_d1b_fixture_v1.identifier not null,
  quote_id source_ingest_d1b_fixture_v1.identifier not null, price_version source_ingest_d1b_fixture_v1.identifier not null,
  responsibility text not null check(responsibility in ('platform','byok')),
  reserved bigint not null,
  check((responsibility='platform' and reserved between 1 and 9007199254740991) or (responsibility='byok' and reserved=0))
);
create table source_ingest_d1b_fixture_v1.execution_identity (
  workspace_id source_ingest_d1b_fixture_v1.identifier not null, id source_ingest_d1b_fixture_v1.identifier not null, version source_ingest_d1b_fixture_v1.identifier not null,
  task_id source_ingest_d1b_fixture_v1.identifier not null, unit_id source_ingest_d1b_fixture_v1.identifier not null, binding jsonb not null,
  producer_service_id source_ingest_d1b_fixture_v1.identifier not null, recorded_at timestamptz not null check (isfinite(recorded_at)),
  document jsonb not null, canonical bytea not null, business_fingerprint source_ingest_d1b_fixture_v1.fingerprint not null,
  primary key(workspace_id,id,version),
  check (source_ingest_d1b_fixture_v1.valid_binding(binding,workspace_id,task_id,unit_id)),
  check (source_ingest_d1b_fixture_v1.valid_document(document,canonical,business_fingerprint)),
  task_anchor_version source_ingest_d1b_fixture_v1.identifier not null,
  snapshot_id source_ingest_d1b_fixture_v1.identifier not null, snapshot_version source_ingest_d1b_fixture_v1.identifier not null
);
create table source_ingest_d1b_fixture_v1.fixed_quote (
  workspace_id source_ingest_d1b_fixture_v1.identifier not null, id source_ingest_d1b_fixture_v1.identifier not null, version source_ingest_d1b_fixture_v1.identifier not null,
  task_id source_ingest_d1b_fixture_v1.identifier not null, unit_id source_ingest_d1b_fixture_v1.identifier not null, binding jsonb not null,
  producer_service_id source_ingest_d1b_fixture_v1.identifier not null, recorded_at timestamptz not null check (isfinite(recorded_at)),
  document jsonb not null, canonical bytea not null, business_fingerprint source_ingest_d1b_fixture_v1.fingerprint not null,
  primary key(workspace_id,id,version),
  check (source_ingest_d1b_fixture_v1.valid_binding(binding,workspace_id,task_id,unit_id)),
  check (source_ingest_d1b_fixture_v1.valid_document(document,canonical,business_fingerprint)),
  task_anchor_version source_ingest_d1b_fixture_v1.identifier not null,
  execution_id source_ingest_d1b_fixture_v1.identifier not null, execution_version source_ingest_d1b_fixture_v1.identifier not null,
  quote_id source_ingest_d1b_fixture_v1.identifier not null, price_version source_ingest_d1b_fixture_v1.identifier not null,
  responsibility text not null check(responsibility in ('platform','byok')),
  reserved bigint not null, pricing_rule_version source_ingest_d1b_fixture_v1.identifier not null,
  check((responsibility='platform' and reserved between 1 and 9007199254740991) or (responsibility='byok' and reserved=0))
);
alter table source_ingest_d1b_fixture_v1.task_revision add constraint task_revision_snapshot_fk foreign key(workspace_id,snapshot_id,snapshot_version) references source_ingest_d1b_fixture_v1.fixed_snapshot(workspace_id,id,version) deferrable initially deferred;
create index task_revision_snapshot_lookup on source_ingest_d1b_fixture_v1.task_revision(workspace_id,snapshot_id,snapshot_version);
alter table source_ingest_d1b_fixture_v1.task_revision add constraint task_revision_execution_fk foreign key(workspace_id,execution_id,execution_version) references source_ingest_d1b_fixture_v1.execution_identity(workspace_id,id,version) deferrable initially deferred;
create index task_revision_execution_lookup on source_ingest_d1b_fixture_v1.task_revision(workspace_id,execution_id,execution_version);
alter table source_ingest_d1b_fixture_v1.fixed_snapshot add constraint fixed_snapshot_task_fk foreign key(workspace_id,task_id,task_anchor_version) references source_ingest_d1b_fixture_v1.task_revision(workspace_id,id,version) deferrable initially deferred;
create index fixed_snapshot_task_lookup on source_ingest_d1b_fixture_v1.fixed_snapshot(workspace_id,task_id,task_anchor_version);
alter table source_ingest_d1b_fixture_v1.fixed_snapshot add constraint fixed_snapshot_execution_fk foreign key(workspace_id,execution_id,execution_version) references source_ingest_d1b_fixture_v1.execution_identity(workspace_id,id,version) deferrable initially deferred;
create index fixed_snapshot_execution_lookup on source_ingest_d1b_fixture_v1.fixed_snapshot(workspace_id,execution_id,execution_version);
alter table source_ingest_d1b_fixture_v1.fixed_snapshot add constraint fixed_snapshot_quote_fk foreign key(workspace_id,quote_record_id,quote_record_version) references source_ingest_d1b_fixture_v1.fixed_quote(workspace_id,id,version) deferrable initially deferred;
create index fixed_snapshot_quote_lookup on source_ingest_d1b_fixture_v1.fixed_snapshot(workspace_id,quote_record_id,quote_record_version);
alter table source_ingest_d1b_fixture_v1.execution_identity add constraint execution_identity_task_fk foreign key(workspace_id,task_id,task_anchor_version) references source_ingest_d1b_fixture_v1.task_revision(workspace_id,id,version) deferrable initially deferred;
create index execution_identity_task_lookup on source_ingest_d1b_fixture_v1.execution_identity(workspace_id,task_id,task_anchor_version);
alter table source_ingest_d1b_fixture_v1.execution_identity add constraint execution_identity_snapshot_fk foreign key(workspace_id,snapshot_id,snapshot_version) references source_ingest_d1b_fixture_v1.fixed_snapshot(workspace_id,id,version) deferrable initially deferred;
create index execution_identity_snapshot_lookup on source_ingest_d1b_fixture_v1.execution_identity(workspace_id,snapshot_id,snapshot_version);
alter table source_ingest_d1b_fixture_v1.fixed_quote add constraint fixed_quote_task_fk foreign key(workspace_id,task_id,task_anchor_version) references source_ingest_d1b_fixture_v1.task_revision(workspace_id,id,version) deferrable initially deferred;
create index fixed_quote_task_lookup on source_ingest_d1b_fixture_v1.fixed_quote(workspace_id,task_id,task_anchor_version);
alter table source_ingest_d1b_fixture_v1.fixed_quote add constraint fixed_quote_execution_fk foreign key(workspace_id,execution_id,execution_version) references source_ingest_d1b_fixture_v1.execution_identity(workspace_id,id,version) deferrable initially deferred;
create index fixed_quote_execution_lookup on source_ingest_d1b_fixture_v1.fixed_quote(workspace_id,execution_id,execution_version);

create table source_ingest_d1b_fixture_v1.collection (
  workspace_id source_ingest_d1b_fixture_v1.identifier not null, collection_id source_ingest_d1b_fixture_v1.identifier not null,
  unit_id source_ingest_d1b_fixture_v1.identifier not null, task_id source_ingest_d1b_fixture_v1.identifier not null, task_version source_ingest_d1b_fixture_v1.identifier not null,
  snapshot_id source_ingest_d1b_fixture_v1.identifier not null, snapshot_version source_ingest_d1b_fixture_v1.identifier not null,
  execution_id source_ingest_d1b_fixture_v1.identifier not null, execution_version source_ingest_d1b_fixture_v1.identifier not null,
  quote_record_id source_ingest_d1b_fixture_v1.identifier not null, quote_record_version source_ingest_d1b_fixture_v1.identifier not null,
  task_fingerprint source_ingest_d1b_fixture_v1.fingerprint not null, snapshot_fingerprint source_ingest_d1b_fixture_v1.fingerprint not null,
  execution_fingerprint source_ingest_d1b_fixture_v1.fingerprint not null, quote_fingerprint source_ingest_d1b_fixture_v1.fingerprint not null,
  binding jsonb not null, generation bigint not null check(generation=1),
  head_revision source_ingest_d1b_fixture_v1.safe_positive not null,
  member_count integer not null check(member_count between 2 and 256),
  package_bytes bigint not null check(package_bytes between 1 and 2097152),
  history_count integer not null check(history_count=0), unresolved_count integer not null check(unresolved_count=0),
  current_seal_id text check(current_seal_id is null), final_seal_id text check(final_seal_id is null),
  primary key(workspace_id,collection_id), unique(workspace_id,unit_id),
  unique(workspace_id,collection_id,unit_id),
  check(source_ingest_d1b_fixture_v1.valid_binding(binding,workspace_id,task_id,unit_id)),
  foreign key(workspace_id) references source_ingest_d1b_fixture_v1.workspace_budget(workspace_id),
  foreign key(workspace_id,task_id,task_version) references source_ingest_d1b_fixture_v1.task_revision(workspace_id,id,version),
  foreign key(workspace_id,snapshot_id,snapshot_version) references source_ingest_d1b_fixture_v1.fixed_snapshot(workspace_id,id,version),
  foreign key(workspace_id,execution_id,execution_version) references source_ingest_d1b_fixture_v1.execution_identity(workspace_id,id,version),
  foreign key(workspace_id,quote_record_id,quote_record_version) references source_ingest_d1b_fixture_v1.fixed_quote(workspace_id,id,version)
);
create table source_ingest_d1b_fixture_v1.source_version (
  workspace_id source_ingest_d1b_fixture_v1.identifier not null, collection_id source_ingest_d1b_fixture_v1.identifier not null,
  kind text collate "C" not null check(kind in ('task','snapshot')),
  id source_ingest_d1b_fixture_v1.identifier not null, version source_ingest_d1b_fixture_v1.identifier not null,
  revision source_ingest_d1b_fixture_v1.safe_positive not null, predecessor_version source_ingest_d1b_fixture_v1.identifier,
  introduced_generation bigint not null check(introduced_generation=1),
  payload jsonb not null, canonical bytea not null, payload_fingerprint source_ingest_d1b_fixture_v1.fingerprint not null,
  producer_service_id source_ingest_d1b_fixture_v1.identifier not null, rule_version source_ingest_d1b_fixture_v1.identifier not null,
  recorded_at timestamptz not null check(isfinite(recorded_at)),
  primary key(workspace_id,collection_id,kind,id,version),
  unique(workspace_id,collection_id,kind,id,revision),
  unique(workspace_id,collection_id,kind,id,version,payload_fingerprint),
  foreign key(workspace_id,collection_id) references source_ingest_d1b_fixture_v1.collection(workspace_id,collection_id),
  foreign key(workspace_id,collection_id,kind,id,predecessor_version)
    references source_ingest_d1b_fixture_v1.source_version(workspace_id,collection_id,kind,id,version) deferrable initially deferred,
  check((revision=1 and predecessor_version is null) or (revision>1 and predecessor_version is not null and predecessor_version<>version)),
  check(kind<>'snapshot' or revision=1),
  check(source_ingest_d1b_fixture_v1.valid_document(payload,canonical,payload_fingerprint))
);
create table source_ingest_d1b_fixture_v1.task_source_link (
  workspace_id source_ingest_d1b_fixture_v1.identifier not null, collection_id source_ingest_d1b_fixture_v1.identifier not null,
  kind text collate "C" not null check(kind='task'),
  id source_ingest_d1b_fixture_v1.identifier not null, version source_ingest_d1b_fixture_v1.identifier not null,
  payload_fingerprint source_ingest_d1b_fixture_v1.fingerprint not null, business_fingerprint source_ingest_d1b_fixture_v1.fingerprint not null,
  projection_rule_version source_ingest_d1b_fixture_v1.identifier not null, verified_by_service_id source_ingest_d1b_fixture_v1.identifier not null,
  verified_at timestamptz not null check(isfinite(verified_at)),
  primary key(workspace_id,collection_id,kind,id,version),
  foreign key(workspace_id,collection_id,kind,id,version,payload_fingerprint)
    references source_ingest_d1b_fixture_v1.source_version(workspace_id,collection_id,kind,id,version,payload_fingerprint),
  foreign key(workspace_id,id,version) references source_ingest_d1b_fixture_v1.task_revision(workspace_id,id,version)
);
create table source_ingest_d1b_fixture_v1.snapshot_source_link (
  workspace_id source_ingest_d1b_fixture_v1.identifier not null, collection_id source_ingest_d1b_fixture_v1.identifier not null,
  kind text collate "C" not null check(kind='snapshot'),
  id source_ingest_d1b_fixture_v1.identifier not null, version source_ingest_d1b_fixture_v1.identifier not null,
  payload_fingerprint source_ingest_d1b_fixture_v1.fingerprint not null, business_fingerprint source_ingest_d1b_fixture_v1.fingerprint not null,
  quote_record_id source_ingest_d1b_fixture_v1.identifier not null, quote_record_version source_ingest_d1b_fixture_v1.identifier not null,
  quote_fingerprint source_ingest_d1b_fixture_v1.fingerprint not null,
  projection_rule_version source_ingest_d1b_fixture_v1.identifier not null, verified_by_service_id source_ingest_d1b_fixture_v1.identifier not null,
  verified_at timestamptz not null check(isfinite(verified_at)),
  primary key(workspace_id,collection_id,kind,id,version),
  foreign key(workspace_id,collection_id,kind,id,version,payload_fingerprint)
    references source_ingest_d1b_fixture_v1.source_version(workspace_id,collection_id,kind,id,version,payload_fingerprint),
  foreign key(workspace_id,id,version) references source_ingest_d1b_fixture_v1.fixed_snapshot(workspace_id,id,version),
  foreign key(workspace_id,quote_record_id,quote_record_version) references source_ingest_d1b_fixture_v1.fixed_quote(workspace_id,id,version)
);
create table source_ingest_d1b_fixture_v1.ingest_receipt (
  workspace_id source_ingest_d1b_fixture_v1.identifier not null, ingest_id source_ingest_d1b_fixture_v1.identifier not null,
  protocol_version text not null check(protocol_version='source-ingest-v1'),
  operation text not null check(operation in ('initialize','register')),
  producer_service_id source_ingest_d1b_fixture_v1.identifier not null,
  command jsonb not null, command_canonical bytea not null, command_fingerprint source_ingest_d1b_fixture_v1.fingerprint not null,
  collection_id source_ingest_d1b_fixture_v1.identifier not null, unit_id source_ingest_d1b_fixture_v1.identifier not null,
  generation_at_commit bigint not null check(generation_at_commit=1),
  head_revision_at_commit source_ingest_d1b_fixture_v1.safe_positive not null,
  status text not null, committed_at timestamptz not null check(isfinite(committed_at)),
  receipt jsonb not null, receipt_canonical bytea not null, receipt_fingerprint source_ingest_d1b_fixture_v1.fingerprint not null,
  accounted_bytes integer not null check(accounted_bytes between 1 and 16384),
  primary key(workspace_id,ingest_id),
  unique(workspace_id,ingest_id,collection_id),
  foreign key(workspace_id,collection_id,unit_id) references source_ingest_d1b_fixture_v1.collection(workspace_id,collection_id,unit_id),
  check((operation='initialize' and status in ('initialized','already_registered')) or
        (operation='register' and status in ('registered','already_registered'))),
  check(source_ingest_d1b_fixture_v1.valid_document(command,command_canonical,command_fingerprint)),
  check(source_ingest_d1b_fixture_v1.valid_document(receipt,receipt_canonical,receipt_fingerprint)),
  check(octet_length(command_canonical)+octet_length(receipt_canonical)<=accounted_bytes)
);
create table source_ingest_d1b_fixture_v1.receipt_source_member (
  workspace_id source_ingest_d1b_fixture_v1.identifier not null, ingest_id source_ingest_d1b_fixture_v1.identifier not null,
  collection_id source_ingest_d1b_fixture_v1.identifier not null, ordinal integer not null check(ordinal between 0 and 1),
  kind text collate "C" not null check(kind in ('task','snapshot')),
  id source_ingest_d1b_fixture_v1.identifier not null, version source_ingest_d1b_fixture_v1.identifier not null, payload_fingerprint source_ingest_d1b_fixture_v1.fingerprint not null,
  primary key(workspace_id,ingest_id,ordinal),
  unique(workspace_id,ingest_id,collection_id,kind,id,version),
  foreign key(workspace_id,ingest_id,collection_id) references source_ingest_d1b_fixture_v1.ingest_receipt(workspace_id,ingest_id,collection_id) deferrable initially deferred,
  foreign key(workspace_id,collection_id,kind,id,version,payload_fingerprint)
    references source_ingest_d1b_fixture_v1.source_version(workspace_id,collection_id,kind,id,version,payload_fingerprint)
);
-- Fixed initial sources exist at transaction completion; no separately committed empty collection.
alter table source_ingest_d1b_fixture_v1.collection add column initial_task_kind text not null default 'task' check(initial_task_kind='task');
alter table source_ingest_d1b_fixture_v1.collection add column initial_snapshot_kind text not null default 'snapshot' check(initial_snapshot_kind='snapshot');
alter table source_ingest_d1b_fixture_v1.collection add constraint collection_initial_task foreign key(workspace_id,collection_id,initial_task_kind,task_id,task_version)
  references source_ingest_d1b_fixture_v1.source_version(workspace_id,collection_id,kind,id,version) deferrable initially deferred;
alter table source_ingest_d1b_fixture_v1.collection add constraint collection_initial_snapshot foreign key(workspace_id,collection_id,initial_snapshot_kind,snapshot_id,snapshot_version)
  references source_ingest_d1b_fixture_v1.source_version(workspace_id,collection_id,kind,id,version) deferrable initially deferred;

create index task_previous_lookup on source_ingest_d1b_fixture_v1.task_revision(workspace_id,id,predecessor_version);
create index source_previous_lookup on source_ingest_d1b_fixture_v1.source_version(workspace_id,collection_id,kind,id,predecessor_version);
create index source_enumeration on source_ingest_d1b_fixture_v1.source_version(workspace_id,collection_id,introduced_generation,kind,id,revision);
create index task_link_business_lookup on source_ingest_d1b_fixture_v1.task_source_link(workspace_id,id,version);
create index snapshot_link_business_lookup on source_ingest_d1b_fixture_v1.snapshot_source_link(workspace_id,id,version);
create index snapshot_link_quote_lookup on source_ingest_d1b_fixture_v1.snapshot_source_link(workspace_id,quote_record_id,quote_record_version);
create index receipt_collection_lookup on source_ingest_d1b_fixture_v1.ingest_receipt(workspace_id,collection_id,unit_id);
create index receipt_producer_lookup on source_ingest_d1b_fixture_v1.ingest_receipt(workspace_id,producer_service_id,ingest_id);
create index receipt_member_source_lookup on source_ingest_d1b_fixture_v1.receipt_source_member(workspace_id,collection_id,kind,id,version,payload_fingerprint);
create index collection_task_lookup on source_ingest_d1b_fixture_v1.collection(workspace_id,task_id,task_version);
create index collection_snapshot_lookup on source_ingest_d1b_fixture_v1.collection(workspace_id,snapshot_id,snapshot_version);
create index collection_execution_lookup on source_ingest_d1b_fixture_v1.collection(workspace_id,execution_id,execution_version);
create index collection_quote_lookup on source_ingest_d1b_fixture_v1.collection(workspace_id,quote_record_id,quote_record_version);
create index collection_initial_task_lookup on source_ingest_d1b_fixture_v1.collection(workspace_id,collection_id,initial_task_kind,task_id,task_version);
create index collection_initial_snapshot_lookup on source_ingest_d1b_fixture_v1.collection(workspace_id,collection_id,initial_snapshot_kind,snapshot_id,snapshot_version);

-- Closed storage until canonical projection, budgets and writer functions are implemented.
-- Row locking does not fire UPDATE triggers. Even locker UPDATE(lock_token) cannot mutate.
create function source_ingest_d1b_fixture_v1.deny_draft_write() returns trigger
language plpgsql set search_path=pg_catalog,pg_temp as $body$
begin raise exception 'D1B_STORAGE_CLOSED' using errcode='P0001'; end $body$;

do $block$
declare relation_name text;
begin
  foreach relation_name in array array[
    'service_principal','workspace_service_grant','workspace_budget',
    'task_revision','fixed_snapshot','execution_identity','fixed_quote',
    'collection','source_version','task_source_link','snapshot_source_link',
    'ingest_receipt','receipt_source_member'
  ] loop
    execute format('alter table source_ingest_d1b_fixture_v1.%I enable row level security',relation_name);
    execute format('alter table source_ingest_d1b_fixture_v1.%I force row level security',relation_name);
    execute format('create trigger draft_closed_row before insert or update or delete on source_ingest_d1b_fixture_v1.%I for each row execute function source_ingest_d1b_fixture_v1.deny_draft_write()',relation_name);
    execute format('create trigger draft_closed_truncate before truncate on source_ingest_d1b_fixture_v1.%I for each statement execute function source_ingest_d1b_fixture_v1.deny_draft_write()',relation_name);
    execute format('alter table source_ingest_d1b_fixture_v1.%I enable always trigger draft_closed_row',relation_name);
    execute format('alter table source_ingest_d1b_fixture_v1.%I enable always trigger draft_closed_truncate',relation_name);
  end loop;
end $block$;

-- Non-recursive authorization-table policies for the internal locker only.
-- These policies permit locking; the column ACL + triggers still reject actual updates.
create policy principal_locker_select on source_ingest_d1b_fixture_v1.service_principal
  for select to novel_d1b_locker using (true);
create policy principal_locker_lock on source_ingest_d1b_fixture_v1.service_principal
  for update to novel_d1b_locker using (true) with check (true);
create policy grant_locker_select on source_ingest_d1b_fixture_v1.workspace_service_grant
  for select to novel_d1b_locker using (true);
create policy grant_locker_lock on source_ingest_d1b_fixture_v1.workspace_service_grant
  for update to novel_d1b_locker using (true) with check (true);

revoke all on all tables in schema source_ingest_d1b_fixture_v1 from public,novel_d1b_mutator,novel_d1b_reader,novel_d1b_inspector,novel_d1b_locker;
grant select on source_ingest_d1b_fixture_v1.service_principal,source_ingest_d1b_fixture_v1.workspace_service_grant to novel_d1b_locker;
grant update(lock_token) on source_ingest_d1b_fixture_v1.service_principal,source_ingest_d1b_fixture_v1.workspace_service_grant to novel_d1b_locker;

-- Internal only: no login receives EXECUTE or role membership in this draft.
-- Authorized caller identity is session_user across nested SECURITY DEFINER calls.
-- The helper only locks and returns an authorized snapshot; it neither grants rights
-- nor commits. The caller must retain the same transaction through its entire operation.
create function source_ingest_d1b_fixture_v1.lock_authorization(p_workspace text,p_operation text,p_kind text)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,pg_temp as $body$
declare
  principal source_ingest_d1b_fixture_v1.service_principal%rowtype;
  permission source_ingest_d1b_fixture_v1.workspace_service_grant%rowtype;
begin
  if current_setting('transaction_isolation') <> 'read committed'
    or not source_ingest_d1b_fixture_v1.valid_id(p_workspace)
    or p_operation is null or p_operation not in ('initialize','register','receipt_read')
    or (p_operation='register' and (p_kind is null or p_kind not in ('task','snapshot')))
    or (p_operation<>'register' and p_kind is not null) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  select * into principal from source_ingest_d1b_fixture_v1.service_principal
    where login_name=session_user::text collate "C" for share;
  if not found or principal.enabled is distinct from true then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  select * into permission from source_ingest_d1b_fixture_v1.workspace_service_grant
    where workspace_id=p_workspace and service_id=principal.service_id for share;
  if not found or permission.enabled is distinct from true then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  if (p_operation='initialize' and permission.allow_initialize is distinct from true)
    or (p_operation='register' and (permission.allow_register is distinct from true
      or not (p_kind=any(permission.allowed_kinds))))
    or (p_operation='receipt_read' and (permission.allow_receipt_read is distinct from true
      or cardinality(permission.receipt_producer_ids)=0)) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  return jsonb_build_object(
    'workspaceId',p_workspace,'serviceId',principal.service_id,
    'principalRevision',principal.revision,'grantRevision',permission.revision,
    'operation',p_operation,'kind',p_kind,
    'allowedBusinessProducerServiceIds',permission.business_producer_ids,
    'allowedReceiptProducerServiceIds',permission.receipt_producer_ids);
exception
  when insufficient_privilege then raise exception 'FORBIDDEN' using errcode='42501';
  when query_canceled or lock_not_available or deadlock_detected then
    raise exception 'UNAVAILABLE' using errcode='P0001';
  when others then raise exception 'UNAVAILABLE' using errcode='P0001';
end $body$;

revoke all on all functions in schema source_ingest_d1b_fixture_v1 from public,novel_d1b_mutator,novel_d1b_reader,novel_d1b_inspector,novel_d1b_locker;
grant execute on function source_ingest_d1b_fixture_v1.valid_id(text) to novel_d1b_locker;
grant execute on function source_ingest_d1b_fixture_v1.lock_authorization(text,text,text) to novel_d1b_mutator,novel_d1b_reader;
-- Ownership transfer by the trusted isolated DDL administrator, not a runtime role.
grant create on schema source_ingest_d1b_fixture_v1 to novel_d1b_locker;
reset role;
alter function source_ingest_d1b_fixture_v1.lock_authorization(text,text,text) owner to novel_d1b_locker;
set local role novel_d1b_owner;
revoke create on schema source_ingest_d1b_fixture_v1 from novel_d1b_locker;
reset role;
-- No writer/read receipt functions, permission-management functions, fixture loader,
-- runtime role membership, logins, seeds, canonical encoder or application assembly.
-- All table writes remain closed; never disable the guards to run this as an ingest API.
commit;
