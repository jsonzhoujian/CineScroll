-- DRAFT ONLY. Not in a migration directory, never loaded/executed by the app.
-- PG16 fresh isolated database + trusted migration administrator, separately approved.
-- Strict creation: existing objects cause failure, no overwrite/repair.
-- No login provisioning, no business data, no writer, no production readiness.
begin;
create role novel_source_draft_owner nologin nosuperuser nocreatedb nocreaterole nobypassrls noreplication;
create role novel_source_inspector nologin nosuperuser nocreatedb nocreaterole nobypassrls noreplication;
create schema evidence_source_draft authorization novel_source_draft_owner;
revoke all on schema evidence_source_draft from public;
grant usage on schema evidence_source_draft to novel_source_inspector;
set local role novel_source_draft_owner;

create function evidence_source_draft.valid_id(text) returns boolean language sql immutable set search_path=pg_catalog as $body$select ($1 is not null and length($1) between 1 and 256 and $1=btrim($1,chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279)) and $1 !~ E'[\r\n*?]' and strpos($1,'://')=0)$body$;
create function evidence_source_draft.valid_collection(text,text,text,text,jsonb,jsonb,bigint,bigint,integer,integer,integer,text,text) returns boolean language sql immutable set search_path=pg_catalog as $body$select (evidence_source_draft.valid_id($1) and evidence_source_draft.valid_id($2) and evidence_source_draft.valid_id($3) and evidence_source_draft.valid_id($4) and jsonb_typeof($5)='object' and ($5->>'workspaceId')=$1 and ($5->>'unitId')=$3 and jsonb_typeof($6)='object' and $7 between 1 and 9007199254740991 and $8 between 1 and 9007199254740991 and $9 between 0 and 256 and $10 between 0 and 64 and $11 between 0 and 256 and ($12 is null or evidence_source_draft.valid_id($12)) and ($13 is null or evidence_source_draft.valid_id($13)) and octet_length($5::text)<=2097152 and octet_length($6::text)<=2097152) is true$body$;
create function evidence_source_draft.valid_version(text,text,text,bigint,text,bigint,jsonb,bytea,text,text,text) returns boolean language sql immutable set search_path=pg_catalog as $body$select ($1 in ('task','snapshot','execution','fence','result','validation','pricing','closure') and evidence_source_draft.valid_id($2) and evidence_source_draft.valid_id($3) and $4 between 1 and 9007199254740991 and (($4=1 and $5 is null) or ($4>1 and evidence_source_draft.valid_id($5) and $5<>$3)) and $6 between 1 and 9007199254740991 and jsonb_typeof($7)='object' and octet_length($7::text)<=2097152 and octet_length($8) between 1 and 2097152 and $9 ~ '^[a-f0-9]{64}$' and evidence_source_draft.valid_id($10) and evidence_source_draft.valid_id($11)) is true$body$;
create function evidence_source_draft.valid_seal(text,bigint,text,jsonb,bytea,text,integer,text,text) returns boolean language sql immutable set search_path=pg_catalog as $body$select (evidence_source_draft.valid_id($1) and $2 between 1 and 9007199254740991 and $3 in ('observation','final') and jsonb_typeof($4)='object' and octet_length($4::text)<=2097152 and octet_length($5) between 1 and 1048576 and $6 ~ '^[a-f0-9]{64}$' and $7 between 1 and 256 and evidence_source_draft.valid_id($8) and evidence_source_draft.valid_id($9)) is true$body$;
create function evidence_source_draft.valid_member(integer,text,bigint) returns boolean language sql immutable set search_path=pg_catalog as $body$select ($1 between 0 and 255 and $2 ~ '^[a-f0-9]{64}$' and $3 between 1 and 9007199254740991) is true$body$;
create function evidence_source_draft.deny_source_write() returns trigger language plpgsql set search_path=pg_catalog as $body$begin raise exception 'source draft closed' using errcode='P0001'; end$body$;

create table evidence_source_draft.collection (
  workspace_id text collate "C" not null, collection_id text collate "C" not null,
  unit_id text collate "C" not null, execution_id text collate "C" not null,
  binding jsonb not null, snapshot jsonb not null, generation bigint not null, head_revision bigint not null,
  member_count integer not null, history_count integer not null, unresolved_count integer not null,
  current_seal_id text collate "C", final_seal_id text collate "C",
  constraint collection_pkey primary key(workspace_id,collection_id),
  constraint collection_unit unique(workspace_id,unit_id),
  constraint collection_shape check(evidence_source_draft.valid_collection(workspace_id,collection_id,unit_id,execution_id,binding,snapshot,generation,head_revision,member_count,history_count,unresolved_count,current_seal_id,final_seal_id))
);
create table evidence_source_draft.version (
  workspace_id text collate "C" not null, collection_id text collate "C" not null,
  kind text collate "C" not null, record_id text collate "C" not null, version text collate "C" not null,
  revision bigint not null, introduced_generation bigint not null,
  payload jsonb not null, canonical bytea not null, fingerprint text collate "C" not null,
  producer_service_id text collate "C" not null, rule_version text collate "C" not null,
  recorded_at timestamptz not null, predecessor_version text collate "C",
  constraint version_pkey primary key(workspace_id,collection_id,kind,record_id,version),
  constraint version_revision unique(workspace_id,collection_id,kind,record_id,revision),
  constraint version_collection foreign key(workspace_id,collection_id) references evidence_source_draft.collection(workspace_id,collection_id),
  constraint version_previous foreign key(workspace_id,collection_id,kind,record_id,predecessor_version) references evidence_source_draft.version(workspace_id,collection_id,kind,record_id,version),
  constraint version_shape check(evidence_source_draft.valid_version(kind,record_id,version,revision,predecessor_version,introduced_generation,payload,canonical,fingerprint,producer_service_id,rule_version))
);
create table evidence_source_draft.seal (
  workspace_id text collate "C" not null, collection_id text collate "C" not null, seal_id text collate "C" not null,
  generation bigint not null, kind text collate "C" not null, manifest jsonb not null, canonical bytea not null,
  fingerprint text collate "C" not null, member_count integer not null,
  producer_service_id text collate "C" not null, rule_version text collate "C" not null, sealed_at timestamptz not null,
  constraint seal_pkey primary key(workspace_id,seal_id),
  constraint seal_generation unique(workspace_id,collection_id,generation),
  constraint seal_identity unique(workspace_id,collection_id,seal_id,generation),
  constraint seal_collection_identity unique(workspace_id,collection_id,seal_id),
  constraint seal_collection foreign key(workspace_id,collection_id) references evidence_source_draft.collection(workspace_id,collection_id),
  constraint seal_shape check(evidence_source_draft.valid_seal(seal_id,generation,kind,manifest,canonical,fingerprint,member_count,producer_service_id,rule_version))
);
alter table evidence_source_draft.collection add constraint collection_current foreign key(workspace_id,collection_id,current_seal_id,generation) references evidence_source_draft.seal(workspace_id,collection_id,seal_id,generation);
alter table evidence_source_draft.collection add constraint collection_final foreign key(workspace_id,collection_id,final_seal_id,generation) references evidence_source_draft.seal(workspace_id,collection_id,seal_id,generation);
create table evidence_source_draft.seal_member (
  workspace_id text collate "C" not null, collection_id text collate "C" not null, seal_id text collate "C" not null,
  ordinal integer not null, kind text collate "C" not null, record_id text collate "C" not null, version text collate "C" not null,
  fingerprint text collate "C" not null, introduced_generation bigint not null,
  constraint seal_member_pkey primary key(workspace_id,seal_id,ordinal),
  constraint seal_member_version unique(workspace_id,seal_id,collection_id,kind,record_id,version),
  constraint seal_member_seal foreign key(workspace_id,collection_id,seal_id) references evidence_source_draft.seal(workspace_id,collection_id,seal_id),
  constraint seal_member_source foreign key(workspace_id,collection_id,kind,record_id,version) references evidence_source_draft.version(workspace_id,collection_id,kind,record_id,version),
  constraint seal_member_shape check(evidence_source_draft.valid_member(ordinal,fingerprint,introduced_generation))
);
create index version_enumeration on evidence_source_draft.version(workspace_id,collection_id,introduced_generation,kind,record_id,revision);
create index version_previous_lookup on evidence_source_draft.version(workspace_id,collection_id,kind,record_id,predecessor_version);
create index seal_member_source_lookup on evidence_source_draft.seal_member(workspace_id,collection_id,kind,record_id,version);
create index collection_current_lookup on evidence_source_draft.collection(workspace_id,collection_id,current_seal_id,generation);
create index collection_final_lookup on evidence_source_draft.collection(workspace_id,collection_id,final_seal_id,generation);

-- No policies: default-deny even for owner under FORCE RLS. All writes closed.
do $block$ declare name text; begin
  foreach name in array array['collection','version','seal','seal_member'] loop
    execute format('alter table evidence_source_draft.%I enable row level security',name);
    execute format('alter table evidence_source_draft.%I force row level security',name);
    execute format('create trigger source_closed_row before insert or update or delete on evidence_source_draft.%I for each row execute function evidence_source_draft.deny_source_write()',name);
    execute format('create trigger source_closed_truncate before truncate on evidence_source_draft.%I for each statement execute function evidence_source_draft.deny_source_write()',name);
    execute format('alter table evidence_source_draft.%I enable always trigger source_closed_row',name);
    execute format('alter table evidence_source_draft.%I enable always trigger source_closed_truncate',name);
  end loop;
end $block$;
revoke all on all tables in schema evidence_source_draft from public,novel_source_inspector;
revoke all on all functions in schema evidence_source_draft from public,novel_source_inspector;
-- Runtime login/grant/SET ROLE is deliberately not provisioned by this draft.
-- No SECURITY DEFINER function or source writer is installed.
commit;
