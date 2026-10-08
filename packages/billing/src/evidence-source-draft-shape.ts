// Frozen D1a catalog expectations. Not a source authenticity or writer implementation.
const columns = (required: Record<string, string>, optional: Record<string, string> = {}) => [
  ...Object.entries(required).map(([name, type]) => ({ name, type, required: true })),
  ...Object.entries(optional).map(([name, type]) => ({ name, type, required: false })),
];
const scope = { workspace_id: "text", collection_id: "text" };
export const sourceDraftTables = [
  { name: "collection", columns: columns({ ...scope, unit_id: "text", execution_id: "text", binding: "jsonb", snapshot: "jsonb", generation: "bigint", head_revision: "bigint", member_count: "integer", history_count: "integer", unresolved_count: "integer" }, { current_seal_id: "text", final_seal_id: "text" }) },
  { name: "version", columns: columns({ ...scope, kind: "text", record_id: "text", version: "text", revision: "bigint", introduced_generation: "bigint", payload: "jsonb", canonical: "bytea", fingerprint: "text", producer_service_id: "text", rule_version: "text", recorded_at: "timestamp with time zone" }, { predecessor_version: "text" }) },
  { name: "seal", columns: columns({ ...scope, seal_id: "text", generation: "bigint", kind: "text", manifest: "jsonb", canonical: "bytea", fingerprint: "text", member_count: "integer", producer_service_id: "text", rule_version: "text", sealed_at: "timestamp with time zone" }) },
  { name: "seal_member", columns: columns({ ...scope, seal_id: "text", ordinal: "integer", kind: "text", record_id: "text", version: "text", fingerprint: "text", introduced_generation: "bigint" }) },
];
const key = (table: string, name: string, type: string, keys: string[], refTable: string | null = null, refKeys: string[] = []) => ({ table, name, type, keys, refTable, refKeys, definition: null as string | null });
const check = (table: string, name: string, definition: string) => ({ table, name, type: "c", keys: [] as string[], refTable: null, refKeys: [] as string[], definition });
export const sourceDraftConstraints = [
  key("collection", "collection_pkey", "p", ["workspace_id", "collection_id"]),
  key("collection", "collection_unit", "u", ["workspace_id", "unit_id"]),
  key("collection", "collection_current", "f", ["workspace_id", "collection_id", "current_seal_id", "generation"], "seal", ["workspace_id", "collection_id", "seal_id", "generation"]),
  key("collection", "collection_final", "f", ["workspace_id", "collection_id", "final_seal_id", "generation"], "seal", ["workspace_id", "collection_id", "seal_id", "generation"]),
  check("collection", "collection_shape", "CHECK (evidence_source_draft.valid_collection(workspace_id, collection_id, unit_id, execution_id, binding, snapshot, generation, head_revision, member_count, history_count, unresolved_count, current_seal_id, final_seal_id))"),
  key("version", "version_pkey", "p", ["workspace_id", "collection_id", "kind", "record_id", "version"]),
  key("version", "version_revision", "u", ["workspace_id", "collection_id", "kind", "record_id", "revision"]),
  key("version", "version_collection", "f", ["workspace_id", "collection_id"], "collection", ["workspace_id", "collection_id"]),
  key("version", "version_previous", "f", ["workspace_id", "collection_id", "kind", "record_id", "predecessor_version"], "version", ["workspace_id", "collection_id", "kind", "record_id", "version"]),
  check("version", "version_shape", "CHECK (evidence_source_draft.valid_version(kind, record_id, version, revision, predecessor_version, introduced_generation, payload, canonical, fingerprint, producer_service_id, rule_version))"),
  key("seal", "seal_pkey", "p", ["workspace_id", "seal_id"]),
  key("seal", "seal_generation", "u", ["workspace_id", "collection_id", "generation"]),
  key("seal", "seal_identity", "u", ["workspace_id", "collection_id", "seal_id", "generation"]),
  key("seal", "seal_collection_identity", "u", ["workspace_id", "collection_id", "seal_id"]),
  key("seal", "seal_collection", "f", ["workspace_id", "collection_id"], "collection", ["workspace_id", "collection_id"]),
  check("seal", "seal_shape", "CHECK (evidence_source_draft.valid_seal(seal_id, generation, kind, manifest, canonical, fingerprint, member_count, producer_service_id, rule_version))"),
  key("seal_member", "seal_member_pkey", "p", ["workspace_id", "seal_id", "ordinal"]),
  key("seal_member", "seal_member_version", "u", ["workspace_id", "seal_id", "collection_id", "kind", "record_id", "version"]),
  key("seal_member", "seal_member_seal", "f", ["workspace_id", "collection_id", "seal_id"], "seal", ["workspace_id", "collection_id", "seal_id"]),
  key("seal_member", "seal_member_source", "f", ["workspace_id", "collection_id", "kind", "record_id", "version"], "version", ["workspace_id", "collection_id", "kind", "record_id", "version"]),
  check("seal_member", "seal_member_shape", "CHECK (evidence_source_draft.valid_member(ordinal, fingerprint, introduced_generation))"),
];
export const sourceDraftIndexes = [
  ...sourceDraftConstraints.filter(item => ["p", "u"].includes(item.type)).map(item => ({ table: item.table, name: item.name, keys: item.keys, unique: true, primary: item.type === "p" })),
  { table: "version", name: "version_enumeration", keys: ["workspace_id", "collection_id", "introduced_generation", "kind", "record_id", "revision"], unique: false, primary: false },
  { table: "version", name: "version_previous_lookup", keys: ["workspace_id", "collection_id", "kind", "record_id", "predecessor_version"], unique: false, primary: false },
  { table: "seal_member", name: "seal_member_source_lookup", keys: ["workspace_id", "collection_id", "kind", "record_id", "version"], unique: false, primary: false },
  { table: "collection", name: "collection_current_lookup", keys: ["workspace_id", "collection_id", "current_seal_id", "generation"], unique: false, primary: false },
  { table: "collection", name: "collection_final_lookup", keys: ["workspace_id", "collection_id", "final_seal_id", "generation"], unique: false, primary: false },
];

export const sourceDraftFunctions = [
  { signature: "valid_id(text)", language: "sql", result: "boolean", volatility: "i", body: "select ($1 is not null and length($1) between 1 and 256 and $1=btrim($1,chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279)) and $1 !~ E'[\\r\\n*?]' and strpos($1,'://')=0)" },
  { signature: "valid_collection(text,text,text,text,jsonb,jsonb,bigint,bigint,integer,integer,integer,text,text)", language: "sql", result: "boolean", volatility: "i", body: "select (evidence_source_draft.valid_id($1) and evidence_source_draft.valid_id($2) and evidence_source_draft.valid_id($3) and evidence_source_draft.valid_id($4) and jsonb_typeof($5)='object' and ($5->>'workspaceId')=$1 and ($5->>'unitId')=$3 and jsonb_typeof($6)='object' and $7 between 1 and 9007199254740991 and $8 between 1 and 9007199254740991 and $9 between 0 and 256 and $10 between 0 and 64 and $11 between 0 and 256 and ($12 is null or evidence_source_draft.valid_id($12)) and ($13 is null or evidence_source_draft.valid_id($13)) and octet_length($5::text)<=2097152 and octet_length($6::text)<=2097152) is true" },
  { signature: "valid_version(text,text,text,bigint,text,bigint,jsonb,bytea,text,text,text)", language: "sql", result: "boolean", volatility: "i", body: "select ($1 in ('task','snapshot','execution','fence','result','validation','pricing','closure') and evidence_source_draft.valid_id($2) and evidence_source_draft.valid_id($3) and $4 between 1 and 9007199254740991 and (($4=1 and $5 is null) or ($4>1 and evidence_source_draft.valid_id($5) and $5<>$3)) and $6 between 1 and 9007199254740991 and jsonb_typeof($7)='object' and octet_length($7::text)<=2097152 and octet_length($8) between 1 and 2097152 and $9 ~ '^[a-f0-9]{64}$' and evidence_source_draft.valid_id($10) and evidence_source_draft.valid_id($11)) is true" },
  { signature: "valid_seal(text,bigint,text,jsonb,bytea,text,integer,text,text)", language: "sql", result: "boolean", volatility: "i", body: "select (evidence_source_draft.valid_id($1) and $2 between 1 and 9007199254740991 and $3 in ('observation','final') and jsonb_typeof($4)='object' and octet_length($4::text)<=2097152 and octet_length($5) between 1 and 1048576 and $6 ~ '^[a-f0-9]{64}$' and $7 between 1 and 256 and evidence_source_draft.valid_id($8) and evidence_source_draft.valid_id($9)) is true" },
  { signature: "valid_member(integer,text,bigint)", language: "sql", result: "boolean", volatility: "i", body: "select ($1 between 0 and 255 and $2 ~ '^[a-f0-9]{64}$' and $3 between 1 and 9007199254740991) is true" },
  { signature: "deny_source_write()", language: "plpgsql", result: "trigger", volatility: "v", body: "begin raise exception 'source draft closed' using errcode='P0001'; end" },
];
