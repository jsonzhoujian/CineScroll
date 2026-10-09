-- DRAFT: PG16 UTF8 only. Do not execute before separate isolated-test approval.
-- Pure calculations only; no runtime GRANT, role creation, table dependency or writer.
begin;
do $guard$ begin
  if current_setting('server_version_num')::int / 10000 <> 16
     or current_setting('server_encoding') <> 'UTF8' then
    raise exception 'D1B_CODEC_PROFILE_UNSUPPORTED';
  end if;
end $guard$;
create schema source_ingest_d1b_codec_v1;
revoke all on schema source_ingest_d1b_codec_v1 from public;
-- Owner is the controlled DDL administrator; not a production callable owner.

create function source_ingest_d1b_codec_v1.profiles() returns jsonb
language sql immutable security invoker set search_path=pg_catalog,pg_temp
as $profiles$ select '{
  "identity": {
    "executionReference": {
      "id": "string",
      "version": "string"
    },
    "ingestId": "string",
    "operation": "string",
    "protocolVersion": "string",
    "serviceId": "string",
    "snapshotReference": {
      "id": "string",
      "version": "string"
    },
    "taskReference": {
      "id": "string",
      "version": "string"
    },
    "unitId": "string",
    "workspaceId": "string"
  },
  "taskPayload": {
    "binding": {
      "chapterId": "string",
      "projectId": "string",
      "sourceVersionId": "string",
      "taskId": "string",
      "unitId": "string",
      "upstreamVersionIds": {
        "array": "string"
      },
      "workspaceId": "string"
    },
    "scopeKeys": {
      "array": "string"
    },
    "taskRevision": "number"
  },
  "snapshotPayload": {
    "binding": {
      "chapterId": "string",
      "projectId": "string",
      "sourceVersionId": "string",
      "taskId": "string",
      "unitId": "string",
      "upstreamVersionIds": {
        "array": "string"
      },
      "workspaceId": "string"
    },
    "priceVersion": "string",
    "quoteId": "string",
    "reserved": "number",
    "responsibility": "string"
  },
  "receipt": {
    "collectionId": "string",
    "commandFingerprint": "string",
    "committedAt": "string",
    "generationAtCommit": "number",
    "headRevisionAtCommit": "number",
    "ingestId": "string",
    "operation": "string",
    "producerServiceId": "string",
    "protocolVersion": "string",
    "sourceReferences": {
      "array": {
        "id": "string",
        "kind": "string",
        "payloadFingerprint": "string",
        "version": "string"
      }
    },
    "status": "string",
    "unitId": "string",
    "workspaceId": "string"
  },
  "collectionBase": {
    "binding": {
      "chapterId": "string",
      "projectId": "string",
      "sourceVersionId": "string",
      "taskId": "string",
      "unitId": "string",
      "upstreamVersionIds": {
        "array": "string"
      },
      "workspaceId": "string"
    },
    "collection_id": "string",
    "current_seal_id": "null",
    "execution_fingerprint": "string",
    "execution_id": "string",
    "execution_version": "string",
    "final_seal_id": "null",
    "generation": "number",
    "head_revision": "number",
    "history_count": "number",
    "initial_snapshot_kind": "string",
    "initial_task_kind": "string",
    "member_count": "number",
    "quote_fingerprint": "string",
    "quote_record_id": "string",
    "quote_record_version": "string",
    "snapshot_fingerprint": "string",
    "snapshot_id": "string",
    "snapshot_version": "string",
    "task_fingerprint": "string",
    "task_id": "string",
    "task_version": "string",
    "unit_id": "string",
    "unresolved_count": "number",
    "workspace_id": "string"
  },
  "taskSource": {
    "canonical": "string",
    "collection_id": "string",
    "id": "string",
    "introduced_generation": "number",
    "kind": "string",
    "payload": {
      "binding": {
        "chapterId": "string",
        "projectId": "string",
        "sourceVersionId": "string",
        "taskId": "string",
        "unitId": "string",
        "upstreamVersionIds": {
          "array": "string"
        },
        "workspaceId": "string"
      },
      "scopeKeys": {
        "array": "string"
      },
      "taskRevision": "number"
    },
    "payload_fingerprint": "string",
    "predecessor_version": "null",
    "producer_service_id": "string",
    "recorded_at": "string",
    "revision": "number",
    "rule_version": "string",
    "version": "string",
    "workspace_id": "string"
  },
  "snapshotSource": {
    "canonical": "string",
    "collection_id": "string",
    "id": "string",
    "introduced_generation": "number",
    "kind": "string",
    "payload": {
      "binding": {
        "chapterId": "string",
        "projectId": "string",
        "sourceVersionId": "string",
        "taskId": "string",
        "unitId": "string",
        "upstreamVersionIds": {
          "array": "string"
        },
        "workspaceId": "string"
      },
      "priceVersion": "string",
      "quoteId": "string",
      "reserved": "number",
      "responsibility": "string"
    },
    "payload_fingerprint": "string",
    "predecessor_version": "null",
    "producer_service_id": "string",
    "recorded_at": "string",
    "revision": "number",
    "rule_version": "string",
    "version": "string",
    "workspace_id": "string"
  },
  "taskLink": {
    "business_fingerprint": "string",
    "collection_id": "string",
    "id": "string",
    "kind": "string",
    "payload_fingerprint": "string",
    "projection_rule_version": "string",
    "verified_at": "string",
    "verified_by_service_id": "string",
    "version": "string",
    "workspace_id": "string"
  },
  "snapshotLink": {
    "business_fingerprint": "string",
    "collection_id": "string",
    "id": "string",
    "kind": "string",
    "payload_fingerprint": "string",
    "projection_rule_version": "string",
    "quote_fingerprint": "string",
    "quote_record_id": "string",
    "quote_record_version": "string",
    "verified_at": "string",
    "verified_by_service_id": "string",
    "version": "string",
    "workspace_id": "string"
  },
  "receiptBase": {
    "collection_id": "string",
    "command": {
      "executionReference": {
        "id": "string",
        "version": "string"
      },
      "ingestId": "string",
      "operation": "string",
      "protocolVersion": "string",
      "serviceId": "string",
      "snapshotReference": {
        "id": "string",
        "version": "string"
      },
      "taskReference": {
        "id": "string",
        "version": "string"
      },
      "unitId": "string",
      "workspaceId": "string"
    },
    "command_canonical": "string",
    "command_fingerprint": "string",
    "committed_at": "string",
    "generation_at_commit": "number",
    "head_revision_at_commit": "number",
    "ingest_id": "string",
    "operation": "string",
    "producer_service_id": "string",
    "protocol_version": "string",
    "receipt": {
      "collectionId": "string",
      "commandFingerprint": "string",
      "committedAt": "string",
      "generationAtCommit": "number",
      "headRevisionAtCommit": "number",
      "ingestId": "string",
      "operation": "string",
      "producerServiceId": "string",
      "protocolVersion": "string",
      "sourceReferences": {
        "array": {
          "id": "string",
          "kind": "string",
          "payloadFingerprint": "string",
          "version": "string"
        }
      },
      "status": "string",
      "unitId": "string",
      "workspaceId": "string"
    },
    "receipt_canonical": "string",
    "receipt_fingerprint": "string",
    "status": "string",
    "unit_id": "string",
    "workspace_id": "string"
  },
  "member0": {
    "collection_id": "string",
    "id": "string",
    "ingest_id": "string",
    "kind": "string",
    "ordinal": "number",
    "payload_fingerprint": "string",
    "version": "string",
    "workspace_id": "string"
  },
  "member1": {
    "collection_id": "string",
    "id": "string",
    "ingest_id": "string",
    "kind": "string",
    "ordinal": "number",
    "payload_fingerprint": "string",
    "version": "string",
    "workspace_id": "string"
  },
  "duplicateIdentity": {
    "executionReference": {
      "id": "string",
      "version": "string"
    },
    "ingestId": "string",
    "operation": "string",
    "protocolVersion": "string",
    "serviceId": "string",
    "snapshotReference": {
      "id": "string",
      "version": "string"
    },
    "taskReference": {
      "id": "string",
      "version": "string"
    },
    "unitId": "string",
    "workspaceId": "string"
  },
  "duplicateReceipt": {
    "collectionId": "string",
    "commandFingerprint": "string",
    "committedAt": "string",
    "generationAtCommit": "number",
    "headRevisionAtCommit": "number",
    "ingestId": "string",
    "operation": "string",
    "producerServiceId": "string",
    "protocolVersion": "string",
    "sourceReferences": {
      "array": {
        "id": "string",
        "kind": "string",
        "payloadFingerprint": "string",
        "version": "string"
      }
    },
    "status": "string",
    "unitId": "string",
    "workspaceId": "string"
  },
  "duplicateBase": {
    "collection_id": "string",
    "command": {
      "executionReference": {
        "id": "string",
        "version": "string"
      },
      "ingestId": "string",
      "operation": "string",
      "protocolVersion": "string",
      "serviceId": "string",
      "snapshotReference": {
        "id": "string",
        "version": "string"
      },
      "taskReference": {
        "id": "string",
        "version": "string"
      },
      "unitId": "string",
      "workspaceId": "string"
    },
    "command_canonical": "string",
    "command_fingerprint": "string",
    "committed_at": "string",
    "generation_at_commit": "number",
    "head_revision_at_commit": "number",
    "ingest_id": "string",
    "operation": "string",
    "producer_service_id": "string",
    "protocol_version": "string",
    "receipt": {
      "collectionId": "string",
      "commandFingerprint": "string",
      "committedAt": "string",
      "generationAtCommit": "number",
      "headRevisionAtCommit": "number",
      "ingestId": "string",
      "operation": "string",
      "producerServiceId": "string",
      "protocolVersion": "string",
      "sourceReferences": {
        "array": {
          "id": "string",
          "kind": "string",
          "payloadFingerprint": "string",
          "version": "string"
        }
      },
      "status": "string",
      "unitId": "string",
      "workspaceId": "string"
    },
    "receipt_canonical": "string",
    "receipt_fingerprint": "string",
    "status": "string",
    "unit_id": "string",
    "workspace_id": "string"
  },
  "duplicateMember0": {
    "collection_id": "string",
    "id": "string",
    "ingest_id": "string",
    "kind": "string",
    "ordinal": "number",
    "payload_fingerprint": "string",
    "version": "string",
    "workspace_id": "string"
  },
  "duplicateMember1": {
    "collection_id": "string",
    "id": "string",
    "ingest_id": "string",
    "kind": "string",
    "ordinal": "number",
    "payload_fingerprint": "string",
    "version": "string",
    "workspace_id": "string"
  },
  "taskBusiness": {
    "version": "string",
    "binding": {
      "workspaceId": "string",
      "taskId": "string",
      "unitId": "string",
      "projectId": "string",
      "chapterId": "string",
      "sourceVersionId": "string",
      "upstreamVersionIds": {
        "array": "string"
      }
    },
    "producerServiceId": "string",
    "recordedAt": "string",
    "id": "string",
    "revision": "number",
    "predecessorVersion": "null",
    "scopeKeys": {
      "array": "string"
    },
    "snapshotReference": {
      "id": "string",
      "version": "string"
    },
    "executionReference": {
      "id": "string",
      "version": "string"
    }
  },
  "snapshotBusiness": {
    "version": "string",
    "binding": {
      "workspaceId": "string",
      "taskId": "string",
      "unitId": "string",
      "projectId": "string",
      "chapterId": "string",
      "sourceVersionId": "string",
      "upstreamVersionIds": {
        "array": "string"
      }
    },
    "producerServiceId": "string",
    "recordedAt": "string",
    "id": "string",
    "responsibility": "string",
    "quoteId": "string",
    "priceVersion": "string",
    "reserved": "number",
    "quoteReference": {
      "id": "string",
      "version": "string"
    },
    "taskAnchorReference": {
      "id": "string",
      "version": "string"
    },
    "executionReference": {
      "id": "string",
      "version": "string"
    }
  },
  "executionBusiness": {
    "version": "string",
    "binding": {
      "workspaceId": "string",
      "taskId": "string",
      "unitId": "string",
      "projectId": "string",
      "chapterId": "string",
      "sourceVersionId": "string",
      "upstreamVersionIds": {
        "array": "string"
      }
    },
    "producerServiceId": "string",
    "recordedAt": "string",
    "id": "string",
    "taskAnchorReference": {
      "id": "string",
      "version": "string"
    },
    "snapshotReference": {
      "id": "string",
      "version": "string"
    }
  },
  "quoteBusiness": {
    "version": "string",
    "binding": {
      "workspaceId": "string",
      "taskId": "string",
      "unitId": "string",
      "projectId": "string",
      "chapterId": "string",
      "sourceVersionId": "string",
      "upstreamVersionIds": {
        "array": "string"
      }
    },
    "producerServiceId": "string",
    "recordedAt": "string",
    "id": "string",
    "responsibility": "string",
    "quoteId": "string",
    "priceVersion": "string",
    "reserved": "number",
    "pricingRuleVersion": "string",
    "taskAnchorReference": {
      "id": "string",
      "version": "string"
    },
    "executionReference": {
      "id": "string",
      "version": "string"
    }
  }
}'::jsonb $profiles$;

create function source_ingest_d1b_codec_v1.quote_string(value text) returns text
language plpgsql immutable security invoker set search_path=pg_catalog,pg_temp as $body$
declare result text; escaped text; n int;
begin
  if value is null then raise exception 'INVALID_CODEC_INPUT'; end if;
  -- A bounded number of native scans, not quadratic per-character concatenation.
  -- Escape original slashes first; later inserted escapes must not be doubled.
  result:=replace(replace(value,chr(92),chr(92)||chr(92)),chr(34),chr(92)||chr(34));
  for n in 1..31 loop
    if strpos(result,chr(n))>0 then
      escaped:=chr(92)||case n when 8 then 'b' when 9 then 't' when 10 then 'n'
        when 12 then 'f' when 13 then 'r' else 'u'||lpad(to_hex(n),4,'0') end;
      result:=replace(result,chr(n),escaped);
    end if;
  end loop;
  return chr(34)||result||chr(34);
end $body$;

create function source_ingest_d1b_codec_v1.valid_identifier(value text) returns boolean
language plpgsql immutable security invoker set search_path=pg_catalog,pg_temp as $body$
declare units int := 0; ch text; i int;
begin
  if value is null or value='' or value<>btrim(value,
    chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||
    chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||
    chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||
    chr(8287)||chr(12288)||chr(65279))
    or strpos(value,chr(10))>0 or strpos(value,chr(13))>0
    or strpos(value,'*')>0 or strpos(value,'?')>0 or strpos(value,'://')>0 then return false; end if;
  for i in 1..char_length(value) loop
    ch:=substr(value,i,1); units:=units+case when ascii(ch)>65535 then 2 else 1 end;
    if units>256 then return false; end if;
  end loop;
  return true;
end $body$;

create function source_ingest_d1b_codec_v1.utc_millis(value timestamptz) returns text
language plpgsql stable security invoker set search_path=pg_catalog,pg_temp as $body$
begin
  if value is null or not isfinite(value) or
    value< timestamptz '0001-01-01T00:00:00Z' or value>=timestamptz '10000-01-01T00:00:00Z'
    or date_trunc('milliseconds',value)<>value then raise exception 'INVALID_CODEC_INPUT'; end if;
  return to_char(value at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
end $body$;

-- Private recursive worker. shape is never caller authority at the sealed entry.
-- Nodes count values (not field-name strings); root depth=0, max depth=8.
create function source_ingest_d1b_codec_v1.walk(value jsonb, shape jsonb, field text, depth int, remaining int)
returns table(encoded text, nodes int)
language plpgsql stable security invoker set search_path=pg_catalog,pg_temp as $body$
declare k text; child jsonb; piece record; count_keys int; scalar text; number_value numeric; first_item boolean := true;
begin
  if value is null or shape is null or depth>8 or remaining<1 then raise exception 'INVALID_CODEC_INPUT'; end if;
  nodes:=1; encoded:='';
  if jsonb_typeof(shape)='object' and shape ? 'array' then
    if jsonb_typeof(value)<>'array' or jsonb_array_length(value)>100 then raise exception 'INVALID_CODEC_INPUT'; end if;
    if field='sourceReferences' and jsonb_array_length(value)<>2 then raise exception 'INVALID_CODEC_INPUT'; end if;
    if field='scopeKeys' and jsonb_array_length(value)<>1 then raise exception 'INVALID_CODEC_INPUT'; end if;
    if field in ('scopeKeys','upstreamVersionIds') and
      (select count(distinct v) from jsonb_array_elements(value) as a(v))<>jsonb_array_length(value) then
      raise exception 'INVALID_CODEC_INPUT';
    end if;
    encoded:='[';
    for child in select a.v from jsonb_array_elements(value) with ordinality as a(v,n) order by a.n loop
      select * into piece from source_ingest_d1b_codec_v1.walk(child,shape->'array',field,depth+1,remaining-nodes);
      if not first_item then encoded:=encoded||','; end if; first_item:=false;
      encoded:=encoded||piece.encoded; nodes:=nodes+piece.nodes;
      if octet_length(encoded)>16777216 then raise exception 'INVALID_CODEC_INPUT'; end if;
    end loop;
    encoded:=encoded||']';
  elsif jsonb_typeof(shape)='object' then
    if jsonb_typeof(value)<>'object' then raise exception 'INVALID_CODEC_INPUT'; end if;
    select count(*) into count_keys from jsonb_object_keys(value);
    if count_keys<>(select count(*) from jsonb_object_keys(shape)) then raise exception 'INVALID_CODEC_INPUT'; end if;
    encoded:='{';
    for k in select key from jsonb_object_keys(shape) as x(key) order by key collate "C" loop
      if not value ? k then raise exception 'INVALID_CODEC_INPUT'; end if;
      select * into piece from source_ingest_d1b_codec_v1.walk(value->k,shape->k,k,depth+1,remaining-nodes);
      if not first_item then encoded:=encoded||','; end if; first_item:=false;
      encoded:=encoded||source_ingest_d1b_codec_v1.quote_string(k)||':'||piece.encoded; nodes:=nodes+piece.nodes;
      if octet_length(encoded)>16777216 then raise exception 'INVALID_CODEC_INPUT'; end if;
    end loop;
    encoded:=encoded||'}';
  else
    if jsonb_typeof(value)<>(shape #>> '{}') then raise exception 'INVALID_CODEC_INPUT'; end if;
    scalar:=value #>> '{}';
    case shape #>> '{}'
      when 'null' then encoded:='null';
      when 'boolean' then encoded:=scalar;
      when 'number' then
        number_value:=scalar::numeric;
        if number_value<>trunc(number_value) or abs(number_value)>9007199254740991 then raise exception 'INVALID_CODEC_INPUT'; end if;
        if field in ('taskRevision','revision','generation','head_revision','member_count','generationAtCommit','headRevisionAtCommit','expectedHeadRevision','generation_at_commit','head_revision_at_commit','introduced_generation')
          and number_value<1 then raise exception 'INVALID_CODEC_INPUT'; end if;
        if field in ('reserved','ordinal','history_count','unresolved_count') and number_value<0 then raise exception 'INVALID_CODEC_INPUT'; end if;
        encoded:=number_value::bigint::text;
      when 'string' then
        if field in ('recordedAt','recorded_at','verified_at','committedAt','committed_at') then
          if scalar !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
            or source_ingest_d1b_codec_v1.utc_millis(scalar::timestamptz)<>scalar then raise exception 'INVALID_CODEC_INPUT'; end if;
        elsif field in ('canonical','command_canonical','receipt_canonical') then
          if scalar !~ '^([0-9a-f]{2})+$' then raise exception 'INVALID_CODEC_INPUT'; end if;
        elsif field ~ '(Fingerprint|fingerprint)$' then
          if scalar !~ '^[0-9a-f]{64}$' then raise exception 'INVALID_CODEC_INPUT'; end if;
        elsif not source_ingest_d1b_codec_v1.valid_identifier(scalar) then raise exception 'INVALID_CODEC_INPUT';
        end if;
        if field in ('protocolVersion','protocol_version') and scalar<>'source-ingest-v1' then raise exception 'INVALID_CODEC_INPUT'; end if;
        if field='operation' and scalar not in ('initialize','register') then raise exception 'INVALID_CODEC_INPUT'; end if;
        if field='kind' and scalar not in ('task','snapshot') then raise exception 'INVALID_CODEC_INPUT'; end if;
        if field='responsibility' and scalar not in ('platform','byok') then raise exception 'INVALID_CODEC_INPUT'; end if;
        if field='status' and scalar not in ('initialized','already_registered') then raise exception 'INVALID_CODEC_INPUT'; end if;
        if field='initial_task_kind' and scalar<>'task' then raise exception 'INVALID_CODEC_INPUT'; end if;
        if field='initial_snapshot_kind' and scalar<>'snapshot' then raise exception 'INVALID_CODEC_INPUT'; end if;
        encoded:=source_ingest_d1b_codec_v1.quote_string(scalar);
      else raise exception 'INVALID_CODEC_INPUT';
    end case;
  end if;
  if octet_length(encoded)>16777216 then raise exception 'INVALID_CODEC_INPUT'; end if;
  return next;
exception when invalid_datetime_format or datetime_field_overflow or invalid_text_representation or numeric_value_out_of_range then
  raise exception 'INVALID_CODEC_INPUT';
end $body$;

create function source_ingest_d1b_codec_v1.encode_document(profile text, value jsonb) returns bytea
language plpgsql stable security invoker set search_path=pg_catalog,pg_temp as $body$
declare shape jsonb; piece record;
begin
  -- jsonb::text is only an input-work cap, NEVER canonical output or hash input.
  if value is null or octet_length(convert_to(value::text,'UTF8'))>2097152 then raise exception 'INVALID_CODEC_INPUT'; end if;
  shape:=source_ingest_d1b_codec_v1.profiles()->profile;
  if profile='registerIdentity' then
    shape:='{"protocolVersion":"string","workspaceId":"string","unitId":"string","ingestId":"string","expectedHeadRevision":"number","businessReference":{"kind":"string","id":"string","version":"string"},"serviceId":"string","operation":"string"}'::jsonb;
  end if;
  if shape is null then raise exception 'INVALID_CODEC_INPUT'; end if;
  select * into piece from source_ingest_d1b_codec_v1.walk(value,shape,'',0,50000);
  if profile in ('identity','duplicateIdentity') and value->>'operation'<>'initialize' then raise exception 'INVALID_CODEC_INPUT'; end if;
  if profile='registerIdentity' and value->>'operation'<>'register' then raise exception 'INVALID_CODEC_INPUT'; end if;
  if profile in ('receipt','duplicateReceipt') then
    if value->>'operation'<>'initialize' or (value->>'generationAtCommit')::numeric<>1
      or value#>>'{sourceReferences,0,kind}'<>'task' or value#>>'{sourceReferences,1,kind}'<>'snapshot' then raise exception 'INVALID_CODEC_INPUT'; end if;
  end if;
  return convert_to(piece.encoded,'UTF8');
end $body$;

create function source_ingest_d1b_codec_v1.project_payload(kind text, document jsonb, quote_document jsonb, rule_version text) returns jsonb
language plpgsql stable security invoker set search_path=pg_catalog,pg_temp as $body$
declare payload jsonb;
begin
  if kind not in ('task','snapshot') or kind is null or not source_ingest_d1b_codec_v1.valid_identifier(rule_version) then raise exception 'INVALID_CODEC_INPUT'; end if;
  perform source_ingest_d1b_codec_v1.encode_document(kind||'Business',document);
  perform source_ingest_d1b_codec_v1.encode_document('quoteBusiness',quote_document);
  if rule_version is distinct from quote_document->>'pricingRuleVersion'
    or document->'binding' is distinct from quote_document->'binding' then raise exception 'INVALID_CODEC_INPUT'; end if;
  if kind='task' then
    if (document->>'revision')::numeric<>1 or document->'predecessorVersion'<>'null'::jsonb
      or document->'scopeKeys'<>jsonb_build_array(document#>>'{binding,unitId}') then raise exception 'INVALID_CODEC_INPUT'; end if;
    payload:=jsonb_build_object('binding',document->'binding','taskRevision',document->'revision','scopeKeys',document->'scopeKeys');
  else
    if document->>'responsibility' is distinct from quote_document->>'responsibility'
      or document->>'quoteId' is distinct from quote_document->>'quoteId'
      or document->>'priceVersion' is distinct from quote_document->>'priceVersion'
      or document->'reserved' is distinct from quote_document->'reserved'
      or document#>>'{quoteReference,id}' is distinct from quote_document->>'id'
      or document#>>'{quoteReference,version}' is distinct from quote_document->>'version'
      or (document->>'responsibility'='byok' and (document->>'reserved')::numeric<>0)
      or (document->>'responsibility'='platform' and (document->>'reserved')::numeric<=0) then raise exception 'INVALID_CODEC_INPUT'; end if;
    payload:=jsonb_build_object('binding',document->'binding','responsibility',document->'responsibility','quoteId',document->'quoteId',
      'priceVersion',document->'priceVersion','reserved',document->'reserved');
  end if;
  perform source_ingest_d1b_codec_v1.encode_document(kind||'Payload',payload);
  return payload;
end $body$;

create function source_ingest_d1b_codec_v1.budget_bytes(collection_base jsonb, task_source jsonb, snapshot_source jsonb,
  task_link jsonb, snapshot_link jsonb, receipt_base jsonb, member0 jsonb, member1 jsonb) returns jsonb
language plpgsql stable security invoker set search_path=pg_catalog,pg_temp as $body$
declare package_bytes bigint; receipt_bytes bigint;
begin
  package_bytes:=octet_length(source_ingest_d1b_codec_v1.encode_document('collectionBase',collection_base))::bigint
    +octet_length(source_ingest_d1b_codec_v1.encode_document('taskSource',task_source))
    +octet_length(source_ingest_d1b_codec_v1.encode_document('snapshotSource',snapshot_source))
    +octet_length(source_ingest_d1b_codec_v1.encode_document('taskLink',task_link))
    +octet_length(source_ingest_d1b_codec_v1.encode_document('snapshotLink',snapshot_link));
  receipt_bytes:=octet_length(source_ingest_d1b_codec_v1.encode_document('receiptBase',receipt_base))::bigint
    +octet_length(source_ingest_d1b_codec_v1.encode_document('member0',member0))
    +octet_length(source_ingest_d1b_codec_v1.encode_document('member1',member1));
  if package_bytes>2097152 or receipt_bytes>16384 then raise exception 'CODEC_CAPACITY'; end if;
  return jsonb_build_object('packageBytes',package_bytes,'receiptCost',receipt_bytes);
end $body$;

revoke all on all functions in schema source_ingest_d1b_codec_v1 from public;
-- No grants, no owner transfer, no ALTER DEFAULT PRIVILEGES on other schemas.
commit;
