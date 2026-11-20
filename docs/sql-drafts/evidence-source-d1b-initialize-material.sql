-- Isolated write preparation. Only the fixture administrator can invoke this helper.
begin;
do $guard$ begin
  if current_setting('server_version_num')::int/10000<>16
    or current_setting('server_encoding')<>'UTF8'
    or current_setting('listen_addresses')<>''
    or current_database() !~ '^d1b_[a-f0-9]{32}$'
    or current_setting('data_directory') !~ '^/private/tmp/source-d1b\.[A-Za-z0-9]{6}/data$'
    or to_regnamespace('source_ingest_d1b_verify_v1') is null
    then raise exception 'INITIALIZE_MATERIAL_UNSUPPORTED'; end if;
  if exists(select 1 from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a
    where d.defaclrole=(select oid from pg_roles where rolname=current_user)
      and d.defaclnamespace=0 and a.grantee not in (0,d.defaclrole))
    then raise exception 'INITIALIZE_MATERIAL_UNSUPPORTED'; end if;
end $guard$;

create schema source_ingest_d1b_initialize_material_v1;
revoke all on schema source_ingest_d1b_initialize_material_v1 from public;

-- The future writer must obtain proof from the private verifier in the same transaction.
create function source_ingest_d1b_initialize_material_v1.prepare(
  command jsonb, proof jsonb, collection_id text, committed_at timestamptz, existing_collection boolean default false
) returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,pg_temp as $body$
declare
  service_id text := proof->>'verifiedByServiceId';
  identity jsonb;
  identity_bytes bytea;
  receipt jsonb;
  receipt_bytes bytea;
  receipt_status text := case when existing_collection then 'already_registered' else 'initialized' end;
  budget jsonb;
  row_scope jsonb := jsonb_build_object('workspace_id',command->>'workspaceId','collection_id',collection_id);
  receipt_scope jsonb := row_scope || jsonb_build_object('ingest_id',command->>'ingestId');
  source_scope jsonb := row_scope || '{"revision":1,"predecessor_version":null,"introduced_generation":1}'::jsonb;
  commit_time text := source_ingest_d1b_codec_v1.utc_millis(committed_at);
  link_scope jsonb := row_scope || jsonb_build_object('projection_rule_version','source-projection-v1',
    'verified_by_service_id',service_id,'verified_at',commit_time);
  task jsonb := proof->'taskSource';
  snapshot jsonb := proof->'snapshotSource';
  execution_ref jsonb := proof->'executionReference';
  quote_ref jsonb := proof->'quoteReference';
  collection_base jsonb;
  source_rows jsonb[] := array[]::jsonb[];
  link_rows jsonb[] := array[]::jsonb[];
  member_rows jsonb[] := array[]::jsonb[];
  source_refs jsonb := '[]'::jsonb;
  receipt_base jsonb;
  source jsonb;
  source_key jsonb;
  payload_type text;
  ordinal integer;
begin
  if command ?| array['operation','serviceId'] then raise exception 'INVALID_COMMAND'; end if;
  identity := command || jsonb_build_object('operation','initialize','serviceId',service_id);
  identity_bytes := source_ingest_d1b_codec_v1.encode_document('identity',identity);
  if command->'taskReference' is distinct from jsonb_build_object('id',task->>'id','version',task->>'version')
    or command->'snapshotReference' is distinct from jsonb_build_object('id',snapshot->>'id','version',snapshot->>'version')
    or command->'executionReference' is distinct from execution_ref
    or command->>'workspaceId' is distinct from proof->'binding'->>'workspaceId'
    or command->>'unitId' is distinct from proof->'binding'->>'unitId'
    then raise exception 'INTEGRITY_CONFLICT'; end if;

  collection_base := row_scope || jsonb_build_object(
    'unit_id',command->>'unitId','task_id',task->>'id','task_version',task->>'version',
    'snapshot_id',snapshot->>'id','snapshot_version',snapshot->>'version',
    'execution_id',execution_ref->>'id','execution_version',execution_ref->>'version',
    'quote_record_id',quote_ref->>'id','quote_record_version',quote_ref->>'version',
    'task_fingerprint',task->>'businessFingerprint','snapshot_fingerprint',snapshot->>'businessFingerprint',
    'execution_fingerprint',proof->>'executionFingerprint','quote_fingerprint',proof->>'quoteFingerprint',
    'binding',proof->'binding','generation',1,'head_revision',1,'member_count',2,'history_count',0,
    'unresolved_count',0,'current_seal_id',null,'final_seal_id',null,
    'initial_task_kind','task','initial_snapshot_kind','snapshot');

  for ordinal in 0..1 loop
    source := case when ordinal=0 then task else snapshot end;
    payload_type := case when ordinal=0 then 'task' else 'snapshot' end;
    source_key := jsonb_build_object('kind',payload_type,'id',source->>'id',
      'version',source->>'version','payload_fingerprint',source->>'payloadFingerprint');
    source_rows := array_append(source_rows,source_scope || source_key || jsonb_build_object(
      'payload',source->'payload','canonical',source->>'canonicalHex','recorded_at',source->>'recordedAt',
      'producer_service_id',source->>'producerServiceId','rule_version',proof->>'ruleVersion'));
    link_rows := array_append(link_rows,link_scope || source_key || jsonb_build_object(
      'business_fingerprint',source->>'businessFingerprint'));
    member_rows := array_append(member_rows,receipt_scope || source_key || jsonb_build_object('ordinal',ordinal));
    source_refs := source_refs || jsonb_build_array((source_key-'payload_fingerprint')
      || jsonb_build_object('payloadFingerprint',source->>'payloadFingerprint'));
  end loop;
  link_rows[2] := link_rows[2] || jsonb_build_object('quote_record_id',quote_ref->>'id',
    'quote_record_version',quote_ref->>'version','quote_fingerprint',proof->>'quoteFingerprint');

  receipt := jsonb_build_object('protocolVersion','source-ingest-v1','workspaceId',command->>'workspaceId',
    'ingestId',command->>'ingestId','operation','initialize','producerServiceId',service_id,
    'commandFingerprint',encode(sha256(identity_bytes),'hex'),'collectionId',collection_id,
    'unitId',command->>'unitId','generationAtCommit',1,'headRevisionAtCommit',1,'status',receipt_status,
    'sourceReferences',source_refs,'committedAt',commit_time);
  receipt_bytes := source_ingest_d1b_codec_v1.encode_document('receipt',receipt);
  receipt_base := receipt_scope || jsonb_build_object('protocol_version','source-ingest-v1',
    'operation','initialize','producer_service_id',service_id,'command',identity,
    'command_canonical',encode(identity_bytes,'hex'),'command_fingerprint',receipt->>'commandFingerprint',
    'unit_id',command->>'unitId','generation_at_commit',1,'head_revision_at_commit',1,
    'status',receipt_status,'committed_at',commit_time,'receipt',receipt,
    'receipt_canonical',encode(receipt_bytes,'hex'),'receipt_fingerprint',encode(sha256(receipt_bytes),'hex'));

  budget := source_ingest_d1b_codec_v1.budget_bytes(collection_base,source_rows[1],source_rows[2],
    link_rows[1],link_rows[2],receipt_base,member_rows[1],member_rows[2]);
  if existing_collection then budget := budget || '{"packageBytes":0}'::jsonb; end if;
  return jsonb_build_object('collectionBase',collection_base,'taskSource',source_rows[1],
    'snapshotSource',source_rows[2],'taskLink',link_rows[1],'snapshotLink',link_rows[2],
    'receiptBase',receipt_base,'member0',member_rows[1],'member1',member_rows[2])
    || budget;
end $body$;

revoke all on function source_ingest_d1b_initialize_material_v1.prepare(jsonb,jsonb,text,timestamptz,boolean) from public;
commit;
