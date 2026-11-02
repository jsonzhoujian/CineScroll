-- Trusted-owner migration. Audit persistence only; formal transition guard stays closed.
create unique index script_revision_request_idx on script_content_versions
(workspace_id,project_id,chapter_id,created_by,(version_json->'revisionOperation'->>'requestId')) where version_json ? 'revisionOperation';
alter table script_content_versions add constraint script_revision_operation_valid check ((not (version_json ? 'revisionOperation') or (
 jsonb_typeof(version_json->'revisionOperation')='object'
 and jsonb_typeof(version_json->'revisionOperation'->'requestId')='string'
 and length(version_json->'revisionOperation'->>'requestId') between 1 and 256
 and version_json->'revisionOperation'->>'fingerprint' ~ '^[0-9a-f]{64}$'
 and version_json->'revisionOperation'->>'kind' in ('suggest','unlock','decide')
 and jsonb_typeof(version_json->'revisionOperation'->'reason')='string'
 and length(version_json->'revisionOperation'->>'reason') between 1 and 2000
)) is true);
