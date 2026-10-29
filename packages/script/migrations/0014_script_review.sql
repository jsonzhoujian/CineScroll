-- Trusted owner only; append-only versions also retain review action/request audit metadata.
create unique index script_content_review_request_idx on script_content_versions
  (workspace_id,project_id,chapter_id,created_by,(version_json->'reviewOperation'->>'requestId'))
  where version_json ? 'reviewOperation';
alter table script_content_versions add constraint script_content_review_operation_valid check ((
  not (version_json ? 'reviewOperation') or (
    jsonb_typeof(version_json->'reviewOperation')='object'
    and version_json->'reviewOperation' ?& array['requestId','fingerprint','kind','targetId','reason']
    and jsonb_typeof(version_json->'reviewOperation'->'requestId')='string'
    and jsonb_typeof(version_json->'reviewOperation'->'fingerprint')='string'
    and jsonb_typeof(version_json->'reviewOperation'->'kind')='string'
    and jsonb_typeof(version_json->'reviewOperation'->'targetId')='string'
    and jsonb_typeof(version_json->'reviewOperation'->'reason')='string'
    and length(version_json->'reviewOperation'->>'requestId') between 1 and 256
    and version_json->'reviewOperation'->>'fingerprint' ~ '^[0-9a-f]{64}$'
    and version_json->'reviewOperation'->>'kind' in ('edit','suggest','decide')
    and length(version_json->'reviewOperation'->>'targetId') between 1 and 256
    and length(version_json->'reviewOperation'->>'reason') between 1 and 2000
  )
) is true);
drop policy script_content_versions_insert on script_content_versions;
create policy script_content_versions_insert on script_content_versions for insert with check (
  workspace_id=current_app_workspace_id() and can_access_project(project_id) and created_by=current_app_user_id()
  and (not (version_json ? 'reviewOperation') or version_json->'reviewOperation'->>'kind'='suggest' or can_review_project(project_id))
);
