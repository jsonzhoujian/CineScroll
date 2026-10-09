-- DRAFT: private initialization verifier; NOT installed/executed in this task.
-- Requires both separately approved fixture and codec schemas. No runtime GRANT or writer.
begin;
do $guard$ begin
  if current_setting('server_version_num')::int/10000<>16 or current_setting('server_encoding')<>'UTF8'
    or to_regnamespace('source_ingest_d1b_fixture_v1') is null
    or to_regnamespace('source_ingest_d1b_codec_v1') is null then raise exception 'VERIFY_PROFILE_UNSUPPORTED'; end if;
  if exists(select 1 from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a
    where d.defaclrole=(select oid from pg_roles where rolname=current_user) and d.defaclnamespace=0
      and a.grantee not in (0,d.defaclrole)) then raise exception 'VERIFY_PROFILE_UNSUPPORTED'; end if;
end $guard$;
create schema source_ingest_d1b_verify_v1;
revoke all on schema source_ingest_d1b_verify_v1 from public;

-- Pure row consistency only. row_data is obtained internally by the main verifier.
create function source_ingest_d1b_verify_v1.verify_business_row(kind text,row_data jsonb) returns jsonb
language plpgsql stable security invoker set search_path=pg_catalog,pg_temp as $body$
declare doc jsonb; canonical_bytes bytea; expected jsonb; actual jsonb;
begin
  if kind is null or kind not in ('task','snapshot','execution','quote') or row_data is null then raise exception 'INTEGRITY_CONFLICT'; end if;
  doc:=row_data->'document';
  begin
    canonical_bytes:=source_ingest_d1b_codec_v1.encode_document(kind||'Business',doc);
  exception when raise_exception then raise exception 'INTEGRITY_CONFLICT'; end;
  if octet_length(canonical_bytes)>2097152 then raise exception 'CAPACITY'; end if;
  expected:=jsonb_build_object('workspace_id',doc#>>'{binding,workspaceId}','id',doc->>'id','version',doc->>'version',
    'task_id',doc#>>'{binding,taskId}','unit_id',doc#>>'{binding,unitId}','binding',doc->'binding',
    'producer_service_id',doc->>'producerServiceId','recorded_at',doc->>'recordedAt','document',doc,
    'canonical',chr(92)||'x'||encode(canonical_bytes,'hex'),'business_fingerprint',encode(sha256(canonical_bytes),'hex'));
  if kind='task' then
    expected:=expected||jsonb_build_object('revision',doc->'revision','predecessor_version',doc->'predecessorVersion',
      'scope_keys',doc->'scopeKeys','snapshot_id',doc#>>'{snapshotReference,id}','snapshot_version',doc#>>'{snapshotReference,version}',
      'execution_id',doc#>>'{executionReference,id}','execution_version',doc#>>'{executionReference,version}');
  elsif kind='execution' then
    expected:=expected||jsonb_build_object('task_anchor_version',doc#>>'{taskAnchorReference,version}',
      'snapshot_id',doc#>>'{snapshotReference,id}','snapshot_version',doc#>>'{snapshotReference,version}');
  else
    expected:=expected||jsonb_build_object('task_anchor_version',doc#>>'{taskAnchorReference,version}',
      'execution_id',doc#>>'{executionReference,id}','execution_version',doc#>>'{executionReference,version}',
      'quote_id',doc->>'quoteId','price_version',doc->>'priceVersion','responsibility',doc->>'responsibility','reserved',doc->'reserved');
    if kind='snapshot' then
      expected:=expected||jsonb_build_object('quote_record_id',doc#>>'{quoteReference,id}','quote_record_version',doc#>>'{quoteReference,version}');
    else expected:=expected||jsonb_build_object('pricing_rule_version',doc->>'pricingRuleVersion'); end if;
  end if;
  actual:=row_data||jsonb_build_object('recorded_at',source_ingest_d1b_codec_v1.utc_millis((row_data->>'recorded_at')::timestamptz));
  if actual is distinct from expected then raise exception 'INTEGRITY_CONFLICT'; end if;
  return doc;
exception when invalid_datetime_format or datetime_field_overflow or invalid_text_representation or numeric_value_out_of_range then
  raise exception 'INTEGRITY_CONFLICT';
when raise_exception then
  if sqlerrm in ('INTEGRITY_CONFLICT','CAPACITY') then raise; end if;
  raise exception 'INTEGRITY_CONFLICT';
end $body$;

create function source_ingest_d1b_verify_v1.verify_initialize_business(command jsonb,expected_service_id text,expected_rule_version text)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,pg_temp as $body$
declare locked_permission jsonb; producers text[]; workspace text;
  t source_ingest_d1b_fixture_v1.task_revision%rowtype;
  s source_ingest_d1b_fixture_v1.fixed_snapshot%rowtype;
  e source_ingest_d1b_fixture_v1.execution_identity%rowtype;
  q source_ingest_d1b_fixture_v1.fixed_quote%rowtype;
  td jsonb; sd jsonb; ed jsonb; qd jsonb; task_ref jsonb; snapshot_ref jsonb; execution_ref jsonb; quote_ref jsonb;
  task_payload jsonb; snapshot_payload jsonb; task_bytes bytea; snapshot_bytes bytea;
begin
  if command is null or jsonb_typeof(command)<>'object' or command ? 'serviceId' or command ? 'operation'
    or not source_ingest_d1b_codec_v1.valid_identifier(expected_service_id)
    or not source_ingest_d1b_codec_v1.valid_identifier(expected_rule_version) then raise exception 'INVALID_COMMAND'; end if;
  begin
    perform source_ingest_d1b_codec_v1.encode_document('identity',command||jsonb_build_object('serviceId',expected_service_id,'operation','initialize'));
  exception when raise_exception then raise exception 'INVALID_COMMAND'; end;
  workspace:=command->>'workspaceId';
  locked_permission:=source_ingest_d1b_fixture_v1.lock_authorization(workspace,'initialize',null);
  if locked_permission->>'serviceId' is distinct from expected_service_id or locked_permission->>'workspaceId' is distinct from workspace
    or locked_permission->>'operation' is distinct from 'initialize' then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  select array_agg(value) into producers from jsonb_array_elements_text(locked_permission->'allowedBusinessProducerServiceIds') a(value);
  if coalesce(cardinality(producers),0)=0 then raise exception 'FORBIDDEN' using errcode='42501'; end if;

  select a.* into t from source_ingest_d1b_fixture_v1.task_revision a where a.workspace_id=workspace
    and a.id=command#>>'{taskReference,id}' and a.version=command#>>'{taskReference,version}' and a.producer_service_id=any(producers);
  if not found then raise exception 'NOT_FOUND'; end if;
  select a.* into s from source_ingest_d1b_fixture_v1.fixed_snapshot a where a.workspace_id=workspace
    and a.id=command#>>'{snapshotReference,id}' and a.version=command#>>'{snapshotReference,version}' and a.producer_service_id=any(producers);
  if not found then raise exception 'NOT_FOUND'; end if;
  select a.* into e from source_ingest_d1b_fixture_v1.execution_identity a where a.workspace_id=workspace
    and a.id=command#>>'{executionReference,id}' and a.version=command#>>'{executionReference,version}' and a.producer_service_id=any(producers);
  if not found then raise exception 'NOT_FOUND'; end if;
  select a.* into q from source_ingest_d1b_fixture_v1.fixed_quote a where a.workspace_id=workspace
    and a.id=s.quote_record_id and a.version=s.quote_record_version and a.producer_service_id=any(producers);
  if not found then raise exception 'INTEGRITY_CONFLICT'; end if;

  -- Normalize actual bytea presentation independently of the session bytea_output.
  td:=source_ingest_d1b_verify_v1.verify_business_row('task',to_jsonb(t)||jsonb_build_object('canonical',chr(92)||'x'||encode(t.canonical,'hex')));
  sd:=source_ingest_d1b_verify_v1.verify_business_row('snapshot',to_jsonb(s)||jsonb_build_object('canonical',chr(92)||'x'||encode(s.canonical,'hex')));
  ed:=source_ingest_d1b_verify_v1.verify_business_row('execution',to_jsonb(e)||jsonb_build_object('canonical',chr(92)||'x'||encode(e.canonical,'hex')));
  qd:=source_ingest_d1b_verify_v1.verify_business_row('quote',to_jsonb(q)||jsonb_build_object('canonical',chr(92)||'x'||encode(q.canonical,'hex')));
  if octet_length(t.canonical)::bigint+octet_length(s.canonical)+octet_length(e.canonical)+octet_length(q.canonical)>16777216 then raise exception 'CAPACITY'; end if;
  task_ref:=command->'taskReference';snapshot_ref:=command->'snapshotReference';execution_ref:=command->'executionReference';
  quote_ref:=jsonb_build_object('id',q.id,'version',q.version);
  if t.revision<>1 or t.predecessor_version is not null or td->>'id' is distinct from td#>>'{binding,taskId}'
    or td#>>'{binding,workspaceId}' is distinct from workspace or td#>>'{binding,unitId}' is distinct from command->>'unitId'
    or td->'scopeKeys' is distinct from jsonb_build_array(command->>'unitId')
    or td->'binding' is distinct from sd->'binding' or td->'binding' is distinct from ed->'binding' or td->'binding' is distinct from qd->'binding'
    or td->'snapshotReference' is distinct from snapshot_ref or td->'executionReference' is distinct from execution_ref
    or sd->'taskAnchorReference' is distinct from task_ref or sd->'executionReference' is distinct from execution_ref
    or sd->'quoteReference' is distinct from quote_ref or ed->'taskAnchorReference' is distinct from task_ref
    or ed->'snapshotReference' is distinct from snapshot_ref or qd->'taskAnchorReference' is distinct from task_ref
    or qd->'executionReference' is distinct from execution_ref or qd->>'pricingRuleVersion' is distinct from expected_rule_version
    or sd->'quoteId' is distinct from qd->'quoteId' or sd->'priceVersion' is distinct from qd->'priceVersion'
    or sd->'responsibility' is distinct from qd->'responsibility' or sd->'reserved' is distinct from qd->'reserved'
    or (sd->>'responsibility'='platform' and (sd->>'reserved')::numeric<=0)
    or (sd->>'responsibility'='byok' and (sd->>'reserved')::numeric<>0) then raise exception 'INTEGRITY_CONFLICT'; end if;
  task_payload:=source_ingest_d1b_codec_v1.project_payload('task',td,qd,expected_rule_version);
  snapshot_payload:=source_ingest_d1b_codec_v1.project_payload('snapshot',sd,qd,expected_rule_version);
  task_bytes:=source_ingest_d1b_codec_v1.encode_document('taskPayload',task_payload);
  snapshot_bytes:=source_ingest_d1b_codec_v1.encode_document('snapshotPayload',snapshot_payload);
  return jsonb_build_object('verifiedByServiceId',locked_permission->>'serviceId','binding',td->'binding','ruleVersion',expected_rule_version,
    'taskSource',jsonb_build_object('id',t.id,'version',t.version,'payload',task_payload,'canonicalHex',encode(task_bytes,'hex'),
      'payloadFingerprint',encode(sha256(task_bytes),'hex'),'businessFingerprint',t.business_fingerprint,'producerServiceId',t.producer_service_id,'recordedAt',td->>'recordedAt'),
    'snapshotSource',jsonb_build_object('id',s.id,'version',s.version,'payload',snapshot_payload,'canonicalHex',encode(snapshot_bytes,'hex'),
      'payloadFingerprint',encode(sha256(snapshot_bytes),'hex'),'businessFingerprint',s.business_fingerprint,'producerServiceId',s.producer_service_id,'recordedAt',sd->>'recordedAt'),
    'executionReference',execution_ref,'executionFingerprint',e.business_fingerprint,'quoteReference',quote_ref,'quoteFingerprint',q.business_fingerprint);
exception
  when insufficient_privilege then raise exception 'FORBIDDEN' using errcode='42501';
  when raise_exception then
    if sqlerrm in ('INVALID_COMMAND','FORBIDDEN','NOT_FOUND','INTEGRITY_CONFLICT','CAPACITY','UNAVAILABLE') then raise; end if;
    raise exception 'UNAVAILABLE';
  when others then raise exception 'UNAVAILABLE';
end $body$;

revoke all on all functions in schema source_ingest_d1b_verify_v1 from public;
-- No grants to LOGIN/initializer/fixture roles, no business changes or transaction commit inside functions.
commit;
